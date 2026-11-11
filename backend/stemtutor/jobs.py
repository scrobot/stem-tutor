"""Background job runner: one worker thread processes lessons sequentially.

ML stages are CPU/GPU heavy, so lessons are processed one at a time. Lessons left in
``queued``/``processing`` (e.g. the app was closed mid-way) are resumed on start, oldest
first. A queued lesson is cancelled at once; a running one stops at its next progress
check. The request is saved in lesson.json, so a restart never resumes a cancelled lesson.
"""

from __future__ import annotations

import gc
import logging
import queue
import sys
import threading

from .config import AppConfig
from .pipeline.runner import CANCELLED_MESSAGE, process_lesson
from .schemas import Lesson
from .storage import LessonRepo, NotFound

log = logging.getLogger("stemtutor.jobs")


def mark_cancelled(lesson: Lesson) -> None:
    lesson.status = "failed"
    lesson.error = CANCELLED_MESSAGE
    lesson.stage = None
    lesson.stageLabel = None
    lesson.cancelRequested = False


def reset_for_run(lesson: Lesson) -> None:
    """Fresh state for a (re)run: what retry does and what a resume after a restart needs."""
    lesson.status = "queued"
    lesson.stage = None
    lesson.stageLabel = None
    lesson.progress = 0.0
    lesson.error = None
    lesson.warnings = []
    lesson.cancelRequested = False


def _request_cancel(lesson: Lesson) -> None:
    if lesson.status in ("queued", "processing"):  # the job may have just finished
        lesson.cancelRequested = True
        lesson.stageLabel = "Отмена…"


def release_gpu_memory() -> None:
    """Give cached VRAM back to other apps. Called after a job's exception (and its traceback,
    which pins the model's tensors) is gone; torch is only touched if a stage imported it."""
    torch = sys.modules.get("torch")
    if torch is None:
        return
    try:
        if torch.cuda.is_available() and torch.cuda.is_initialized():
            gc.collect()
            torch.cuda.empty_cache()
    except Exception:  # pragma: no cover - driver specific
        log.debug("Could not release CUDA memory", exc_info=True)


class JobRunner:
    def __init__(self, repo: LessonRepo, cfg: AppConfig, synchronous: bool = False):
        self.repo = repo
        self.cfg = cfg
        self.synchronous = synchronous
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._thread: threading.Thread | None = None
        self._pending: set[str] = set()
        self._cancel: set[str] = set()
        self._lock = threading.Lock()
        self.current: str | None = None

    def start(self) -> None:
        if self.synchronous or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="stemtutor-jobs", daemon=True)
        self._thread.start()

    def submit(self, lesson_id: str) -> None:
        with self._lock:
            self._cancel.discard(lesson_id)
        if self.synchronous:
            process_lesson(self.repo, self.cfg, lesson_id, cancelled=lambda: self.is_cancelled(lesson_id))
            return
        with self._lock:
            if lesson_id in self._pending:
                return
            self._pending.add(lesson_id)
        self._queue.put(lesson_id)

    def cancel(self, lesson_id: str) -> bool:
        """Cancel a queued or running lesson; False if it is neither."""
        with self._lock:
            running = lesson_id == self.current
            queued = not running and lesson_id in self._pending
            if not (running or queued):
                return False
            if queued:
                self._pending.discard(lesson_id)  # its queue entry is skipped by the worker
            else:
                self._cancel.add(lesson_id)
        try:
            self.repo.update(lesson_id, mark_cancelled if queued else _request_cancel)
        except NotFound:  # deleted meanwhile
            pass
        return True

    def is_cancelled(self, lesson_id: str) -> bool:
        with self._lock:
            return lesson_id in self._cancel

    def is_busy(self, lesson_id: str) -> bool:
        with self._lock:
            return lesson_id == self.current or lesson_id in self._pending

    def resume_pending(self) -> int:
        count = 0
        for lesson in reversed(self.repo.list()):  # list() is newest first; resume in creation order
            if lesson.status not in ("queued", "processing"):
                continue
            try:
                self.repo.update(lesson.id, mark_cancelled if lesson.cancelRequested else reset_for_run)
            except NotFound:
                continue
            if not lesson.cancelRequested:
                self.submit(lesson.id)
                count += 1
        return count

    def _loop(self) -> None:
        while True:
            lesson_id = self._queue.get()
            with self._lock:
                if lesson_id not in self._pending:
                    continue  # cancelled while queued, or a stale duplicate entry
                self._pending.discard(lesson_id)
                self.current = lesson_id
            try:
                process_lesson(self.repo, self.cfg, lesson_id, cancelled=lambda lid=lesson_id: self.is_cancelled(lid))
            except Exception:  # process_lesson records failures itself; never kill the worker
                log.exception("Unexpected failure while processing %s", lesson_id)
            finally:
                with self._lock:
                    self.current = None
                    self._cancel.discard(lesson_id)
                release_gpu_memory()
