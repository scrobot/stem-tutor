"""Accuracy of the audio path on rendered stems with known notes (see tests/songs.py)."""

from __future__ import annotations

import numpy as np
import pytest

from stemtutor.pipeline import ffmpeg
from stemtutor.pipeline.analyze import analyze_grid
from stemtutor.pipeline.drums import transcribe_drums
from stemtutor.pipeline.melodic import clean_notes, transcribe_melodic

from .songs import BEAT, BPM, render_stems, truth


def f1_times(found, ref, tol=0.05):
    used, tp = set(), 0
    for x in found:
        c = [(abs(x - r), i) for i, r in enumerate(ref) if i not in used and abs(x - r) <= tol]
        if c:
            used.add(min(c)[1])
            tp += 1
    p = tp / len(found) if found else 0.0
    r = tp / len(ref) if ref else 0.0
    return 2 * p * r / (p + r) if p + r else 0.0


def f1_notes(found, ref, tol=0.06):
    used, tp = set(), 0
    for n in found:
        for i, (s, _e, p) in enumerate(ref):
            if i not in used and p == n.p and abs(n.s - s) <= tol:
                used.add(i)
                tp += 1
                break
    prec = tp / len(found) if found else 0.0
    rec = tp / len(ref) if ref else 0.0
    return 2 * prec * rec / (prec + rec) if prec + rec else 0.0


@pytest.fixture(scope="module")
def stems(tmp_path_factory):
    return render_stems(tmp_path_factory.mktemp("stems"))


def test_drums_to_gm(stems):
    t = truth()
    notes = transcribe_drums(stems["drums"])
    at = lambda gm: [n.s for n in notes if n.p == gm]  # noqa: E731
    assert f1_times(at(36), t.kick) >= 0.95
    assert f1_times(at(38), t.snare) >= 0.95
    assert f1_times(at(42), t.hat) >= 0.85
    assert f1_times(at(46), t.open_hat) >= 0.85
    kick_err = [min(abs(x - r) for r in t.kick) for x in at(36)]
    assert sum(kick_err) / len(kick_err) < 0.012  # attack times are not shifted
    assert min(at(36)) < 0.03  # the kick at 0:00 has no earlier frame, it still counts


def _groove(path, bars=4, bpm=120.0, kicks=(0, 2), snares=(1, 3), crash_at=None, snare_gain=0.7, kick_gain=0.9):
    """A drum loop from the test song's sounds; returns kick and snare times."""
    import soundfile as sf

    from .songs import SR, _hat, _hp, _kick, _noise, _place, _snare

    rng = np.random.default_rng(3)
    beat = 60.0 / bpm
    y = np.zeros(int((bars * 4 * beat + 2.0) * SR), np.float32)
    kt, st = [], []
    for i in range(bars * 4):
        t0 = 0.25 + i * beat
        if i % 4 in kicks:
            _place(y, t0, _kick(), kick_gain)
            kt.append(t0)
        if i % 4 in snares:
            _place(y, t0, _snare(rng), snare_gain)
            st.append(t0)
    for i in range(bars * 8):
        _place(y, 0.25 + i * beat / 2, _hat(rng, 0.025, 0.08), 0.35)
    if crash_at is not None:
        n = int(2.0 * SR)
        tt = np.arange(n) / SR
        _place(y, crash_at, (_hp(_noise(n, rng), 3000) * np.exp(-tt / 0.6)).astype(np.float32), 0.5)
    y *= 0.8 / float(np.abs(y).max())
    sf.write(str(path), np.stack([y, y], axis=1), SR, subtype="PCM_16")
    return kt, st


