"""Note transcription of melodic stems with Spotify basic-pitch (ONNX model, no TensorFlow)."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..schemas import Note, Role

log = logging.getLogger("stemtutor.melodic")
_LOCK = threading.Lock()
_MODEL = None


@dataclass(frozen=True)
class RoleParams:
    onset: float
    frame: float
    min_len_ms: float
    fmin: float
    fmax: float
    mono: bool
    min_amp: float
    max_poly: int = 6
    low_pitch: int = 21
    high_pitch: int = 108


PARAMS: dict[str, RoleParams] = {
    "bass": RoleParams(onset=0.45, frame=0.3, min_len_ms=70, fmin=27, fmax=440, mono=True, min_amp=0.12, high_pitch=67),
    "vocal": RoleParams(onset=0.5, frame=0.35, min_len_ms=90, fmin=70, fmax=1400, mono=True, min_amp=0.15),
    "melody": RoleParams(onset=0.5, frame=0.3, min_len_ms=70, fmin=80, fmax=3200, mono=True, min_amp=0.15),
    "chords": RoleParams(onset=0.45, frame=0.3, min_len_ms=80, fmin=40, fmax=4200, mono=False, min_amp=0.12),
    "other": RoleParams(onset=0.45, frame=0.3, min_len_ms=80, fmin=40, fmax=4200, mono=False, min_amp=0.12),
}


def _model():
    global _MODEL
    with _LOCK:
        if _MODEL is None:
            root = logging.getLogger()
            level = root.level
            root.setLevel(logging.ERROR)  # basic-pitch warns about every missing backend
            try:
                from basic_pitch import ICASSP_2022_MODEL_PATH
                from basic_pitch.inference import Model
            finally:
                root.setLevel(level)
            _MODEL = Model(ICASSP_2022_MODEL_PATH)
        return _MODEL


@dataclass
class _N:
    s: float
    e: float
    p: int
    a: float


def _merge_fragments(notes: list[_N], gap: float = 0.04) -> list[_N]:
    """Join same-pitch notes split by a tiny gap (common on sustained synths)."""
    by_pitch: dict[int, list[_N]] = {}
    for n in sorted(notes, key=lambda x: x.s):
        lst = by_pitch.setdefault(n.p, [])
        if lst and n.s - lst[-1].e <= gap:
            lst[-1].e = max(lst[-1].e, n.e)
            lst[-1].a = max(lst[-1].a, n.a)
        else:
            lst.append(_N(n.s, n.e, n.p, n.a))
    return sorted((n for lst in by_pitch.values() for n in lst), key=lambda x: (x.s, x.p))


HARMONIC_INTERVALS = {12, 19, 24, 28, 31, 34, 36}


def _overlap(a: _N, b: _N) -> float:
    return max(0.0, min(a.e, b.e) - max(a.s, b.s))


def _drop_harmonic_ghosts(notes: list[_N], ratio: float = 0.62) -> list[_N]:
    """Remove overtones reported as notes: a note a harmonic interval above a clearly louder
    note that covers most of it. Real octave doublings are about as loud and survive."""
    keep = []
    for n in notes:
        dur = max(1e-3, n.e - n.s)
        ghost = any(
            (n.p - m.p) in HARMONIC_INTERVALS and m.a * ratio > n.a and _overlap(n, m) >= 0.5 * dur
            for m in notes
            if m is not n
        )
        if not ghost:
            keep.append(n)
    return keep


PAD_SEC = 0.1


def stem_onsets(wav: Path, role: Role) -> np.ndarray:
    """Attack times of the stem itself, backtracked to the energy rise.

    The audio is padded with silence so an attack at t = 0 is found, and every onset must
    show rising energy — the click of a note being cut off is not an attack.
    """
    import librosa

    from .audio import load_mono

    y, sr = load_mono(wav, 22050)
    if y.size < 4096:
        return np.array([])
    pad = int(PAD_SEC * sr)
    y = np.concatenate([np.zeros(pad, dtype=y.dtype), y])
    hop = 128
    fmax = 1200 if role == "bass" else 8000
    S = librosa.feature.melspectrogram(y=y, sr=sr, n_fft=2048, hop_length=hop, n_mels=64, fmax=fmax)
    env = librosa.onset.onset_strength(S=librosa.power_to_db(S, ref=np.max), sr=sr, hop_length=hop)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=True)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
    win = max(1, int(0.04 * sr / hop))
    keep = []
    for f in frames:
        before = float(rms[max(0, f - win) : f].mean()) if f > 0 else 0.0
        after = float(rms[f : f + win].max()) if f < len(rms) else 0.0
        if after >= 1.25 * before + 1e-4:
            keep.append(f)
    times = librosa.frames_to_time(np.asarray(keep, dtype=int), sr=sr, hop_length=hop) - PAD_SEC
    return np.asarray([t for t in times if t >= -0.02], dtype=float).clip(min=0.0)


CQT_SR = 22050
CQT_HOP = 256
CQT_LOW = 21  # A0: bin 0 of the per-semitone magnitudes


def pitch_magnitudes(wav: Path) -> np.ndarray:
    """|CQT| with one bin per semitone (A0..C8): how loud each pitch is, frame by frame."""
    import librosa

    from .audio import load_mono

    y, sr = load_mono(wav, CQT_SR)
    return np.abs(
        librosa.cqt(y, sr=sr, hop_length=CQT_HOP, fmin=librosa.midi_to_hz(CQT_LOW), n_bins=88, bins_per_octave=12)
    )


def _reattacked(mag: np.ndarray, pitch: int, t: float, w: int = 4) -> bool:
    """Is `pitch` itself struck again at time t? Its own energy jumps (>= 1.3x) right after t
    compared with just before; a held note under someone else's attack does not."""
    b = pitch - CQT_LOW
    f = int(round(t * CQT_SR / CQT_HOP))
    if not 0 <= b < mag.shape[0] or f >= mag.shape[1]:
        return False
    row = mag[b]
    before = float(row[max(0, f - 2 * w) : max(1, f - w // 2)].mean())
    after = float(row[f : f + w + 1].max())
    return after >= 1.3 * before + 1e-6


def _snap_to_onsets(
    notes: list[_N],
    onsets: np.ndarray,
    mono: bool,
    min_len: float,
    pitch_mag: np.ndarray | None = None,
    heard: dict[int, np.ndarray] | None = None,
) -> list[_N]:
    """basic-pitch is late on low notes and merges repeated notes; the stem's own onsets fix
    the starts and split long notes at new attacks. In one-voice parts every attack inside a
    note is a re-strike.

    In chord parts an attack splits a held note only if that very pitch is struck again:
    basic-pitch itself heard the pitch start there (`heard`, before fragments were merged),
    the pitch's own energy jumps (not a melody in the same stem over a held chord, nor the
    level beating of a detuned pad), and either other notes start too (a chord change) or
    every held tone is re-struck (a repeated chord — a clap or hat bleed lifts only some).
    Without pitch magnitudes (tests), an attack counts where other notes start too."""
    if onsets.size == 0:
        return notes
    snapped: list[_N] = []
    for n in notes:
        cand = onsets[(onsets >= n.s - 0.15) & (onsets <= n.s + 0.04)]
        if cand.size:
            s = float(cand[np.argmin(np.abs(cand - n.s))])
            if s < n.e - min_len * 0.5:
                n = _N(s, n.e, n.p, n.a)
        snapped.append(n)
    starts = np.array(sorted(n.s for n in snapped))
    heard = heard or {}
    chord_ok: dict[float, bool] = {}

    def restruck(n: _N, o: float) -> bool:
        hs = heard.get(n.p)
        if hs is None or not np.any(np.abs(hs - o) < 0.05):
            return False
        if not _reattacked(pitch_mag, n.p, o):
            return False
        if np.any(np.abs(starts - o) < 0.03):
            return True
        if o not in chord_ok:
            held = [m for m in snapped if m.s < o - 0.03 and m.e > o + 0.03]
            chord_ok[o] = all(_reattacked(pitch_mag, m.p, o) for m in held)
        return chord_ok[o]

    out: list[_N] = []
    for n in snapped:
        inner = onsets[(onsets > n.s + max(0.08, min_len)) & (onsets < n.e - 0.06)]
        if not mono:
            if pitch_mag is not None:
                inner = np.array([o for o in inner if restruck(n, float(o))])
            else:
                inner = np.array([o for o in inner if np.any(np.abs(starts - o) < 0.03)])
        start = n.s
        for o in inner:
            out.append(_N(start, float(o) - 0.005, n.p, n.a))
            start = float(o)
        out.append(_N(start, n.e, n.p, n.a))
    return out


def _monophonic(notes: list[_N], min_len: float, prefer_low: bool) -> list[_N]:
    """One note at a time. Overlaps resolve to the stronger note; for bass the lower note
    wins unless the upper one is clearly louder (overtones of the fundamental)."""
    out: list[_N] = []
    for n in sorted(notes, key=lambda x: (x.s, x.p)):
        if not out or n.s >= out[-1].e - 1e-3:
            out.append(n)
            continue
        cur = out[-1]
        stronger = n.a > cur.a * 1.15
        if prefer_low and n.p != cur.p:
            stronger = n.a > cur.a * 1.6 if n.p > cur.p else n.a > cur.a * 0.5
        if stronger:
            if n.s - cur.s >= min_len:
                cur.e = n.s
            else:
                out.pop()
            out.append(n)
        elif n.e - cur.e >= min_len:
            out.append(_N(cur.e, n.e, n.p, n.a))
    return [n for n in out if n.e - n.s >= min_len * 0.8]


def _limit_polyphony(notes: list[_N], max_poly: int) -> list[_N]:
    keep: list[_N] = []
    for n in sorted(notes, key=lambda x: -x.a):
        overlapping = sum(1 for k in keep if k.s < n.e and n.s < k.e)
        if overlapping < max_poly:
            keep.append(n)
    return sorted(keep, key=lambda x: (x.s, x.p))


def clean_notes(
    raw: list[tuple[float, float, int, float]],
    role: Role,
    onsets: np.ndarray | None = None,
    pitch_mag: np.ndarray | None = None,
) -> list[Note]:
    prm = PARAMS.get(role, PARAMS["other"])
    min_len = prm.min_len_ms / 1000
    notes = [
        _N(float(s), float(e), int(p), float(a))
        for s, e, p, a in raw
        if a >= prm.min_amp and prm.low_pitch <= p <= prm.high_pitch and e - s >= min_len * 0.6
    ]
    notes = _drop_harmonic_ghosts(notes)
    heard: dict[int, list[float]] = {}  # where basic-pitch itself started each pitch
    for n in notes:
        heard.setdefault(n.p, []).append(n.s)
    notes = _merge_fragments(notes)
    if onsets is not None:
        notes = _snap_to_onsets(
            notes, onsets, mono=prm.mono, min_len=min_len, pitch_mag=pitch_mag,
            heard={p: np.asarray(v) for p, v in heard.items()},
        )
    if prm.mono:
        notes = _monophonic(notes, min_len, prefer_low=role == "bass")
    else:
        notes = [n for n in notes if n.e - n.s >= min_len]
        notes = _limit_polyphony(notes, prm.max_poly)
    return [
        Note(p=n.p, s=round(n.s, 4), e=round(n.e, 4), v=int(max(20, min(127, round(35 + n.a * 110)))))
        for n in notes
    ]


def transcribe_melodic(wav: Path, role: Role) -> list[Note]:
    from basic_pitch.inference import predict

    prm = PARAMS.get(role, PARAMS["other"])
    _, _, events = predict(
        str(wav),
        _model(),
        onset_threshold=prm.onset,
        frame_threshold=prm.frame,
        minimum_note_length=prm.min_len_ms,
        minimum_frequency=prm.fmin,
        maximum_frequency=prm.fmax,
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    raw = [(s, e, p, a) for (s, e, p, a, *_rest) in events]
    onsets = pitch_mag = None
    try:
        onsets = stem_onsets(wav, role)
        if not prm.mono:
            pitch_mag = pitch_magnitudes(wav)
    except Exception:  # onset refinement is an improvement, never a requirement
        log.exception("onset detection failed for %s", wav.name)
    notes = clean_notes(raw, role, onsets, pitch_mag)
    log.info("transcribed %s (%s): %d raw -> %d notes", wav.name, role, len(raw), len(notes))
    return notes
