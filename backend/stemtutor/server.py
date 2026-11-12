"""HTTP API + static web UI."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, learned, producer
from .config import AppConfig, load_config
from .gridmath import export_origin
from .jobs import JobRunner, reset_for_run
from .pipeline import ffmpeg
from .schemas import AiSettingsPatch, Lesson, LessonPatch, LessonSummary, ProducerRequest, Settings, SourceInfo
from .storage import LessonRepo, NotFound, SettingsStore, safe_filename, slugify

# What this server can do, reported by /api/health: the web UI (api.ts API_LEVEL) asks the user to
# restart an older server. 2: the cover plan and the AI producer.
API_LEVEL = 2

MEDIA_TYPES = {
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".mid": "audio/midi",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}

AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".aif", ".aiff", ".webm", ".wma"}
MIDI_EXT = {".mid", ".midi", ".kar", ".rmi"}


class EngineProbe:
    """Checks once, in a child process, that torch + demucs really import and which device
    they get. A broken install (missing DLL, half-finished download) or a GPU the CUDA build
    cannot use then shows up in the UI before a lesson fails half-way."""

    def __init__(self) -> None:
        self.state = "pending"  # pending | ok | error | absent
        self.device: str | None = None
        self.error: str | None = None

    def run(self) -> None:
        from .pipeline.separate import demucs_available

        if not demucs_available():
            self.state = "absent"
            return
        code = "import demucs.api; from stemtutor.pipeline.separate import _device; print(_device())"
        try:
            proc = subprocess.run(
                [sys.executable, "-c", code], capture_output=True, text=True, timeout=300,
                encoding="utf-8", errors="replace", creationflags=0x08000000 if os.name == "nt" else 0,
                env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},  # localized WinError text
            )
        except Exception as exc:  # pragma: no cover - environment specific
            self.state, self.error = "error", f"{type(exc).__name__}: {exc}"
            return
        out = proc.stdout.strip().splitlines()
        if proc.returncode == 0 and out and out[-1] in ("cuda", "cpu"):
            self.state, self.device = "ok", out[-1]
        else:
            lines = [ln for ln in proc.stderr.strip().splitlines() if ln.strip()]
            self.state, self.error = "error", (lines[-1] if lines else f"код {proc.returncode}")[:300]


def _engine_status(probe: EngineProbe) -> dict:
    from .pipeline.separate import DEFAULT_MODEL, MODELS, demucs_available

    installed = demucs_available()
    available = installed and probe.state != "error"
    if not installed:
        hint = "Модуль разделения не установлен: закройте StemTutor и запустите start.bat --with-separation."
    elif probe.state == "error":
        hint = (
            f"Модуль разделения установлен, но не загружается: {probe.error}. "
            "Закройте StemTutor и запустите start.bat --repair-separation."
        )
    elif probe.device == "cpu":
        hint = "Видеокарта не используется — разделение пойдёт на процессоре и займёт в разы больше времени."
    else:
        hint = None
    return {
        "demucs": {
            "available": available,
            "state": probe.state,
            "device": probe.device,
            "hint": hint,
            "models": [{"id": k, "label": v} for k, v in MODELS.items()],
            "default": DEFAULT_MODEL,
        }
    }


LOCAL_NAMES = {"127.0.0.1", "localhost", "::1"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _host_name(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("["):  # [::1]:8765
        return value[1 : value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _foreign_request(scope: dict) -> str | None:
    """Why a request must be refused, or None. The API has no password, so only this
    computer's own StemTutor pages may use it: a web page elsewhere could otherwise reach
    127.0.0.1 through the user's browser (cross-site requests) or through a domain that
    resolves to 127.0.0.1 (DNS rebinding)."""
    headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
    if _host_name(headers.get("host", "")) not in LOCAL_NAMES:
        return "StemTutor открывается только на этом компьютере: http://127.0.0.1"
    origin = headers.get("origin")
    if origin and scope.get("method", "GET") not in SAFE_METHODS:
        if (urlsplit(origin).hostname or "").lower() not in LOCAL_NAMES:
            return "Запрос с чужой страницы отклонён."
    if (
        scope.get("path", "").startswith("/api/")
        and headers.get("sec-fetch-site") == "cross-site"
        and headers.get("sec-fetch-mode") != "navigate"
    ):
        return "Запрос с чужой страницы отклонён."
    return None


class LocalOnly:
    """ASGI middleware applying _foreign_request (plain ASGI: leaves file streaming alone)."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            reason = _foreign_request(scope)
            if reason:
                await JSONResponse({"detail": reason}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(cfg: AppConfig | None = None, synchronous_jobs: bool = False) -> FastAPI:
    cfg = cfg or load_config()
    repo = LessonRepo(cfg.lessons_dir)
    settings = SettingsStore(cfg.settings_file)
    runner = JobRunner(repo, cfg, synchronous=synchronous_jobs)
    probe = EngineProbe()
    ai = producer.AiStore(cfg.ai_file)
    ai_models = producer.ModelsCache()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        threading.Thread(target=probe.run, name="stemtutor-engine-probe", daemon=True).start()
        runner.start()
        runner.resume_pending()
        yield

    app = FastAPI(title="StemTutor", version=__version__, lifespan=lifespan)
    app.add_middleware(LocalOnly)
    app.state.repo = repo
    app.state.runner = runner
    app.state.cfg = cfg

    @app.exception_handler(producer.ProducerError)
    async def producer_error(_request, exc: producer.ProducerError) -> JSONResponse:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)

    def get_lesson(lesson_id: str) -> Lesson:
        try:
            return repo.get(lesson_id)
        except NotFound:
            raise HTTPException(404, "Урок не найден")

    # -- health & settings ---------------------------------------------------------------
    @app.get("/api/health")
    def health() -> dict:
        return {
            "ok": True,
            "version": __version__,
            "api": API_LEVEL,
            "ffmpeg": ffmpeg.ffmpeg_exe() is not None,
            "engines": _engine_status(probe),
            "dataDir": str(cfg.data_dir),
            "processing": runner.current,
        }

    @app.get("/api/settings", response_model=Settings)
    def get_settings() -> Settings:
        return settings.get()

    @app.put("/api/settings", response_model=Settings)
    def put_settings(body: Settings) -> Settings:
        return settings.put(body)

    # -- lessons -------------------------------------------------------------------------
    @app.get("/api/lessons", response_model=list[LessonSummary])
    def list_lessons() -> list[LessonSummary]:
        return [LessonSummary.of(lesson) for lesson in repo.list()]

    @app.post("/api/lessons", response_model=Lesson, status_code=201)
    async def create_lesson(
        mode: Literal["auto", "materials"] = Form(...),
        title: str = Form(""),
        url: str = Form(""),
        engine: str = Form("auto"),
        audio: Optional[UploadFile] = File(None),
        midi: Optional[UploadFile] = File(None),
        stems: Optional[list[UploadFile]] = File(None),
    ) -> Lesson:
        url = url.strip()
        stems = [s for s in (stems or []) if s and s.filename]
        audio = audio if audio and audio.filename else None
        midi = midi if midi and midi.filename else None
        if url and not url.lower().startswith(("http://", "https://")):
            raise HTTPException(400, "Ссылка должна начинаться с http:// или https://")
        if mode == "auto":
            if not url and not audio:
                raise HTTPException(400, "Укажите ссылку на трек или загрузите аудиофайл.")
            from .pipeline.separate import SeparationUnavailable, model_for_engine

            try:
                model_for_engine(engine)
            except SeparationUnavailable as exc:
                raise HTTPException(400, str(exc))
            kind = "audio"
        else:
            if not midi and not stems:
                raise HTTPException(400, "Добавьте MIDI-файл и/или стемы.")
            kind = "midi" if midi else "stems"
        if midi and Path(midi.filename).suffix.lower() not in MIDI_EXT:
            raise HTTPException(400, f"Это не MIDI-файл: {midi.filename}")
        for f in [*stems, *([audio] if audio else [])]:
            if Path(f.filename).suffix.lower() not in AUDIO_EXT:
                raise HTTPException(400, f"Неподдерживаемый аудиоформат: {f.filename}")

        auto_title = not title.strip()
        guess = title.strip() or (
            Path(midi.filename).stem if midi else Path(audio.filename).stem if audio
            else Path(stems[0].filename).stem if stems and not url else "Новый урок"
        )
        lesson_id = repo.new_id(guess)
        source = SourceInfo(kind=kind, url=url or None, engine=engine if kind == "audio" else None)
        lesson = Lesson(id=lesson_id, title=guess[:120], source=source, prefs={"autoTitle": auto_title})
        repo.create(lesson)
        src_dir = repo.lesson_dir(lesson_id) / "source"

        def store(upload: UploadFile, prefix: str) -> str:
            name = f"{prefix}{safe_filename(upload.filename or 'file')}"
            dst = src_dir / name
            with dst.open("wb") as fh:
                shutil.copyfileobj(upload.file, fh, length=1024 * 1024)
            return f"source/{name}"

        if midi:
            lesson.source.midiFile = store(midi, "midi_")
        if audio:
            lesson.source.audioFile = store(audio, "track_")
        for i, s in enumerate(stems):
            lesson.source.stemFiles.append(store(s, f"stem{i}_"))
        repo.save(lesson)
        runner.submit(lesson_id)
        return get_lesson(lesson_id)

    @app.get("/api/lessons/{lesson_id}", response_model=Lesson)
    def read_lesson(lesson_id: str) -> Lesson:
        return get_lesson(lesson_id)

    @app.patch("/api/lessons/{lesson_id}", response_model=Lesson)
    def patch_lesson(lesson_id: str, body: LessonPatch) -> Lesson:
        get_lesson(lesson_id)

        def apply(lesson: Lesson) -> None:
            if body.title is not None and body.title.strip():
                lesson.title = body.title.strip()[:120]
                lesson.prefs["autoTitle"] = False
            if body.artist is not None:
                lesson.artist = body.artist.strip() or None
            if body.grid is not None:
                lesson.grid = body.grid
            if body.parts:
                by_id = {p.id: p for p in lesson.parts}
                for patch in body.parts:
                    part = by_id.get(patch.id)
                    if not part:
                        continue
                    if patch.name is not None and patch.name.strip():
                        part.name = patch.name.strip()[:80]
                    if patch.role is not None:
                        part.role = patch.role
                        part.isDrum = patch.role == "drums"
            if body.prefs is not None:
                lesson.prefs.update(body.prefs)

        return repo.update(lesson_id, apply)

    @app.delete("/api/lessons/{lesson_id}", status_code=204)
    def delete_lesson(lesson_id: str) -> None:
        if runner.is_busy(lesson_id):
            runner.cancel(lesson_id)  # a queued lesson is dropped at once, a running one stops shortly
            if runner.is_busy(lesson_id):
                raise HTTPException(409, "Урок обрабатывается — обработка отменяется, удалите его через пару секунд.")
        try:
            repo.delete(lesson_id)
        except NotFound:
            raise HTTPException(404, "Урок не найден")

    @app.post("/api/lessons/{lesson_id}/cancel", status_code=202)
    def cancel_lesson(lesson_id: str) -> dict:
        get_lesson(lesson_id)
        if not runner.cancel(lesson_id):
            raise HTTPException(409, "Урок сейчас не обрабатывается.")
        return {"ok": True}

    @app.post("/api/lessons/{lesson_id}/retry", response_model=Lesson)
    def retry_lesson(lesson_id: str) -> Lesson:
        lesson = get_lesson(lesson_id)
        if lesson.status not in ("failed", "ready"):
            raise HTTPException(409, "Урок уже в обработке.")

        repo.update(lesson_id, reset_for_run)
        runner.submit(lesson_id)
        return get_lesson(lesson_id)

    @app.get("/api/lessons/{lesson_id}/media/{rel_path:path}")
    def lesson_media(lesson_id: str, rel_path: str):
        try:
            path = repo.resolve_file(lesson_id, rel_path)
        except NotFound:
            raise HTTPException(404, "Файл не найден")
        return FileResponse(path, media_type=MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"))

    @app.get("/api/lessons/{lesson_id}/export/audio")
    def export_audio(lesson_id: str, kind: Literal["stem", "backing", "mix"] = "mix", part: str = ""):
        """Lossless WAV shifted so that it starts on a DAW bar line (see gridmath)."""
        lesson = get_lesson(lesson_id)
        if not lesson.grid:
            raise HTTPException(409, "У урока нет сетки долей.")
        ldir = repo.lesson_dir(lesson_id)
        sources: list[Path] = []
        target = next((p for p in lesson.parts if p.id == part), None)
        if kind in ("stem", "backing") and target is None:
            raise HTTPException(404, "Партия не найдена")
        if kind == "stem":
            if not target.media.stemWav:
                raise HTTPException(404, "У этой партии нет аудио.")
            sources = [ldir / target.media.stemWav]
        elif kind == "backing":
            # Same composition as the in-app backing: every other stem with audio, including
            # quiet ones and parts without recognised notes.
            sources = [ldir / p.media.stemWav for p in lesson.parts if p.id != part and p.media.stemWav]
            if not sources:
                raise HTTPException(404, "Нет других партий с аудио.")
        else:
            mix = lesson.media.get("mixWav")
            if mix:
                sources = [ldir / mix]
            else:
                sources = [ldir / p.media.stemWav for p in lesson.parts if p.media.stemWav]
            if not sources:
                raise HTTPException(404, "У урока нет аудио.")
        origin_beat, origin_time = export_origin(lesson.grid)
        key = hashlib.sha1(
            f"{kind}|{part}|{origin_time:.6f}|{'|'.join(map(str, sources))}".encode()
        ).hexdigest()[:10]
        label = slugify(f"{lesson.title}-{target.name if target else 'mix'}-{kind}", "export")
        out = ldir / "export" / f"{label}-{key}.wav"
        if not out.is_file():
            tmp_mix = ldir / "export" / f"tmp-{key}.wav"
            src = sources[0] if len(sources) == 1 else ffmpeg.mix_to_wav(sources, tmp_mix)
            ffmpeg.align_to_wav(src, out, -origin_time)
            tmp_mix.unlink(missing_ok=True)
        return FileResponse(out, media_type="audio/wav", filename=out.name)

    # -- AI producer (the user's own OpenRouter key) --------------------------------------
    @app.get("/api/ai")
    def get_ai() -> dict:
        """Whether a key is saved: a masked hint only, the key itself never leaves the backend."""
        return producer.public_settings(ai.get())

    @app.put("/api/ai")
    def put_ai(body: AiSettingsPatch) -> dict:
        """Absent fields stay as they are; null or "" clears a field."""
        changes: dict[str, str | None] = {}
        if "key" in body.model_fields_set:
            changes["key"] = producer.clean_key(body.key)
        if "model" in body.model_fields_set:
            changes["model"] = producer.clean_model(body.model)
        saved = ai.update(**changes)
        if "key" in changes:
            ai_models.clear()
        return producer.public_settings(saved)

    @app.get("/api/ai/check")
    def check_ai() -> dict:
        """Ask OpenRouter about the saved key (label, credit left)."""
        return producer.check_key(ai.get().key)

    @app.get("/api/ai/models")
    def list_ai_models() -> dict:
        """Models that can answer by a JSON schema (cached for 10 minutes)."""
        return {"models": ai_models.get(ai.get().key)}

    @app.get("/api/lessons/{lesson_id}/cover/producer")
    def read_producer(lesson_id: str) -> dict:
        get_lesson(lesson_id)
        answer = producer.load_answer(repo, lesson_id)
        if answer is None:
            raise HTTPException(404, "ИИ-план ещё не составлен.")
        return answer

    @app.post("/api/lessons/{lesson_id}/cover/producer")
    def ask_producer(lesson_id: str, body: ProducerRequest) -> dict:
        """Ask the user's model to refine the cover plan; the sanitized answer is saved."""
        lesson = get_lesson(lesson_id)
        return producer.ask(repo, lesson, ai.get(), body)

    @app.delete("/api/lessons/{lesson_id}/cover/producer", status_code=204)
    def delete_producer(lesson_id: str) -> None:
        get_lesson(lesson_id)
        producer.delete_answer(repo, lesson_id)

    def save_learned(lesson_id: str, raw: bytes) -> dict:
        get_lesson(lesson_id)
        try:
            mark = learned.clean_mark(json.loads(raw)) if raw else None
        except (ValueError, RecursionError):  # not JSON (or not UTF-8)
            mark = None
        if mark is None:
            raise HTTPException(400, learned.BAD_MARK)

        def apply(lesson: Lesson) -> None:
            lesson.prefs["coverLearned"] = learned.merge(lesson.prefs.get("coverLearned"), mark)

        try:
            lesson = repo.update(lesson_id, apply)
        except NotFound:
            raise HTTPException(404, "Урок не найден")
        return {"coverLearned": lesson.prefs["coverLearned"]}

    @app.post("/api/lessons/{lesson_id}/cover/learned")
    async def mark_learned(lesson_id: str, request: Request) -> dict:
        """One "learned" mark from the trainer, merged under the storage lock (several tabs may
        be open). The body is checked by hand, so a bad mark is a plain 400, never a 422."""
        return await run_in_threadpool(save_learned, lesson_id, await request.body())

    # -- web UI --------------------------------------------------------------------------
    dist = cfg.frontend_dist
    if (dist / "index.html").is_file():
        if (dist / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str):
            if full_path.startswith("api/"):
                return JSONResponse({"detail": "Not Found"}, status_code=404)
            candidate = (dist / full_path).resolve()
            if full_path and candidate.is_file() and dist.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})
    else:

        @app.get("/", include_in_schema=False)
        def no_ui() -> HTMLResponse:
            return HTMLResponse(
                "<h1>StemTutor API</h1><p>Веб-интерфейс не собран: выполните "
                "<code>npm ci && npm run build</code> в папке <code>frontend</code>.</p>"
            )

    return app
