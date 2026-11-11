"""Small audio helpers on top of soundfile/numpy."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf


def load_mono(path: Path, sr: int | None = None) -> tuple[np.ndarray, int]:
    """Load as float32 mono; resample with soxr (via librosa) only when ``sr`` differs."""
    data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    y = data.mean(axis=1)
    if sr and sr != file_sr:
        import librosa

        y = librosa.resample(y, orig_sr=file_sr, target_sr=sr)
        return y.astype(np.float32), sr
    return y, file_sr


def window_rms_db(path: Path, window_sec: float = 1.0) -> np.ndarray:
    """RMS level (dBFS) of consecutive windows, streamed so long files stay cheap."""
    info = sf.info(str(path))
    block = max(1, int(info.samplerate * window_sec))
    levels: list[float] = []
    for chunk in sf.blocks(str(path), blocksize=block, dtype="float32", always_2d=True):
        if len(chunk) == 0:
            continue
        rms = float(np.sqrt(np.mean(np.square(chunk))))
        levels.append(20 * np.log10(rms + 1e-12))
    return np.asarray(levels, dtype=np.float64)


def is_silent(path: Path, threshold_db: float = -42.0, min_seconds: int = 8) -> bool:
    """A stem is 'silent' when fewer than ``min_seconds`` one-second windows rise above
    ``threshold_db`` (capped at a quarter of the file for very short files).

    Separation leaves faint bleed in empty stems (e.g. guitar in an electronic track), so a
    single loud blip does not count — but a real 10-second piano intro does.
    """
    levels = window_rms_db(path)
    if levels.size == 0:
        return True
    need = max(1, min(min_seconds, int(np.ceil(levels.size * 0.25))))
    return int(np.sum(levels >= threshold_db)) < need
