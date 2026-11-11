"""Separation engine selection, grid/kick alignment, peak picking, and the full auto path."""

from __future__ import annotations

import numpy as np
import pytest

from stemtutor.pipeline import ffmpeg
from stemtutor.pipeline.analyze import align_grid_to_hits
from stemtutor.pipeline.drums import _pick
from stemtutor.pipeline.separate import DEFAULT_MODEL, SeparationUnavailable, demucs_available, model_for_engine
from stemtutor.schemas import Grid

from .songs import BEAT, BPM, render_stems


def test_engine_strings_map_to_models():
    assert model_for_engine("auto") == DEFAULT_MODEL
    assert model_for_engine(None) == DEFAULT_MODEL
    assert model_for_engine("demucs") == DEFAULT_MODEL
    assert model_for_engine("demucs:htdemucs_6s") == "htdemucs_6s"
    with pytest.raises(SeparationUnavailable):
        model_for_engine("demucs:not-a-model")
    with pytest.raises(SeparationUnavailable):
        model_for_engine("spleeter")


def test_unknown_engine_is_rejected_by_api(client):
    r = client.post("/api/lessons", data={"mode": "auto", "url": "https://example.com/a.mp3", "engine": "demucs:nope"})
    assert r.status_code == 400


def test_health_lists_models(client):
    eng = client.get("/api/health").json()["engines"]["demucs"]
    assert eng["default"] == DEFAULT_MODEL
    assert {m["id"] for m in eng["models"]} >= {"htdemucs_ft", "htdemucs", "htdemucs_6s"}


def test_grid_aligns_to_kicks():
    beats = [0.5 * i - 0.015 for i in range(64)]  # a tracked grid 15 ms early
    grid = Grid(beats=beats, bpm=120, origin="tracked")
    kicks = [0.5 * i for i in range(32)] + [0.25 + 0.5 * i for i in range(8)]  # on-beat + off-beat kicks
    g = align_grid_to_hits(grid, kicks)
    assert g is not None
    assert abs(g.beats[10] - 5.0) < 1e-6
    assert align_grid_to_hits(g, kicks) is None  # already aligned
    assert align_grid_to_hits(grid.model_copy(update={"origin": "midi"}), kicks) is None  # MIDI grids are exact
    assert align_grid_to_hits(grid, kicks[:5]) is None  # too little evidence


def test_peak_picking_keeps_the_strongest_hit():
    # A weak pre-echo 5 frames (~30 ms) before a strong attack must not hide the attack.
    flux = np.zeros(200)
    flux[52], flux[57] = 0.6, 1.0
    flux[150] = 1.0
    picked = _pick(flux, 0.3, wait_frames=6).tolist()
    assert 57 in picked and 52 not in picked and 150 in picked


@pytest.mark.skipif(not demucs_available(), reason="separation module not installed")
def test_auto_lesson_with_demucs(client, tmp_path):
    stems = render_stems(tmp_path / "stems")
    mix = ffmpeg.mix_to_wav(list(stems.values()), tmp_path / "song.wav")
    r = client.post(
        "/api/lessons",
        data={"mode": "auto", "engine": "demucs:htdemucs"},
        files=[("audio", ("song.wav", mix.read_bytes(), "audio/wav"))],
    )
    assert r.status_code == 201, r.text
    lesson = client.get(f"/api/lessons/{r.json()['id']}").json()
    assert lesson["status"] == "ready", lesson.get("error")
    assert abs(lesson["grid"]["bpm"] - BPM) < 0.5
    g = lesson["grid"]
    downbeat = g["beats"][g["firstDownbeat"]]
    bar = 4 * BEAT
    assert min(downbeat % bar, bar - downbeat % bar) < 0.03
    roles = {p["role"] for p in lesson["parts"] if not p["silent"]}
    assert {"drums", "bass"} <= roles
    drums = next(p for p in lesson["parts"] if p["role"] == "drums")
    kicks = [n["s"] for n in drums["notes"] if n["p"] == 36]
    assert len(kicks) >= 28
