"""Download a track by URL with yt-dlp (YouTube, SoundCloud, Bandcamp, direct links…)."""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .ffmpeg import ffmpeg_exe


class FetchError(RuntimeError):
    pass


MAX_SECONDS = 20 * 60
MAX_BYTES = 400 * 1024 * 1024
# '<=?' lets entries with an unknown duration through (direct links); live broadcasts have no
# duration either and would download forever, so they are filtered out explicitly.
DURATION_FILTER = f"duration <=? {MAX_SECONDS} & !is_live"
TOO_BIG = f"Файл по ссылке больше {MAX_BYTES // 2**20} МБ — возьмите ссылку на сам трек."
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _clean(msg: str) -> str:
    """yt-dlp messages without colour codes and the leading 'ERROR:'."""
    msg = _ANSI.sub("", msg)
    return re.sub(r"^\s*ERROR:\s*", "", msg).strip()


class _Log:
    """yt-dlp's own messages (quiet otherwise): remembered to explain why nothing was saved."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def debug(self, msg: str) -> None:
        self.lines.append(str(msg))

    info = warning = error = debug

    def saw(self, text: str) -> bool:
        return any(text in line for line in self.lines)


@dataclass
class FetchResult:
    path: Path
    title: str | None
    artist: str | None
    duration: float | None
    thumbnail: Path | None


def _js_runtimes() -> dict:
    """YouTube needs a JS runtime for signature challenges. yt-dlp runs Deno and Node in a
    sandbox (no file or process access); Bun has none, so it is never used."""
    out: dict = {}
    for name in ("deno", "node"):
        exe = shutil.which(name)
        if exe:
            out[name] = {"path": exe}
    return out


def fetch_audio(url: str, out_dir: Path, progress: Callable[[float], None] | None = None) -> FetchResult:
    import yt_dlp

    out_dir.mkdir(parents=True, exist_ok=True)

    def hook(d: dict) -> None:
        if d.get("status") != "downloading":
            return
        done = d.get("downloaded_bytes") or 0
        if done > MAX_BYTES:  # yt-dlp's max_filesize only knows an announced size
            raise FetchError(TOO_BIG)
        if progress:
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            # Called even when the size is unknown: a cancel is noticed in progress().
            progress(min(0.99, done / total) if total else 0.0)

    log = _Log()

    opts: dict = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "track.%(ext)s"),
        "noplaylist": True,
        "playlist_items": "1",  # a playlist/album link: take its first track only
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "color": {"stdout": "no_color", "stderr": "no_color"},  # no ANSI codes in lesson.error
        "progress_hooks": [hook],
        "writethumbnail": True,
        "restrictfilenames": True,
        "max_filesize": MAX_BYTES,
        "match_filter": yt_dlp.utils.match_filter_func(DURATION_FILTER),
        "logger": log,
        "retries": 3,
    }
    ff = ffmpeg_exe()
    if ff:
        opts["ffmpeg_location"] = ff
        opts["postprocessors"] = [{"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"}]
    runtimes = _js_runtimes()
    if runtimes:
        opts["js_runtimes"] = runtimes
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except FetchError:
        raise
    except Exception as exc:  # yt-dlp raises DownloadError with a readable message
        raise FetchError(f"Не удалось скачать трек: {_clean(str(exc))}") from exc
    if info is None:
        raise FetchError("Не удалось скачать трек: пустой ответ.")
    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        if not entries:
            raise FetchError(
                f"По ссылке нет доступных треков: плейлист пуст или скрыт, либо его первый трек длиннее "
                f"{MAX_SECONDS // 60} минут."
            )
        info = entries[0]
    if info.get("is_live"):
        raise FetchError("Это прямая трансляция — нужна ссылка на запись трека.")
    if (info.get("duration") or 0) > MAX_SECONDS:
        raise FetchError(
            f"Трек длиннее {MAX_SECONDS // 60} минут ({int(info['duration']) // 60} мин) — возьмите отдельный трек, "
            "а не микс или альбом целиком."
        )

    path: Path | None = None
    for d in info.get("requested_downloads") or []:
        fp = d.get("filepath") or d.get("_filename")
        if fp and Path(fp).is_file():
            path = Path(fp)
            break
    if path is None:
        candidates = [p for p in out_dir.glob("track.*") if p.suffix.lower() not in (".jpg", ".webp", ".png", ".part")]
        if candidates:
            path = max(candidates, key=lambda p: p.stat().st_size)
    if path is None:
        if log.saw("larger than max-filesize"):
            raise FetchError(TOO_BIG)
        raise FetchError("По ссылке не удалось получить аудиофайл.")
    thumb = next((p for p in (out_dir / "track.jpg", out_dir / "track.webp", out_dir / "track.png") if p.is_file()), None)
    title = info.get("track") or info.get("title")
    artist = info.get("artist") or info.get("creator") or info.get("uploader")
    return FetchResult(path=path, title=title, artist=artist, duration=info.get("duration"), thumbnail=thumb)
