"""The trainer's "learned" marks for the cover plan, kept in ``lesson.prefs["coverLearned"]``.

Each new mark is merged on the server under the storage lock, so two browser tabs never
overwrite each other's progress (as a PATCH of the whole ``prefs`` would).
"""

from __future__ import annotations

import math
from typing import Any

LAYERS = ("all", "melody", "chords", "bass", "pads")
MAX_ENTRIES = 300
MIN_LOOP = 0.25  # beats
SAME_LOOP = 1e-3 + 1e-9  # start and end this close: the same loop
BAD_MARK = "Неверная отметка."


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:  # an integer too large for a float
        return None
    return number if math.isfinite(number) else None


def _rounded(value: float, digits: int) -> float:
    return round(value, digits) + 0.0  # + 0.0: no "-0.0"


def _mark(raw: Any, slack: float = 0.0, stored: bool = False) -> dict | None:
    """One mark checked and rounded, or None. ``slack`` lets stored marks through whose start
    and end were already rounded; a stored mark without a time (written before marks had one,
    or by an older app through a PATCH) counts as played at time 0."""
    if not isinstance(raw, dict):
        return None
    part, layer = raw.get("part"), raw.get("layer")
    start, end, acc, tempo, at = (_number(raw.get(k)) for k in ("start", "end", "acc", "tempo", "at"))
    if at is None and stored and raw.get("at") is None:
        at = 0.0
    if not (isinstance(part, str) and 1 <= len(part) <= 80 and isinstance(layer, str) and layer in LAYERS):
        return None
    if start is None or end is None or end - start < MIN_LOOP - slack:
        return None
    if acc is None or not 0 <= acc <= 1 or tempo is None or not 0 <= tempo <= 2 or at is None or at < 0:
        return None
    return {
        "part": part,
        "layer": layer,
        "start": _rounded(start, 3),
        "end": _rounded(end, 3),
        "acc": _rounded(acc, 2),
        "tempo": _rounded(tempo, 2),
        "at": at,
    }


def clean_mark(raw: Any) -> dict | None:
    """A new mark from the trainer; None means refuse it (400 BAD_MARK)."""
    return _mark(raw)


def merge(stored: Any, mark: dict) -> list[dict]:
    """The stored marks (malformed ones dropped) with ``mark`` added.

    A pass over the same loop (same part and layer, start and end within 1 ms) keeps the best
    numbers (accuracy × tempo) and the newest time: every mark is a good pass, so `at` means
    "last played well" — a pass after a plan untick ticks the loop again even when it is not a
    new best. The updated mark moves to the end, so the MAX_ENTRIES cap drops the stretches
    played longest ago.
    """
    entries = [m for m in (_mark(x, slack=0.002, stored=True) for x in (stored if isinstance(stored, list) else [])) if m]
    for i, old in enumerate(entries):
        if (
            old["part"] == mark["part"]
            and old["layer"] == mark["layer"]
            and abs(old["start"] - mark["start"]) <= SAME_LOOP
            and abs(old["end"] - mark["end"]) <= SAME_LOOP
        ):
            best = mark if mark["acc"] * mark["tempo"] >= old["acc"] * old["tempo"] - 1e-9 else old
            entries.pop(i)
            entries.append({**best, "at": max(mark["at"], old["at"])})
            break
    else:
        entries.append(mark)
    return entries[-MAX_ENTRIES:]
