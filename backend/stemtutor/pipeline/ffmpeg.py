"""Thin wrappers around the ffmpeg CLI (decode, encode for the browser, mix, align)."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class FfmpegError(RuntimeError):
    pass


def ffmpeg_exe() -> str | None:
    found = os.environ.get("STEMTUTOR_FFMPEG") or shutil.which("ffmpeg")
    if found or os.name != "nt":
        return found
    # winget adds ffmpeg to PATH only for programs started after the install: look where it puts
    # it — a link in WinGet\Links, or (without Developer Mode) the unpacked package itself.
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        return None
    winget = Path(base, "Microsoft", "WinGet")
    link = winget / "Links" / "ffmpeg.exe"
    if link.is_file():
        return str(link)
    found_in_packages = sorted(winget.glob("Packages/Gyan.FFmpeg*/*/bin/ffmpeg.exe"))
    return str(found_in_packages[-1]) if found_in_packages else None


def require_ffmpeg() -> str:
    exe = ffmpeg_exe()
    if not exe:
        raise FfmpegError(
            "Не найден ffmpeg. Установите его (например, `winget install Gyan.FFmpeg`) "
            "и перезапустите StemTutor."
        )
    return exe


def run_ffmpeg(args: list[str], timeout: float = 1800) -> str:
    cmd = [require_ffmpeg(), "-hide_banner", "-nostdin", "-y", *args]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_CREATE_NO_WINDOW,
    )
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-6:])
        raise FfmpegError(f"ffmpeg завершился с ошибкой:\n{tail}")
    return proc.stderr


def probe_duration(path: Path) -> float:
    """Duration in seconds, parsed from ffmpeg's banner (no ffprobe dependency)."""
    cmd = [require_ffmpeg(), "-hide_banner", "-nostdin", "-i", str(path)]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=_CREATE_NO_WINDOW,
    )
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", proc.stderr)
    if not m:
        raise FfmpegError(f"Не удалось прочитать аудиофайл: {path.name}")
    h, mnt, s = m.groups()
    return int(h) * 3600 + int(mnt) * 60 + float(s)


def decode_to_wav(src: Path, dst: Path, sr: int = 44100, channels: int = 2) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(["-i", str(src), "-vn", "-ac", str(channels), "-ar", str(sr), "-c:a", "pcm_s16le", str(dst)])
    return dst


def encode_for_browser(src: Path, dst: Path, bitrate: str = "160k") -> Path:
    """Ogg/Opus: small files with sample-accurate start (pre-skip), plays in Chrome/Edge."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(["-i", str(src), "-vn", "-c:a", "libopus", "-b:a", bitrate, "-vbr", "on", str(dst)])
    return dst


def mix_for_browser(inputs: list[Path], dst: Path, bitrate: str = "160k") -> Path:
    """Sum several files (no level normalisation) and encode for the browser."""
    if not inputs:
        raise FfmpegError("Нечего сводить: нет входных файлов.")
    if len(inputs) == 1:
        return encode_for_browser(inputs[0], dst, bitrate)
    args: list[str] = []
    for p in inputs:
        args += ["-i", str(p)]
    filt = "".join(f"[{i}:a]" for i in range(len(inputs))) + (
        f"amix=inputs={len(inputs)}:normalize=0:dropout_transition=0,alimiter=limit=0.98[m]"
    )
    args += ["-filter_complex", filt, "-map", "[m]", "-c:a", "libopus", "-b:a", bitrate, str(dst)]
    dst.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(args)
    return dst


def mix_to_wav(inputs: list[Path], dst: Path) -> Path:
    if len(inputs) == 1:
        return decode_to_wav(inputs[0], dst)
    args: list[str] = []
    for p in inputs:
        args += ["-i", str(p)]
    filt = "".join(f"[{i}:a]" for i in range(len(inputs))) + (
        f"amix=inputs={len(inputs)}:normalize=0:dropout_transition=0[m]"
    )
    args += ["-filter_complex", filt, "-map", "[m]", "-ar", "44100", "-c:a", "pcm_s16le", str(dst)]
    dst.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(args)
    return dst


def align_to_wav(src: Path, dst: Path, shift_sec: float) -> Path:
    """Write ``src`` as WAV shifted by ``shift_sec``: >0 pads silence at the start, <0 trims."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if shift_sec >= 0:
        ms = int(round(shift_sec * 1000))
        af = f"adelay={ms}:all=1" if ms > 0 else "anull"
        run_ffmpeg(["-i", str(src), "-af", af, "-ar", "44100", "-c:a", "pcm_s16le", str(dst)])
    else:
        run_ffmpeg(["-ss", f"{-shift_sec:.6f}", "-i", str(src), "-ar", "44100", "-c:a", "pcm_s16le", str(dst)])
    return dst