@pytest.mark.parametrize("snare_gain,kick_gain", [(0.7, 0.9), (0.9, 0.7)])
def test_backbeat_snares_are_not_kicks(tmp_path, snare_gain, kick_gain):
    """Kick on 1 and 3, snare on 2 and 4: a snare's body leaks into the kick band but must
    not become a kick on every backbeat."""
    kt, st = _groove(tmp_path / "backbeat.wav", snare_gain=snare_gain, kick_gain=kick_gain)
    notes = transcribe_drums(tmp_path / "backbeat.wav")
    kicks = [n.s for n in notes if n.p == 36]
    assert f1_times(kicks, kt, tol=0.03) == 1.0
    assert f1_times([n.s for n in notes if n.p == 38], st, tol=0.03) == 1.0


def test_kick_under_snare_is_kept(tmp_path):
    kt, st = _groove(tmp_path / "four.wav", kicks=(0, 1, 2, 3))
    kicks = [n.s for n in transcribe_drums(tmp_path / "four.wav") if n.p == 36]
    assert f1_times(kicks, kt, tol=0.03) == 1.0


@pytest.mark.parametrize("intro_db,lone_kicks", [(-16.0, True), (-10.0, False)])
def test_kicks_under_snares_survive_a_soft_intro(tmp_path, intro_db, lone_kicks):
    """Kick on every beat (or with the snare on every beat, no lone kicks at all), the first
    bars much quieter: those kicks are judged against their own passage, not the loud rest."""
    import soundfile as sf

    from .songs import SR, _hat, _kick, _place, _snare

    rng = np.random.default_rng(3)
    beat = 0.5
    bars = 12
    y = np.zeros(int((bars * 4 * beat + 2.0) * SR), np.float32)
    kt = []
    for i in range(bars * 4):
        g = 10 ** (intro_db / 20) if i < 16 else 1.0
        t0 = 0.25 + i * beat
        _place(y, t0, _kick(), 0.9 * g)
        kt.append(t0)
        if i % 2 == 1 or not lone_kicks:
            _place(y, t0, _snare(rng), 0.7 * g)
    for i in range(bars * 8):
        _place(y, 0.25 + i * beat / 2, _hat(rng, 0.025, 0.08), 0.35 * (10 ** (intro_db / 20) if i < 32 else 1.0))
    y *= 0.8 / float(np.abs(y).max())
    sf.write(str(tmp_path / "intro.wav"), np.stack([y, y], axis=1), SR, subtype="PCM_16")
    kicks = [n.s for n in transcribe_drums(tmp_path / "intro.wav") if n.p == 36]
    assert f1_times(kicks, kt, tol=0.03) == 1.0


def test_crash_on_a_snare_hit_is_a_crash(tmp_path):
    crash_t = 0.25 + 15 * 0.5  # last snare of the loop, like the end of a fill
    _groove(tmp_path / "fill.wav", crash_at=crash_t)
    near = {n.p for n in transcribe_drums(tmp_path / "fill.wav") if abs(n.s - crash_t) < 0.03}
    assert 49 in near and 38 in near


def test_bass_and_melody(stems):
    t = truth()
    bass = transcribe_melodic(stems["bass"], "bass")
    assert f1_notes(bass, t.bass) >= 0.8
    assert abs(bass[0].s) < 0.03  # low notes start on time (onset refinement)
    lead = transcribe_melodic(stems["vocals"], "melody")
    assert f1_notes(lead, t.lead) >= 0.95


def test_chords_without_overtone_ghosts(stems):
    t = truth()
    ref = [(s, e, p) for s, e, tri in t.chords for p in tri]
    notes = transcribe_melodic(stems["other"], "chords")
    assert f1_notes(notes, ref) >= 0.9


def _mix_wavs(paths, out):
    import soundfile as sf

    sigs = [sf.read(str(p), dtype="float32")[0] for p in paths]
    n = max(len(s) for s in sigs)
    y = sum(np.pad(s, ((0, n - len(s)), (0, 0))) for s in sigs)
    sf.write(str(out), y * (0.8 / float(np.abs(y).max())), 44100, subtype="PCM_16")
    return out


