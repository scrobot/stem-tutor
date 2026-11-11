"""Deterministic test material: a small 4/4 song as MIDI and as rendered stems.

The song (8 bars, 124 BPM, A minor):
* drums  — kick on every beat, snare/clap on 2 and 4, closed hats on 8ths, open hat on the
  last 8th of each bar;
* bass   — one note per beat following Am–F–C–G, within E1..G2;
* chords — sustained triads Am F C G (one per bar);
* lead   — a monophonic line in A4..E5 on 8ths.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

SR = 44100
BPM = 124.0
BEAT = 60.0 / BPM
BARS = 8

CHORDS = [  # (bass root midi, triad)
    (33, [57, 60, 64]),  # Am: A1 / A3 C4 E4
    (29, [53, 57, 60]),  # F:  F1 / F3 A3 C4
    (36, [55, 60, 64]),  # C:  C2 / G3 C4 E4
    (31, [55, 59, 62]),  # G:  G1 / G3 B3 D4
]
LEAD = [69, 72, 76, 74, 72, 71, 69, 67]  # A4 C5 E5 D5 C5 B4 A4 G4


@dataclass
class SongTruth:
    kick: list[float]
    snare: list[float]
    hat: list[float]
    open_hat: list[float]
    bass: list[tuple[float, float, int]]
    chords: list[tuple[float, float, list[int]]]
    lead: list[tuple[float, float, int]]


def truth() -> SongTruth:
    kick, snare, hat, open_hat = [], [], [], []
    bass, chords, lead = [], [], []
    for bar in range(BARS):
        root, triad = CHORDS[bar % 4]
        t0 = bar * 4 * BEAT
        chords.append((t0, t0 + 4 * BEAT - 0.02, triad))
        for b in range(4):
            tb = t0 + b * BEAT
            kick.append(tb)
            if b in (1, 3):
                snare.append(tb)
            bass.append((tb, tb + BEAT * 0.8, root + (12 if b == 2 else 0)))
        for e in range(8):
            te = t0 + e * BEAT / 2
            if e == 7:
                open_hat.append(te)
            else:
                hat.append(te)
            lead.append((te, te + BEAT / 2 * 0.9, LEAD[e]))
    return SongTruth(kick, snare, hat, open_hat, bass, chords, lead)


def write_midi(path: Path) -> Path:
    t = truth()
    pm = pretty_midi.PrettyMIDI(initial_tempo=BPM)
    pm.time_signature_changes.append(pretty_midi.TimeSignature(4, 4, 0))
    drums = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    for x in t.kick:
        drums.notes.append(pretty_midi.Note(110, 36, x, x + 0.1))
    for x in t.snare:
        drums.notes.append(pretty_midi.Note(100, 38, x, x + 0.1))
    for x in t.hat:
        drums.notes.append(pretty_midi.Note(80, 42, x, x + 0.05))
    for x in t.open_hat:
        drums.notes.append(pretty_midi.Note(85, 46, x, x + 0.2))
    bass = pretty_midi.Instrument(program=38, name="Synth Bass")
    for s, e, p in t.bass:
        bass.notes.append(pretty_midi.Note(100, p, s, e))
    pad = pretty_midi.Instrument(program=89, name="Warm Pad")
    for s, e, triad in t.chords:
        for p in triad:
            pad.notes.append(pretty_midi.Note(80, p, s, e))
    lead = pretty_midi.Instrument(program=81, name="Saw Lead")
    for s, e, p in t.lead:
        lead.notes.append(pretty_midi.Note(96, p, s, e))
    pm.instruments.extend([lead, pad, bass, drums])
    pm.write(str(path))
    return path


# -- audio rendering (for the stems / transcription path) ---------------------------------

def _env(n: int, attack: float, decay: float) -> np.ndarray:
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t / max(decay, 1e-4))


def _place(buf: np.ndarray, t: float, sig: np.ndarray, gain: float = 1.0) -> None:
    i = int(round(t * SR))
    j = min(len(buf), i + len(sig))
    if i < len(buf):
        buf[i:j] += gain * sig[: j - i]


def _kick() -> np.ndarray:
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t / 0.03)
    phase = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(phase) * np.exp(-t / 0.12)).astype(np.float32)


def _noise(n: int, rng: np.random.Generator) -> np.ndarray:
    return rng.standard_normal(n).astype(np.float32)


def _hp(x: np.ndarray, cutoff: float) -> np.ndarray:
    from scipy.signal import butter, sosfilt

    sos = butter(4, cutoff, btype="highpass", fs=SR, output="sos")
    return sosfilt(sos, x).astype(np.float32)


def _bp(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    from scipy.signal import butter, sosfilt

    sos = butter(2, [lo, hi], btype="bandpass", fs=SR, output="sos")
    return sosfilt(sos, x).astype(np.float32)


def _snare(rng: np.random.Generator) -> np.ndarray:
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)
    noise = _bp(_noise(n, rng), 1500, 9000) * np.exp(-t / 0.09)
    return (0.6 * body + 0.9 * noise).astype(np.float32)


def _hat(rng: np.random.Generator, decay: float, length: float) -> np.ndarray:
    n = int(length * SR)
    t = np.arange(n) / SR
    return (_hp(_noise(n, rng), 7000) * np.exp(-t / decay)).astype(np.float32)


def _tone(freq: float, dur: float, kind: str = "saw") -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    if kind == "sine":
        w = np.sin(2 * np.pi * freq * t)
    else:  # band-limited-ish saw: a few harmonics
        w = sum(np.sin(2 * np.pi * freq * k * t) / k for k in range(1, 7))
    return (w * _env(n, 0.005, dur * 0.8)).astype(np.float32)


def render_stems(out_dir: Path) -> dict[str, Path]:
    """Render drums/bass/chords/lead stems as WAV files named like real stem exports."""
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    t = truth()
    total = int((BARS * 4 * BEAT + 1.0) * SR)
    drums = np.zeros(total, np.float32)
    kick, snare = _kick(), _snare(rng)
    for x in t.kick:
        _place(drums, x, kick, 0.9)
    for x in t.snare:
        _place(drums, x, snare, 0.7)
    for x in t.hat:
        _place(drums, x, _hat(rng, 0.025, 0.08), 0.35)
    for x in t.open_hat:
        _place(drums, x, _hat(rng, 0.2, 0.5), 0.35)

    def midi_hz(p: int) -> float:
        return 440.0 * 2 ** ((p - 69) / 12)

    bass = np.zeros(total, np.float32)
    for s, e, p in t.bass:
        _place(bass, s, _tone(midi_hz(p), e - s, "saw"), 0.4)
    chords = np.zeros(total, np.float32)
    for s, e, triad in t.chords:
        for p in triad:
            _place(chords, s, _tone(midi_hz(p), e - s, "saw"), 0.18)
    lead = np.zeros(total, np.float32)
    for s, e, p in t.lead:
        _place(lead, s, _tone(midi_hz(p), e - s, "saw"), 0.3)

    paths = {}
    for name, sig in (("Drums", drums), ("Bass", bass), ("Other", chords), ("Vocals", lead)):
        peak = float(np.max(np.abs(sig))) or 1.0
        path = out_dir / f"Song ({name}).wav"
        sf.write(str(path), np.stack([sig, sig], axis=1) * (0.8 / peak), SR, subtype="PCM_16")
        paths[name.lower()] = path
    return paths


def write_reference_wav(path: Path, seconds: float = 3.0) -> Path:
    n = int(seconds * SR)
    tt = np.arange(n) / SR
    sig = 0.2 * np.sin(2 * np.pi * 220 * tt).astype(np.float32)
    sf.write(str(path), np.stack([sig, sig], axis=1), SR, subtype="PCM_16")
    return path
