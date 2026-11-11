"""Import a ready-made (e.g. downloaded) MIDI file into parts + an exact beat grid."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import mido
import numpy as np
import pretty_midi

from ..schemas import Grid, Note, Part
from .roles import ROLE_ORDER, infer_midi_role


class MidiImportError(ValueError):
    pass


@dataclass
class MidiImportResult:
    parts: list[Part]
    grid: Grid
    duration: float
    title: str | None
    warnings: list[str]


def _quarter_beats(pm: pretty_midi.PrettyMIDI, end_time: float) -> list[float]:
    """Times of every quarter note, following the tempo map, a bit past ``end_time``."""
    res = pm.resolution
    beats: list[float] = []
    k = 0
    while True:
        t = float(pm.tick_to_time(k * res))
        beats.append(t)
        if t > end_time + 0.5 and len(beats) >= 8:
            break
        k += 1
        if k > 200_000:  # ~ 7 hours at 480 bpm; protects against broken files
            break
    return beats


def _representative_bpm(pm: pretty_midi.PrettyMIDI, end_time: float) -> float:
    times, tempi = pm.get_tempo_changes()
    if len(tempi) == 0:
        return 120.0
    if len(tempi) == 1:
        return float(tempi[0])
    # Duration-weighted median tempo.
    times = list(times) + [max(end_time, times[-1] + 1e-3)]
    durs = np.diff(times)
    order = np.argsort(tempi)
    cum = np.cumsum(durs[order])
    idx = int(np.searchsorted(cum, cum[-1] / 2))
    return float(tempi[order][min(idx, len(order) - 1)])


def import_midi(path: Path) -> MidiImportResult:
    try:
        pm = pretty_midi.PrettyMIDI(str(path))
    except Exception as exc:  # pretty_midi raises many exception types on broken files
        raise MidiImportError(f"Не удалось прочитать MIDI-файл: {exc}") from exc

    warnings: list[str] = []
    end_time = float(pm.get_end_time())
    if end_time <= 0:
        raise MidiImportError("В MIDI-файле нет нот.")

    beats = _quarter_beats(pm, end_time)
    num, den = 4, 4
    first_downbeat = 0
    if pm.time_signature_changes:
        ts = pm.time_signature_changes[0]
        num, den = int(ts.numerator), int(ts.denominator)
        if ts.time > 1e-3:
            first_downbeat = int(np.argmin(np.abs(np.asarray(beats) - ts.time)))
        if len(pm.time_signature_changes) > 1:
            changes = {(t.numerator, t.denominator) for t in pm.time_signature_changes}
            if len(changes) > 1:
                warnings.append(
                    "В файле несколько размеров; такты считаются по первому "
                    f"({num}/{den})."
                )
    bar_length = num * 4.0 / den
    tempo_changes = pm.get_tempo_changes()[1]
    if len(set(np.round(tempo_changes, 2))) > 1:
        warnings.append("Темп в файле меняется; сетка следует темп-карте.")

    grid = Grid(
        beats=[round(b, 6) for b in beats],
        barLength=bar_length,
        timeSig=(num, den),
        firstDownbeat=first_downbeat,
        bpm=round(_representative_bpm(pm, end_time), 3),
        origin="midi",
    )

    parts: list[Part] = []
    for idx, inst in enumerate(pm.instruments):
        notes = [
            Note(p=int(n.pitch), s=round(float(n.start), 6), e=round(float(n.end), 6), v=int(n.velocity) or 1)
            for n in inst.notes
            if n.end - n.start > 1e-4
        ]
        if not notes:
            continue
        notes.sort(key=lambda n: (n.s, n.p))
        name = (inst.name or "").strip()
        if not name:
            name = "Drums" if inst.is_drum else pretty_midi.program_to_instrument_name(inst.program)
        role = infer_midi_role(inst.program, inst.is_drum, name, notes)
        parts.append(
            Part(
                id=f"p{idx}",
                name=name,
                role=role,
                isDrum=bool(inst.is_drum),
                program=None if inst.is_drum else int(inst.program),
                origin="midi",
                notes=notes,
            )
        )

    if not parts:
        raise MidiImportError("В MIDI-файле нет дорожек с нотами.")

    parts.sort(key=lambda p: (ROLE_ORDER.get(p.role, 9), -len(p.notes)))
    duration = math.ceil(end_time * 1000) / 1000
    return MidiImportResult(
        parts=parts, grid=grid, duration=duration, title=_midi_title(path), warnings=warnings
    )


def _midi_title(path: Path) -> str | None:
    """Song title from the conductor track name of a type-1 file, if present."""
    try:
        mf = mido.MidiFile(str(path))
        if mf.type != 1 or not mf.tracks:
            return None
        first = mf.tracks[0]
        if any(msg.type == "note_on" for msg in first):
            return None
        for msg in first:
            if msg.type == "track_name" and msg.name.strip():
                return msg.name.strip()[:120]
    except Exception:
        return None
    return None
