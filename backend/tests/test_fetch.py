"""The yt-dlp download path, offline: a direct WAV link served from 127.0.0.1."""

from __future__ import annotations

import functools
import http.server
import threading
import time

import numpy as np
import pytest
import soundfile as sf
import yt_dlp

from stemtutor.pipeline import fetch as fetch_mod
from stemtutor.pipeline.cancel import Cancelled
from stemtutor.pipeline.fetch import DURATION_FILTER, MAX_SECONDS, FetchError, fetch_audio

from .songs import write_midi


def test_duration_filter_accepts_short_and_unknown_and_rejects_long():
    accept = yt_dlp.utils.match_filter_func(DURATION_FILTER)
    assert accept({"id": "a", "title": "a", "duration": 100}) is None
    assert accept({"id": "b", "title": "b"}) is None  # direct links often report no duration
    assert accept({"id": "c", "title": "c", "duration": MAX_SECONDS + 1}) is not None
    assert accept({"id": "d", "title": "d", "is_live": True}) is not None  # would never end
    assert accept({"id": "e", "title": "e", "is_live": False, "duration": 100}) is None


@pytest.fixture()
def wav_url(tmp_path):
    serve = tmp_path / "serve"
    serve.mkdir()
    sr = 22050
    t = np.arange(2 * sr) / sr
    sf.write(str(serve / "tone.wav"), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), sr)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(serve)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}/tone.wav"
    finally:
        srv.shutdown()
        srv.server_close()


def test_fetch_direct_link(wav_url, tmp_path):
    res = fetch_audio(wav_url, tmp_path / "out")
    assert res.path.is_file() and res.path.stat().st_size > 10_000


def test_materials_lesson_with_reference_link(client, tmp_path, wav_url):
    midi = write_midi(tmp_path / "x.mid")
    r = client.post(
        "/api/lessons",
        data={"mode": "materials", "url": wav_url},
        files=[("midi", ("x.mid", midi.read_bytes(), "audio/midi"))],
    )
    assert r.status_code < 300, r.text
    lesson = client.get(f"/api/lessons/{r.json()['id']}").json()
    assert lesson["status"] == "ready", lesson.get("error")
    assert lesson["media"].get("mix")


class _Endless(http.server.BaseHTTPRequestHandler):
    """Internet radio: audio without Content-Length that never ends."""

    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.end_headers()

    def do_GET(self):
        self.do_HEAD()
        chunk = b"\xff\xfb\x90\x64" + b"\x00" * (16 * 1024 - 4)
        end = time.monotonic() + 30
        try:
            while time.monotonic() < end:
                self.wfile.write(chunk)
                time.sleep(0.01)
        except OSError:
            pass


@pytest.fixture()
def radio_url():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Endless)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}/radio.mp3"
    finally:
        srv.shutdown()
        srv.server_close()


def test_endless_stream_can_be_cancelled(radio_url, tmp_path):
    calls = []

    def progress(fraction, label=None):
        calls.append(fraction)
        if len(calls) >= 3:
            raise Cancelled()

    t0 = time.monotonic()
    with pytest.raises(Cancelled):
        fetch_audio(radio_url, tmp_path / "out", progress)
    assert time.monotonic() - t0 < 10


def test_endless_stream_stops_at_the_size_cap(radio_url, tmp_path, monkeypatch):
    monkeypatch.setattr(fetch_mod, "MAX_BYTES", 512 * 1024)
    with pytest.raises(FetchError, match="больше"):
        fetch_audio(radio_url, tmp_path / "out")


def test_announced_size_over_the_cap_is_explained(wav_url, tmp_path, monkeypatch):
    monkeypatch.setattr(fetch_mod, "MAX_BYTES", 10 * 1024)  # the 2 s test tone is ~88 KB
    with pytest.raises(FetchError, match="больше"):
        fetch_audio(wav_url, tmp_path / "out")
