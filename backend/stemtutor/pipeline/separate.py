"""Stem separation engines. Demucs is optional (``uv sync --extra separation``).

Without it the app still works with stems made elsewhere (Ableton Live 12.3 Suite
Stem Separation, UVR, Moises…) through the "ready materials" path.

Engine strings: ``auto`` / ``demucs`` (default model) or ``demucs:<model>``.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import socket
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from ..schemas import Role

log = logging.getLogger("stemtutor.separate")

STEM_META: dict[str, tuple[str, Role]] = {
    "drums": ("Drums", "drums"),
    "bass": ("Bass", "bass"),
    "vocals": ("Vocals", "vocal"),
    "other": ("Other", "other"),
    "piano": ("Piano", "chords"),
    "guitar": ("Guitar", "chords"),
}

# Measured on the synthetic test song (RTX 5080): htdemucs_ft gives the cleanest drums and
# bass; htdemucs_6s adds piano/guitar stems but spreads harmony across bleedy stems.
MODELS: dict[str, str] = {
    "htdemucs_ft": "4 стема · точнее (по умолчанию)",
    "htdemucs": "4 стема · быстрее",
    "htdemucs_6s": "6 стемов · + пианино и гитара",
}
DEFAULT_MODEL = "htdemucs_ft"


class SeparationUnavailable(RuntimeError):
    pass


class SeparationFailed(RuntimeError):
    pass


def demucs_available() -> bool:
    return importlib.util.find_spec("demucs") is not None and importlib.util.find_spec("torch") is not None


def model_for_engine(engine: str | None) -> str:
    engine = (engine or "auto").strip()
    if engine in ("auto", "demucs", ""):
        return DEFAULT_MODEL
    if engine.startswith("demucs:"):
        name = engine.split(":", 1)[1]
        if name in MODELS:
            return name
    raise SeparationUnavailable(f"Неизвестный движок разделения: {engine}")


def separate(
    engine: str,
    mix_wav: Path,
    out_dir: Path,
    progress: Callable[..., None] | None = None,
    model_name: str | None = None,
) -> list[tuple[str, Role, Path]]:
    """``progress(fraction)`` or ``progress(fraction, label)``; it may raise to cancel."""
    model = model_name or model_for_engine(engine)
    if not demucs_available():
        raise SeparationUnavailable(
            "Модуль разделения на стемы не установлен. Разделите трек в Ableton Live 12.3 "
            "(Separate Stems), UVR или Moises и создайте урок из готовых стемов — или "
            "установите модуль: закройте StemTutor и запустите start.bat --with-separation."
        )
    return _separate_demucs(mix_wav, out_dir, progress, model)


def _device() -> str:
    import torch

    if not torch.cuda.is_available():
        return "cpu"
    try:  # a GPU the wheel was not built for (e.g. a newer architecture) fails at first kernel
        (torch.ones(8, device="cuda") * 2).sum().item()
        return "cuda"
    except Exception as exc:  # pragma: no cover - hardware specific
        log.warning("CUDA present but unusable (%s); separating on CPU", exc)
        return "cpu"


MAX_MINUTES = 20  # ~0.4 GB of RAM per minute during separation


def _separate_demucs(mix_wav: Path, out_dir: Path, progress, model_name: str) -> list[tuple[str, Role, Path]]:
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("HF_HUB_VERBOSITY", "error")  # no "set HF_TOKEN" nag: public models need none
    try:
        import torch
        from demucs.api import Separator  # demucs >= 4.1
    except (ImportError, OSError) as exc:  # e.g. a torch DLL failing to load on Windows
        raise SeparationUnavailable(
            f"Модуль разделения установлен, но не загружается ({type(exc).__name__}: {exc}). "
            "Закройте StemTutor и запустите start.bat --repair-separation."
        ) from exc

    if sf.info(str(mix_wav)).duration > MAX_MINUTES * 60:
        raise SeparationFailed(
            f"Трек длиннее {MAX_MINUTES} минут — разделите его на части или создайте урок из готовых стемов."
        )
    device = _device()
    data, sr = sf.read(str(mix_wav), dtype="float32", always_2d=True)
    wav = torch.from_numpy(np.ascontiguousarray(data.T))
    del data
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    elif wav.shape[0] > 2:
        wav = wav[:2]
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info("demucs %s on %s (%s)", model_name, device, mix_wav.name)

    labelled = {"done": False}

    def cb(info: dict) -> None:
        # A bag of models (htdemucs_ft = 4) runs the whole track once per model.
        # Progress calls may raise Cancelled (a BaseException): demucs then aborts cleanly.
        if not progress or not info.get("audio_length"):
            return
        models = max(1, int(info.get("models", 1)))
        within = min(1.0, info.get("segment_offset", 0) / info["audio_length"])
        frac = min(0.99, (int(info.get("model_idx_in_bag", 0)) + within) / models)
        if not labelled["done"]:
            labelled["done"] = True
            progress(frac, f"Разделение на стемы · {model_name} · {'GPU' if device == 'cuda' else 'CPU (медленно)'}")
        else:
            progress(frac)

    sep = None
    try:
        # Loading is the only step that downloads (first use of a model): classify by phase.
        if progress:
            progress(0.0, f"Загрузка модели {model_name} (в первый раз скачивается до 320 МБ)…")
        old_timeout = socket.getdefaulttimeout()
        socket.setdefaulttimeout(60)  # the legacy download fallback has no timeout of its own
        try:
            sep = Separator(model=model_name, device=device, progress=False, callback=cb)
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:
            # URLError, SSL, DNS, timeouts and proxy failures are all OSError subclasses.
            hint = (
                ": при первом использовании её нужно скачать из интернета "
                "(проверьте подключение, прокси или антивирус)."
                if isinstance(exc, OSError)
                else "."
            )
            raise SeparationFailed(
                f"Не удалось загрузить модель {model_name}{hint} {type(exc).__name__}: {exc}"
            ) from exc
        finally:
            socket.setdefaulttimeout(old_timeout)
        try:
            # separate_tensor resamples to the model rate and normalises internally.
            _, separated = sep.separate_tensor(wav, sr)
            out_sr = sep.samplerate
        except torch.cuda.OutOfMemoryError as exc:  # pragma: no cover - hardware specific
            raise SeparationFailed(
                "Не хватило видеопамяти для разделения. Закройте другие программы, использующие GPU, и повторите."
            ) from exc
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:
            raise SeparationFailed(f"Ошибка разделения ({model_name}, {device}): {type(exc).__name__}: {exc}") from exc

        stems = {k: v.detach().cpu().numpy().T.astype(np.float32) for k, v in separated.items()}
        del separated
    finally:
        sep = None
        if device == "cuda":
            import gc

            gc.collect()
            torch.cuda.empty_cache()  # give VRAM back to other apps (DaVinci Resolve, games…)

    # Loud masters make stems peak above full scale; one common gain keeps every stem
    # unclipped and the balance between them (backings are their sums) intact.
    peak = max((float(np.max(np.abs(a))) for a in stems.values()), default=0.0)
    gain = 0.999 / peak if peak > 0.999 else 1.0
    results: list[tuple[str, Role, Path]] = []
    order = ["drums", "bass", "other", "vocals", "piano", "guitar"]
    for key in sorted(stems, key=lambda k: order.index(k) if k in order else 99):
        name, role = STEM_META.get(key, (key.title(), "other"))
        path = out_dir / f"{key}.wav"
        sf.write(str(path), stems[key] * gain, out_sr, subtype="PCM_16")
        results.append((name, role, path))
    if progress:
        progress(1.0)
    return results
