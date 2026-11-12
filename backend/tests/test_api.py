from __future__ import annotations

import pytest

from .songs import BPM, write_midi, write_reference_wav


def _create_midi_lesson(client, tmp_path, with_reference: bool = False):
    midi = write_midi(tmp_path / "My Song.mid")
    files = [("midi", ("My Song.mid", midi.read_bytes(), "audio/midi"))]
    if with_reference:
        ref = write_reference_wav(tmp_path / "ref.wav")
        files.append(("audio", ("ref.wav", ref.read_bytes(), "audio/wav")))
    r = client.post("/api/lessons", data={"mode": "materials"}, files=files)
    assert r.status_code == 201, r.text
    return r.json()


def test_health_and_settings(client):
    h = client.get("/api/health").json()
    assert h["ok"] is True and "engines" in h
    assert h["api"] == 2  # the web UI asks to restart an older server (api.ts API_LEVEL)
    s = client.get("/api/settings").json()
    assert s["instrumentId"] == "akai-mpk-mini-mk3"
    s["instrumentId"] = "generic-49"
    s["calibrations"] = {"generic-49": {"keysLowNote": 36}}
    r = client.put("/api/settings", json=s)
    assert r.status_code == 200
    assert client.get("/api/settings").json()["calibrations"]["generic-49"]["keysLowNote"] == 36


def test_midi_lesson_lifecycle(client, tmp_path):
    created = _create_midi_lesson(client, tmp_path)
    lesson = client.get(f"/api/lessons/{created['id']}").json()
    assert lesson["status"] == "ready", lesson.get("error")
    assert lesson["title"] == "My Song"
    assert [p["role"] for p in lesson["parts"]] == ["drums", "bass", "chords", "melody"]
    assert abs(lesson["grid"]["bpm"] - BPM) < 0.01

    listing = client.get("/api/lessons").json()
    assert listing[0]["id"] == lesson["id"] and listing[0]["partCount"] == 4

    pid = lesson["parts"][3]["id"]
    r = client.patch(
        f"/api/lessons/{lesson['id']}",
        json={"title": "Renamed", "parts": [{"id": pid, "role": "vocal"}], "prefs": {"x": 1}},
    )
    assert r.status_code == 200
    patched = r.json()
    assert patched["title"] == "Renamed"
    assert patched["parts"][3]["role"] == "vocal"
    assert patched["prefs"]["x"] == 1

    assert client.delete(f"/api/lessons/{lesson['id']}").status_code == 204
    assert client.get(f"/api/lessons/{lesson['id']}").status_code == 404


def test_reference_audio_and_range_requests(client, tmp_path):
    created = _create_midi_lesson(client, tmp_path, with_reference=True)
    lesson = client.get(f"/api/lessons/{created['id']}").json()
    assert lesson["status"] == "ready", lesson.get("error")
    mix = lesson["media"]["mix"]
    url = f"/api/lessons/{lesson['id']}/media/{mix}"
    full = client.get(url)
    assert full.status_code == 200 and full.headers["content-type"].startswith("audio/ogg")
    part = client.get(url, headers={"Range": "bytes=10-109"})
    assert part.status_code == 206
    assert len(part.content) == 100
    assert part.content == full.content[10:110]

    exp = client.get(f"/api/lessons/{lesson['id']}/export/audio", params={"kind": "mix"})
    assert exp.status_code == 200 and exp.headers["content-type"] == "audio/wav"


def test_stems_lesson_end_to_end(client, tmp_path):
    from .songs import render_stems

    stems = render_stems(tmp_path / "stems")
    files = [("stems", (p.name, p.read_bytes(), "audio/wav")) for p in stems.values()]
    r = client.post("/api/lessons", data={"mode": "materials", "title": "Stems"}, files=files)
    assert r.status_code == 201, r.text
    lesson = client.get(f"/api/lessons/{r.json()['id']}").json()
    assert lesson["status"] == "ready", lesson.get("error")
    assert abs(lesson["grid"]["bpm"] - BPM) < 0.5
    assert lesson["grid"]["origin"] == "tracked"
    roles = {p["role"] for p in lesson["parts"] if not p["silent"]}
    assert roles == {"drums", "bass", "chords", "vocal"}, roles
    for p in lesson["parts"]:
        assert p["origin"] == "transcribed" and p["notes"], p["name"]
        assert p["media"]["stem"] and p["media"]["backing"] and p["media"]["stemWav"]
    assert lesson["media"]["mix"]
    bass = next(p for p in lesson["parts"] if p["role"] == "bass")
    exp = client.get(f"/api/lessons/{lesson['id']}/export/audio", params={"kind": "backing", "part": bass["id"]})
    assert exp.status_code == 200 and exp.content[:4] == b"RIFF"


def test_auto_mode_without_engine_fails_clearly(client, tmp_path):
    from stemtutor.pipeline.separate import demucs_available

    if demucs_available():
        pytest.skip("separation module installed")
    ref = write_reference_wav(tmp_path / "track.wav")
    r = client.post("/api/lessons", data={"mode": "auto"}, files=[("audio", ("track.wav", ref.read_bytes(), "audio/wav"))])
    lesson = client.get(f"/api/lessons/{r.json()['id']}").json()
    assert lesson["status"] == "failed"
    assert "Ableton" in lesson["error"]


def test_validation_errors(client):
    r = client.post("/api/lessons", data={"mode": "materials"})
    assert r.status_code == 400
    r = client.post("/api/lessons", data={"mode": "auto", "url": "ftp://example.com/x"})
    assert r.status_code == 400
    r = client.post(
        "/api/lessons", data={"mode": "materials"},
        files=[("midi", ("x.txt", b"hello", "text/plain"))],
    )
    assert r.status_code == 400
    assert client.get("/api/lessons/../../etc").status_code == 404


def test_path_traversal_is_refused(client, tmp_path):
    created = _create_midi_lesson(client, tmp_path)
    r = client.get(f"/api/lessons/{created['id']}/media/..%2F..%2Fsettings.json")
    assert r.status_code == 404
