from __future__ import annotations

import pytest

from stemtutor.importers.midi_import import MidiImportError, import_midi
from stemtutor.importers.roles import stem_role_from_filename

from .songs import BARS, BEAT, BPM, write_midi


def test_import_roles_grid_and_notes(tmp_path):
    res = import_midi(write_midi(tmp_path / "song.mid"))
    roles = [p.role for p in res.parts]
    assert roles == ["drums", "bass", "chords", "melody"], roles

    assert abs(res.grid.bpm - BPM) < 0.01
    assert res.grid.timeSig == (4, 4)
    assert res.grid.barLength == 4.0
    assert res.grid.origin == "midi"
    steps = [b - a for a, b in zip(res.grid.beats, res.grid.beats[1:])]
    assert max(abs(s - BEAT) for s in steps) < 1e-3
    assert res.grid.beats[-1] >= BARS * 4 * BEAT

    drums = res.parts[0]
    assert drums.isDrum and drums.program is None
    kicks = [n for n in drums.notes if n.p == 36]
    assert len(kicks) == BARS * 4
    bass = res.parts[1]
    assert min(n.p for n in bass.notes) >= 28 and max(n.p for n in bass.notes) <= 48
    chords = res.parts[2]
    assert len(chords.notes) == BARS * 3


def test_broken_midi_has_friendly_error(tmp_path):
    bad = tmp_path / "bad.mid"
    bad.write_bytes(b"not a midi file at all")
    with pytest.raises(MidiImportError):
        import_midi(bad)


@pytest.mark.parametrize(
    "name,role",
    [
        ("Song (Drums).wav", "drums"),
        ("track_bass.wav", "bass"),
        ("Vocals.mp3", "vocal"),
        ("01 Piano.flac", "chords"),
        ("Ударные.wav", "drums"),
        ("Song (Others).wav", "other"),
        ("weird name.wav", "other"),
    ],
)
def test_stem_roles_from_filenames(name, role):
    assert stem_role_from_filename(name)[1] == role
