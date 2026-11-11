"""Role inference for parts: from GM programs + note content (MIDI) or file names (stems)."""

from __future__ import annotations

import re
from typing import Iterable

import numpy as np

from ..schemas import Note, Role

_VOCAL = ("vocal", "vox", "voice", "sing", "choir", "вокал", "голос", "хор")
_BASS = ("bass", "бас")
_DRUMS = ("drum", "perc", "kit", "beat", "ударн", "барабан", "перкус")


def _has(name: str, words: Iterable[str]) -> bool:
    return any(w in name for w in words)


def polyphony(notes: list[Note]) -> float:
    """Time-weighted mean number of sounding notes while at least one sounds."""
    if not notes:
        return 0.0
    events: list[tuple[float, int]] = []
    for n in notes:
        if n.e > n.s:
            events.append((n.s, 1))
            events.append((n.e, -1))
    events.sort(key=lambda x: (x[0], x[1]))
    active, last_t, weighted, sounding = 0, events[0][0], 0.0, 0.0
    for t, d in events:
        dt = t - last_t
        if active > 0 and dt > 0:
            weighted += active * dt
            sounding += dt
        active += d
        last_t = t
    return weighted / sounding if sounding > 0 else 0.0


def infer_midi_role(program: int, is_drum: bool, name: str, notes: list[Note]) -> Role:
    n = name.lower()
    if is_drum:
        return "drums"
    if _has(n, _VOCAL):
        return "vocal"
    poly = polyphony(notes)
    median = float(np.median([x.p for x in notes])) if notes else 60.0
    if _has(n, _BASS) or 32 <= program <= 39:
        return "bass"
    if median < 50 and poly < 1.3:
        return "bass"
    if poly >= 1.6:
        return "chords"
    # Pianos, organs, guitars, ensembles and pads are harmonic instruments by nature.
    if poly >= 1.25 and (program <= 7 or 16 <= program <= 31 or 48 <= program <= 55 or 88 <= program <= 95):
        return "chords"
    if 96 <= program <= 103 or 112 <= program <= 127:
        return "other"
    return "melody"


STEM_RULES: list[tuple[str, Role, tuple[str, ...]]] = [
    ("Drums", "drums", _DRUMS),
    ("Bass", "bass", _BASS),
    ("Vocals", "vocal", _VOCAL),
    ("Piano", "chords", ("piano", "keys", "клавиш", "пиан", "фортеп")),
    ("Guitar", "chords", ("guitar", "гитар")),
    ("Other", "other", ("other", "harmony", "instrument", "music", "synth", "остальн", "прочее", "гармон")),
]


def stem_role_from_filename(filename: str) -> tuple[str, Role]:
    """Guess (display name, role) for a stem file, e.g. 'Track (Drums).wav' -> drums."""
    base = re.sub(r"\.[a-z0-9]{2,5}$", "", filename.lower())
    for display, role, words in STEM_RULES:
        if _has(base, words):
            return display, role
    pretty = re.sub(r"[_\-]+", " ", re.sub(r"\.[A-Za-z0-9]{2,5}$", "", filename)).strip()
    return (pretty or "Stem"), "other"


def refine_transcribed_role(role: Role, notes: list[Note]) -> Role:
    """'other' stems become chords or melody depending on what was actually heard."""
    if role != "other" or not notes:
        return role
    return "chords" if polyphony(notes) >= 1.5 else "melody"


ROLE_ORDER: dict[str, int] = {"drums": 0, "bass": 1, "chords": 2, "melody": 3, "vocal": 4, "other": 5}
