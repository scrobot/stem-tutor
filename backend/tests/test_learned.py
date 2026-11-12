"""The trainer's "learned" marks: merged by the server, so two tabs never overwrite each other."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest

from .songs import write_midi

BAD = {"detail": "Неверная отметка."}
AT = 1_731_400_000_000  # ms since the epoch


@pytest.fixture()
def lesson_id(client, tmp_path) -> str:
    midi = write_midi(tmp_path / "Song.mid")
    r = client.post("/api/lessons", data={"mode": "materials"}, files=[("midi", ("Song.mid", midi.read_bytes(), "audio/midi"))])
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _url(lesson_id: str) -> str:
    return f"/api/lessons/{lesson_id}/cover/learned"


def _mark(**changes: Any) -> dict:
    mark = {"part": "p1-bass", "layer": "bass", "start": 2.0, "end": 6.0, "acc": 0.8, "tempo": 1.0, "at": AT}
    mark.update(changes)
    return mark


def _post(client, lesson_id: str, **changes: Any) -> list[dict]:
    r = client.post(_url(lesson_id), json=_mark(**changes))
    assert r.status_code == 200, r.text
    return r.json()["coverLearned"]


def _stored(client, lesson_id: str) -> Any:
    return client.get(f"/api/lessons/{lesson_id}").json()["prefs"].get("coverLearned")


def test_a_mark_is_rounded_and_saved(client, lesson_id):
    got = _post(client, lesson_id, start=1.23456, end=5.00049, acc=0.876, tempo=0.951)
    assert got == [{"part": "p1-bass", "layer": "bass", "start": 1.235, "end": 5.0, "acc": 0.88, "tempo": 0.95, "at": AT}]
    assert _stored(client, lesson_id) == got


def test_the_same_loop_keeps_the_best_pass_and_the_last_time(client, lesson_id):
    _post(client, lesson_id, acc=0.8, tempo=1.0, at=1000)
    # worse (0.7 × 1.0): the best numbers stay, the time is the newer one ("last played well")
    assert _post(client, lesson_id, acc=0.7, at=2000)[0] == _mark(acc=0.8, at=2000)
    # faster but sloppier (1.0 × 0.75 < 0.8): still worse
    assert _post(client, lesson_id, acc=1.0, tempo=0.75, at=2500)[0] == _mark(acc=0.8, at=2500)
    # better, and start/end within 1 ms count as the same loop: replaced
    got = _post(client, lesson_id, acc=0.9, start=2.0008, end=5.9992, at=3000)
    assert got == [_mark(acc=0.9, start=2.001, end=5.999, at=3000)]
    # as good, but from a tab whose clock is behind: the newer time stays
    assert _post(client, lesson_id, acc=0.9, at=2900) == [_mark(acc=0.9, at=3000)]
    # as good and later: the time is refreshed
    assert _post(client, lesson_id, acc=0.9, at=4000) == [_mark(acc=0.9, at=4000)]
    assert _stored(client, lesson_id) == [_mark(acc=0.9, at=4000)]


def test_a_replayed_loop_moves_to_the_end_so_the_cap_keeps_it(client, lesson_id):
    _post(client, lesson_id, start=0.0, end=4.0, at=1)
    _post(client, lesson_id, start=4.0, end=8.0, at=2)
    got = _post(client, lesson_id, start=0.0, end=4.0, acc=0.5, at=3)  # worse, but played again
    assert [(m["start"], m["acc"], m["at"]) for m in got] == [(4.0, 0.8, 2), (0.0, 0.8, 3)]


def test_other_loops_layers_and_parts_are_added(client, lesson_id):
    _post(client, lesson_id)
    _post(client, lesson_id, layer="all")
    _post(client, lesson_id, start=2.01)  # 10 ms away: another loop
    got = _post(client, lesson_id, part="p2-lead", layer="melody")
    assert [(m["part"], m["layer"], m["start"]) for m in got] == [
        ("p1-bass", "bass", 2.0), ("p1-bass", "all", 2.0), ("p1-bass", "bass", 2.01), ("p2-lead", "melody", 2.0),
    ]


def test_malformed_stored_marks_are_ignored(client, lesson_id):
    good = _mark(part="p0-drums", layer="all", acc=0.5)
    junk = ["x", None, {"part": "p0-drums"}, _mark(layer="drums"), _mark(acc=7), _mark(end=2.1), {**good, "at": -5}]
    r = client.patch(f"/api/lessons/{lesson_id}", json={"prefs": {"coverLearned": [*junk, good]}})
    assert r.status_code == 200
    assert _post(client, lesson_id) == [good, _mark()]
    client.patch(f"/api/lessons/{lesson_id}", json={"prefs": {"coverLearned": "not a list"}})
    assert _post(client, lesson_id) == [_mark()]


def test_a_stored_mark_without_a_time_is_kept_as_time_zero(client, lesson_id):
    # Marks written before they had a time (or by an older app through PATCH) are kept.
    old = {k: v for k, v in _mark(part="p0-drums", layer="pads").items() if k != "at"}
    client.patch(f"/api/lessons/{lesson_id}", json={"prefs": {"coverLearned": [old]}})
    assert _post(client, lesson_id) == [{**old, "at": 0.0}, _mark()]
    # but a new mark must say when it was played
    r = client.post(_url(lesson_id), json={k: v for k, v in _mark().items() if k != "at"})
    assert r.status_code == 400 and r.json() == BAD


def test_only_the_last_300_marks_are_kept(client, lesson_id):
    old = [_mark(start=float(i), end=i + 1.0, at=i) for i in range(300)]
    assert client.patch(f"/api/lessons/{lesson_id}", json={"prefs": {"coverLearned": old}}).status_code == 200
    got = _post(client, lesson_id, start=1000.0, end=1001.0)
    assert len(got) == 300
    assert got[0] == old[1] and got[-1] == _mark(start=1000.0, end=1001.0)


@pytest.mark.parametrize(
    "body",
    [
        _mark(part=""), _mark(part="p" * 81), _mark(part=5), _mark(layer="drums"), _mark(layer=None),
        _mark(start="2"), _mark(end=2.2), _mark(acc=1.01), _mark(acc=-0.01), _mark(acc=True),
        _mark(tempo=2.01), _mark(tempo=-1), _mark(at=-1), _mark(at="now"), _mark(at=10 ** 400),
        {k: v for k, v in _mark().items() if k != "tempo"}, [], "mark", 5, None,
    ],
)
def test_bad_marks_are_refused_with_400(client, lesson_id, body):
    r = client.post(_url(lesson_id), json=body)
    assert (r.status_code, r.json()) == (400, BAD)
    assert _stored(client, lesson_id) is None


@pytest.mark.parametrize(
    "raw",
    [b"", b"{", b'{"part": "p1", "layer": "all", "start": NaN, "end": 5, "acc": 1, "tempo": 1, "at": 0}',
     b'{"part": "p1", "layer": "all", "start": 0, "end": Infinity, "acc": 1, "tempo": 1, "at": 0}',
     b"\xff\xfe\x00not utf-8", b"[" * 100_000],
)
def test_broken_bodies_are_a_400_not_a_422(client, lesson_id, raw):
    r = client.post(_url(lesson_id), content=raw, headers={"content-type": "application/json"})
    assert (r.status_code, r.json()) == (400, BAD)


def test_unknown_lesson(client):
    r = client.post(_url("nope-000000"), json=_mark())
    assert (r.status_code, r.json()) == (404, {"detail": "Урок не найден"})


def test_cross_site_marks_are_refused(client, lesson_id):
    assert client.post(_url(lesson_id), json=_mark(), headers={"origin": "https://evil.example"}).status_code == 403
    cross = {"sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "content-type": "text/plain"}
    assert client.post(_url(lesson_id), content=b'{"part": "p1"}', headers=cross).status_code == 403
    assert _stored(client, lesson_id) is None


def test_two_tabs_marking_at_once_lose_nothing(client, lesson_id):
    marks = [_mark(start=float(i), end=i + 2.0, at=i) for i in range(24)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(lambda m: client.post(_url(lesson_id), json=m).status_code, marks))
    assert codes == [200] * 24
    assert sorted(m["start"] for m in _stored(client, lesson_id)) == [float(i) for i in range(24)]
