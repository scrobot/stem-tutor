"""Cancellation, silence detection, error-message hygiene and engine status reporting."""

from __future__ import annotations

import numpy as np
import soundfile as sf

from stemtutor.pipeline.audio import is_silent
from stemtutor.pipeline.fetch import _clean
from stemtutor.pipeline.runner import process_lesson
from stemtutor.server import EngineProbe, _engine_status

from .songs import write_midi

SR = 22050


def _wav(path, segments):
    """segments: list of (seconds, dBFS) tone/noise blocks."""
    rng = np.random.default_rng(1)
    parts = []
    for sec, db in segments:
        n = int(sec * SR)
        amp = 10 ** (db / 20) * np.sqrt(2)
        t = np.arange(n) / SR
        parts.append((amp * np.sin(2 * np.pi * 220 * t) + 1e-4 * rng.standard_normal(n)).astype(np.float32))
    sf.write(str(path), np.concatenate(parts), SR)
    return path


def test_short_real_part_is_not_silent(tmp_path):
    intro = _wav(tmp_path / "piano.wav", [(10, -20), (50, -70)])  # a 10 s intro, then bleed
    blip = _wav(tmp_path / "guitar.wav", [(1, -20), (59, -70)])  # a single loud second
    empty = _wav(tmp_path / "vocals.wav", [(60, -70)])
    assert not is_silent(intro)
    assert is_silent(blip)
    assert is_silent(empty)


def test_cancelled_lesson_is_marked(client, tmp_path):
    midi = write_midi(tmp_path / "x.mid")
    r = client.post("/api/lessons", data={"mode": "materials"}, files=[("midi", ("x.mid", midi.read_bytes(), "audio/midi"))])
    lid = r.json()["id"]
    app = client.app
    process_lesson(app.state.repo, app.state.cfg, lid, cancelled=lambda: True)
    lesson = client.get(f"/api/lessons/{lid}").json()
    assert lesson["status"] == "failed" and lesson["error"] == "Обработка отменена."
    # Nothing is running now: cancel is refused, delete works.
    assert client.post(f"/api/lessons/{lid}/cancel").status_code == 409
    assert client.delete(f"/api/lessons/{lid}").status_code == 204


def test_ytdlp_messages_are_clean():
    raw = "\x1b[0;31mERROR:\x1b[0m [youtube] abc: Video unavailable"
    assert _clean(raw) == "[youtube] abc: Video unavailable"


def test_engine_status_reports_probe_results(monkeypatch):
    # Both branches, whether or not the optional separation module is installed here.
    import stemtutor.pipeline.separate as separate

    p = EngineProbe()
    monkeypatch.setattr(separate, "demucs_available", lambda: False)
    st = _engine_status(p)["demucs"]
    assert st["available"] is False and "start.bat --with-separation" in st["hint"]

    monkeypatch.setattr(separate, "demucs_available", lambda: True)
    p.state, p.error = "error", "OSError: [WinError 126] c10.dll"
    st = _engine_status(p)["demucs"]
    assert st["available"] is False and "c10.dll" in st["hint"]
    assert "--repair-separation" in st["hint"]
    p.state, p.device, p.error = "ok", "cpu", None
    st = _engine_status(p)["demucs"]
    assert st["available"] is True and "процессоре" in st["hint"]
    p.device = "cuda"
    assert _engine_status(p)["demucs"]["hint"] is None
