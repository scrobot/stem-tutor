"""JobRunner with its real worker thread: queue order, cancellation and resume after a restart.
process_lesson is replaced by a stub that can hold a lesson 'running' until the test lets go."""

from __future__ import annotations

import threading
import time

import pytest

from stemtutor import jobs
from stemtutor.jobs import JobRunner, reset_for_run
from stemtutor.pipeline.runner import CANCELLED_MESSAGE
from stemtutor.schemas import Lesson, SourceInfo
from stemtutor.storage import LessonRepo


class Worker:
    """Stub for process_lesson: records calls; lessons listed in `hold` block until released."""

    def __init__(self, hold=()):
        self.calls: list[tuple[str, str, float, list[str]]] = []
        self.gates = {lid: threading.Event() for lid in hold}
        self.started = {lid: threading.Event() for lid in hold}

    def __call__(self, repo, cfg, lesson_id, cancelled=None):
        les = repo.get(lesson_id)
        self.calls.append((lesson_id, les.status, les.progress, list(les.warnings)))
        if lesson_id in self.gates:
            self.started[lesson_id].set()
            self.gates[lesson_id].wait(10)
        repo.update(lesson_id, lambda x: setattr(x, "status", "ready"))

    def ids(self):
        return [c[0] for c in self.calls]


def _lesson(repo, lid, created, **kw):
    les = Lesson(id=lid, title=lid, createdAt=created, source=SourceInfo(kind="midi"), **kw)
    return repo.create(les)


def _wait(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture()
def repo(tmp_path):
    return LessonRepo(tmp_path / "lessons")


def test_cancel_queued_lesson_takes_effect_at_once(repo, cfg, monkeypatch):
    work = Worker(hold=["aaa-1"])
    monkeypatch.setattr(jobs, "process_lesson", work)
    _lesson(repo, "aaa-1", "2026-01-01T00:00:00+00:00")
    _lesson(repo, "bbb-2", "2026-01-01T00:00:01+00:00")
    runner = JobRunner(repo, cfg)
    runner.start()
    runner.submit("aaa-1")
    runner.submit("bbb-2")
    assert work.started["aaa-1"].wait(5)

    assert runner.cancel("bbb-2") is True
    b = repo.get("bbb-2")
    assert b.status == "failed" and b.error == CANCELLED_MESSAGE
    assert not runner.is_busy("bbb-2")
    assert runner.cancel("bbb-2") is False  # nothing left to cancel

    work.gates["aaa-1"].set()
    assert _wait(lambda: runner.current is None and runner._queue.empty())
    time.sleep(0.1)
    assert work.ids() == ["aaa-1"]  # the cancelled lesson never ran


def test_retry_after_queued_cancel_runs_exactly_once(repo, cfg, monkeypatch):
    work = Worker(hold=["aaa-1"])
    monkeypatch.setattr(jobs, "process_lesson", work)
    _lesson(repo, "aaa-1", "2026-01-01T00:00:00+00:00")
    _lesson(repo, "bbb-2", "2026-01-01T00:00:01+00:00")
    runner = JobRunner(repo, cfg)
    runner.start()
    runner.submit("aaa-1")
    runner.submit("bbb-2")
    assert work.started["aaa-1"].wait(5)
    runner.cancel("bbb-2")
    repo.update("bbb-2", reset_for_run)  # what the retry endpoint does
    runner.submit("bbb-2")  # a second queue entry; the stale one must be skipped
    work.gates["aaa-1"].set()
    assert _wait(lambda: repo.get("bbb-2").status == "ready")
    time.sleep(0.1)
    assert work.ids() == ["aaa-1", "bbb-2"]


def test_cancel_of_running_lesson_survives_restart(repo, cfg, monkeypatch):
    work = Worker(hold=["aaa-1"])
    monkeypatch.setattr(jobs, "process_lesson", work)
    _lesson(repo, "aaa-1", "2026-01-01T00:00:00+00:00")
    runner = JobRunner(repo, cfg)
    runner.start()
    runner.submit("aaa-1")
    assert work.started["aaa-1"].wait(5)
    repo.update("aaa-1", lambda x: setattr(x, "status", "processing"))

    assert runner.cancel("aaa-1") is True
    a = repo.get("aaa-1")
    assert a.cancelRequested and a.stageLabel == "Отмена…" and runner.is_cancelled("aaa-1")

    # The app is closed before the job reaches a cancel check; the next start must not resume it.
    fresh = Worker()
    monkeypatch.setattr(jobs, "process_lesson", fresh)
    second = JobRunner(repo, cfg)
    second.start()
    assert second.resume_pending() == 0
    a = repo.get("aaa-1")
    assert a.status == "failed" and a.error == CANCELLED_MESSAGE and not a.cancelRequested
    time.sleep(0.1)
    assert fresh.calls == []
    work.gates["aaa-1"].set()


def test_resume_runs_oldest_first_from_a_clean_state(repo, cfg, monkeypatch):
    work = Worker()
    monkeypatch.setattr(jobs, "process_lesson", work)
    _lesson(repo, "old-1", "2026-01-01T00:00:00+00:00", status="processing", progress=0.42, warnings=["w"],
            stageLabel="Разделение на стемы")
    _lesson(repo, "new-2", "2026-01-02T00:00:00+00:00", status="queued")
    _lesson(repo, "done-3", "2026-01-03T00:00:00+00:00", status="ready")
    runner = JobRunner(repo, cfg)
    runner.start()
    assert runner.resume_pending() == 2
    assert _wait(lambda: len(work.calls) == 2)
    assert work.ids() == ["old-1", "new-2"]
    assert work.calls[0][1:] == ("queued", 0.0, [])  # interrupted lesson restarts clean
    assert repo.get("done-3").status == "ready"  # finished lessons are left alone


def test_delete_of_queued_lesson_is_immediate(client, cfg, monkeypatch, tmp_path):
    """Through the API: a queued lesson behind a running one can be deleted right away."""
    app = client.app
    runner: JobRunner = app.state.runner
    work = Worker(hold=["aaa-1"])
    monkeypatch.setattr(jobs, "process_lesson", work)
    repo = app.state.repo
    _lesson(repo, "aaa-1", "2026-01-01T00:00:00+00:00")
    _lesson(repo, "bbb-2", "2026-01-01T00:00:01+00:00")
    runner.synchronous = False
    runner.start()
    runner.submit("aaa-1")
    runner.submit("bbb-2")
    assert work.started["aaa-1"].wait(5)
    assert client.delete("/api/lessons/aaa-1").status_code == 409  # running: cancel first
    assert client.delete("/api/lessons/bbb-2").status_code == 204
    work.gates["aaa-1"].set()
    assert _wait(lambda: runner.current is None)
    assert work.ids() == ["aaa-1"]
