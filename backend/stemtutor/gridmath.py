"""Beat-grid arithmetic shared by exports. Mirrors ``frontend/src/music/grid.ts``."""

from __future__ import annotations

import math

from .schemas import Grid


def beat_time(grid: Grid, beat: float) -> float:
    """Time (s) of a fractional beat index; extrapolates linearly outside the grid."""
    beats = grid.beats
    n = len(beats)
    if n == 0:
        return beat * 60.0 / (grid.bpm or 120.0)
    if n == 1:
        return beats[0] + beat * 60.0 / (grid.bpm or 120.0)
    if beat <= 0:
        return beats[0] + beat * (beats[1] - beats[0])
    if beat >= n - 1:
        return beats[-1] + (beat - (n - 1)) * (beats[-1] - beats[-2])
    i = int(math.floor(beat))
    f = beat - i
    return beats[i] + f * (beats[i + 1] - beats[i])


def export_origin(grid: Grid) -> tuple[float, float]:
    """(beat, time) where an exported file starts so that it lands on a DAW bar line.

    The origin is the latest bar line at or before t = 0, counted back from the first
    downbeat in whole bars. Audio is padded by ``-time`` seconds; MIDI ticks are counted
    from ``beat``. Both therefore start at DAW bar 1 with the same tempo.
    """
    fd = float(grid.firstDownbeat)
    bar = grid.barLength or 4.0
    k = 0
    while beat_time(grid, fd - k * bar) > 1e-6 and k < 10_000:
        k += 1
    origin_beat = fd - k * bar
    return origin_beat, beat_time(grid, origin_beat)
