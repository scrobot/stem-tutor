"""File-system storage for lessons and settings.

Layout::

    data/
      settings.json
      lessons/<id>/lesson.json
      lessons/<id>/source/...   uploaded or downloaded inputs
      lessons/<id>/work/...     intermediate WAVs (stems, mix)
      lessons/<id>/media/...    files served to the browser (mp3)
      lessons/<id>/export/...   generated downloads (aligned WAV)

All reads and writes go through one process-wide lock: on Windows ``os.replace`` fails
while another handle has the target open, so readers and writers must not overlap.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import threading
from pathlib import Path
from typing import Callable

from .schemas import Lesson, Settings, now_iso

_LOCK = threading.RLock()
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")


class NotFound(KeyError):
    pass


def _atomic_write_text(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def slugify(text: str, fallback: str = "lesson") -> str:
    translit = str.maketrans(
        {
            "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
            "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
            "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
            "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
            "я": "ya",
        }
    )
    s = text.lower().translate(translit)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return (s[:40].strip("-") or fallback)


def safe_filename(name: str) -> str:
    base = os.path.basename(name or "file")
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"[^\w\-. ()\[\]]+", "_", stem, flags=re.UNICODE).strip(" .") or "file"
    ext = re.sub(r"[^\w.]+", "", ext)[:10]
    return f"{stem[:80]}{ext}"


class LessonRepo:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    # -- paths -------------------------------------------------------------------------
    def lesson_dir(self, lesson_id: str) -> Path:
        if not _ID_RE.match(lesson_id):
            raise NotFound(lesson_id)
        return self.root / lesson_id

    def _json_path(self, lesson_id: str) -> Path:
        return self.lesson_dir(lesson_id) / "lesson.json"

    def resolve_file(self, lesson_id: str, rel: str) -> Path:
        """Resolve a lesson-relative path, refusing anything outside the lesson folder."""
        base = self.lesson_dir(lesson_id).resolve()
        target = (base / rel).resolve()
        if base not in target.parents and target != base:
            raise NotFound(rel)
        if not target.is_file():
            raise NotFound(rel)
        return target

    # -- CRUD --------------------------------------------------------------------------
    def new_id(self, title: str) -> str:
        return f"{slugify(title)}-{secrets.token_hex(3)}"

    def create(self, lesson: Lesson) -> Lesson:
        with _LOCK:
            d = self.lesson_dir(lesson.id)
            for sub in ("source", "work", "media", "export"):
                (d / sub).mkdir(parents=True, exist_ok=True)
            self._write(lesson)
            return lesson

    def _write(self, lesson: Lesson) -> None:
        lesson.updatedAt = now_iso()
        _atomic_write_text(self._json_path(lesson.id), lesson.model_dump_json())

    def save(self, lesson: Lesson) -> Lesson:
        with _LOCK:
            if not self._json_path(lesson.id).exists():
                raise NotFound(lesson.id)
            self._write(lesson)
            return lesson

    def get(self, lesson_id: str) -> Lesson:
        with _LOCK:
            path = self._json_path(lesson_id)
            if not path.is_file():
                raise NotFound(lesson_id)
            return Lesson.model_validate_json(path.read_text(encoding="utf-8"))

    def update(self, lesson_id: str, fn: Callable[[Lesson], None]) -> Lesson:
        with _LOCK:
            lesson = self.get(lesson_id)
            fn(lesson)
            self._write(lesson)
            return lesson

    def list(self) -> list[Lesson]:
        out: list[Lesson] = []
        with _LOCK:
            for d in self.root.iterdir():
                p = d / "lesson.json"
                if d.is_dir() and p.is_file():
                    try:
                        out.append(Lesson.model_validate_json(p.read_text(encoding="utf-8")))
                    except Exception:  # a broken lesson must not hide the others
                        continue
        out.sort(key=lambda lesson: lesson.createdAt, reverse=True)
        return out

    def delete(self, lesson_id: str) -> None:
        with _LOCK:
            d = self.lesson_dir(lesson_id)
            if not d.exists():
                raise NotFound(lesson_id)
            shutil.rmtree(d)


class SettingsStore:
    def __init__(self, path: Path):
        self.path = path

    def get(self) -> Settings:
        with _LOCK:
            if not self.path.is_file():
                return Settings()
            try:
                return Settings.model_validate(json.loads(self.path.read_text(encoding="utf-8")))
            except Exception:
                return Settings()

    def put(self, settings: Settings) -> Settings:
        with _LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_text(self.path, settings.model_dump_json(indent=2))
            return settings