def test_melody_over_held_chords_does_not_restrike_them(stems, tmp_path):
    """Demucs puts pads and a lead into one 'other' stem: the lead's attacks must not cut the
    held chord into eighths."""
    t = truth()
    bar = 4 * BEAT
    pad = [(s, e, p) for s, e, tri in t.chords for p in tri]
    pad_pitches = {p for _, _, p in pad}
    mix = _mix_wavs([stems["other"], stems["vocals"]], tmp_path / "pad_lead.wav")
    notes = transcribe_melodic(mix, "other")
    mid_bar = [n for n in notes if n.p in pad_pitches and 0.15 < n.s % bar < bar - 0.15]
    assert len(mid_bar) <= 4  # was ~130 when every lead attack re-struck the chord
    assert f1_notes(notes, pad + list(t.lead)) >= 0.7


def test_repeated_chord_stabs_are_each_played(tmp_path):
    import soundfile as sf

    from .songs import BARS, CHORDS, SR, _place, _tone

    ref = []
    y = np.zeros(int((BARS * 4 * BEAT + 1.0) * SR), np.float32)
    for bar in range(BARS):
        for b in range(4):
            s = (bar * 4 + b) * BEAT
            for p in CHORDS[bar % 4][1]:
                _place(y, s, _tone(440.0 * 2 ** ((p - 69) / 12), BEAT * 0.9), 0.18)
                ref.append((s, s + BEAT * 0.9, p))
    sf.write(str(tmp_path / "stabs.wav"), np.stack([y, y], axis=1) * (0.8 / float(np.abs(y).max())), SR, subtype="PCM_16")
    notes = transcribe_melodic(tmp_path / "stabs.wav", "other")
    assert f1_notes(notes, ref) >= 0.9


def test_unsnapped_tempo_does_not_drift():
    """123.456 BPM over 10 minutes: the grid follows the fitted period, only the shown BPM
    is rounded."""
    from stemtutor.pipeline.analyze import _regularize

    period = 60 / 123.456
    n = int(600 / period)
    true = 0.31 + period * np.arange(n)
    frame = 256 / 44100
    tracked = np.round((true + np.random.default_rng(0).normal(0, 0.004, n)) / frame) * frame
    grid, shown, steady = _regularize(tracked, duration=600.0)
    assert steady and shown == 123.46
    assert float(np.max(np.abs(grid[:n] - true))) < 0.002


def test_grid_tempo_and_downbeat(stems, tmp_path):
    mix = ffmpeg.mix_to_wav(list(stems.values()), tmp_path / "mix.wav")
    g = analyze_grid(mix, stems["drums"], stems["bass"], 0, harmonic_wav=stems["other"])
    assert abs(g.bpm - BPM) < 0.5
    downbeat = g.beats[g.firstDownbeat]
    bar = 4 * BEAT
    off = min(downbeat % bar, bar - downbeat % bar)
    assert off < 0.03, f"downbeat at {downbeat:.3f}s is not on a bar line"


def test_clean_notes_rules():
    raw = [
        (0.00, 0.40, 33, 0.8),  # fundamental
        (0.00, 0.40, 45, 0.3),  # octave overtone ghost
        (0.41, 0.80, 33, 0.7),  # repeated note
        (0.80, 0.82, 40, 0.9),  # too short
        (1.00, 1.30, 36, 0.05),  # too quiet
    ]
    # Without onsets a 10 ms gap is treated as a fragment and merged…
    assert [(n.p, round(n.s, 2)) for n in clean_notes(raw, "bass")] == [(33, 0.0)]
    # …the stem's own attack at 0.41 s splits it back into a repeated note.
    notes = clean_notes(raw, "bass", onsets=np.array([0.0, 0.41]))
    assert [(n.p, round(n.s, 2)) for n in notes] == [(33, 0.0), (33, 0.41)]
    chords = clean_notes([(0, 1, 57, 0.8), (0, 1, 60, 0.75), (0, 1, 69, 0.78)], "chords")
    assert sorted(n.p for n in chords) == [57, 60, 69]  # a real (loud) octave doubling survives
