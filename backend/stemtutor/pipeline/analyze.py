"""Beat grid from audio: beat tracking, tempo regularisation and downbeat phase."""

from __future__ import annotations

import math
from pathlib import Path

import librosa
import numpy as np

from ..schemas import Grid
from .audio import load_mono

SR = 22050
HOP = 512


def _band_onset(y: np.ndarray, fmin: float, fmax: float) -> np.ndarray:
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    band = (freqs >= fmin) & (freqs <= fmax)
    L = np.log1p(100 * S[band])
    flux = np.maximum(0.0, np.diff(L, axis=1, prepend=L[:, :1])).sum(axis=0)
    return flux / (flux.max() + 1e-9)


def _snap_bpm(bpm: float, n_beats: int) -> float | None:
    """An integer or half-integer tempo, if it explains the beats as well (< 15 ms drift)."""
    for cand in (round(bpm), round(bpm * 2) / 2):
        if cand > 0 and n_beats * abs(60 / bpm - 60 / cand) < 0.015:
            return float(cand)
    return None


def _regularize(beats: np.ndarray, duration: float) -> tuple[np.ndarray, float, bool]:
    """Fit a constant tempo; return (beats, bpm, steady). Unsteady music keeps tracked beats."""
    idx = np.arange(len(beats))
    slope, intercept = np.polyfit(idx, beats, 1)
    resid = beats - (slope * idx + intercept)
    steady = float(np.std(resid)) < 0.03 and 0.2 < slope < 2.0
    bpm = 60.0 / slope
    if not steady:
        # Extend tracked beats to cover the whole duration with the local period.
        period0 = float(np.median(np.diff(beats[:8]))) if len(beats) > 2 else slope
        period1 = float(np.median(np.diff(beats[-8:]))) if len(beats) > 2 else slope
        head = []
        t = beats[0] - period0
        while t >= -1e-6:
            head.insert(0, t)
            t -= period0
        tail = []
        t = beats[-1] + period1
        while t <= duration + 2 * period1:
            tail.append(t)
            t += period1
        return np.concatenate([head, beats, tail]), round(float(bpm), 2), False
    snapped = _snap_bpm(bpm, len(beats))
    # A snapped tempo is exact. Otherwise build the grid from the fitted period itself and
    # round only the BPM shown: a grid from 123.46 instead of 123.456 drifts ±10 ms in 10 min.
    period = 60.0 / snapped if snapped else float(slope)
    bpm = snapped if snapped else round(float(bpm), 2)
    phase = float(np.mean(beats - period * idx))  # least squares with fixed slope
    k0 = -math.floor(phase / period)
    first = phase + k0 * period
    n = int(math.ceil((duration + 2 * period - first) / period)) + 1
    return first + period * np.arange(n), bpm, True


def _per_beat_peak(env: np.ndarray, beats: np.ndarray, hop: int = HOP) -> np.ndarray:
    """Max of an envelope within ±40 ms of each beat (beat-tracking jitter)."""
    times = librosa.frames_to_time(np.arange(len(env)), sr=SR, hop_length=hop)
    out = np.zeros(len(beats))
    for k, b in enumerate(beats):
        lo = np.searchsorted(times, b - 0.04)
        hi = np.searchsorted(times, b + 0.04) + 1
        if lo < len(env) and hi > lo:
            out[k] = float(env[lo:hi].max())
    return out / (out.max() + 1e-9)


def _chroma_novelty(y: np.ndarray, beats: np.ndarray) -> np.ndarray:
    """1 − cosine similarity of beat-synchronous chroma with the previous beat: chord and
    bass-note changes, which mostly happen on downbeats."""
    C = librosa.feature.chroma_stft(y=y, sr=SR, hop_length=HOP, n_fft=4096)
    frames = librosa.time_to_frames(beats, sr=SR, hop_length=HOP)
    cols = []
    for k in range(len(beats)):
        a = int(frames[k])
        b = int(frames[k + 1]) if k + 1 < len(frames) else a + max(1, int(frames[1] - frames[0]) if len(frames) > 1 else 8)
        seg = C[:, a : max(a + 1, b)] if a < C.shape[1] else np.zeros((12, 1))
        cols.append(np.median(seg, axis=1) if seg.size else np.zeros(12))
    cols = np.asarray(cols)
    norm = np.linalg.norm(cols, axis=1) + 1e-9
    nov = np.zeros(len(beats))
    for k in range(1, len(beats)):
        nov[k] = 1 - float(np.dot(cols[k], cols[k - 1]) / (norm[k] * norm[k - 1]))
    return nov / (nov.max() + 1e-9)


def _bar_novelty(y: np.ndarray, beats: np.ndarray, beats_per_bar: int = 4) -> np.ndarray:
    """For each phase: mean chroma change between consecutive bar-long windows.

    Windows aligned with real bars each hold one chord, so consecutive windows differ;
    misaligned windows straddle two chords and look alike. A melody that repeats every bar
    gives identical windows for any phase, so it cannot bias the result (unlike beat-level
    novelty, where a lead line changing every 8th dominates).
    """
    C = librosa.feature.chroma_stft(y=y, sr=SR, hop_length=HOP, n_fft=4096)
    # A beat a few ms before zero maps to frame -1, which would slice from the end.
    frames = np.clip(librosa.time_to_frames(beats, sr=SR, hop_length=HOP), 0, C.shape[1])
    out = np.zeros(beats_per_bar)
    for ph in range(beats_per_bar):
        cols = []
        for k in range(ph, len(frames) - beats_per_bar, beats_per_bar):
            a, b = int(frames[k]), int(frames[k + beats_per_bar])
            if b > a:
                cols.append(C[:, a:b].mean(axis=1))
        if len(cols) < 3:
            continue
        cols = np.asarray(cols)
        norm = np.linalg.norm(cols, axis=1) + 1e-9
        sims = np.sum(cols[1:] * cols[:-1], axis=1) / (norm[1:] * norm[:-1])
        out[ph] = float(np.mean(1 - sims))
    out = np.nan_to_num(out)
    return out / (out.max() + 1e-9)


def _downbeat_phase(per_beat: dict[str, np.ndarray], per_phase: dict[str, np.ndarray], beats_per_bar: int = 4) -> int:
    """Phase (0..bpb-1) maximising bar-aligned harmonic/bass change and kick, penalising
    snares (backbeats are on 2 and 4)."""
    weights = {"harm": 1.0, "bass": 0.8, "kick": 0.25, "snare": -0.5}
    total = np.zeros(beats_per_bar)
    for key, vals in per_beat.items():
        for ph in range(beats_per_bar):
            sel = vals[ph::beats_per_bar]
            if sel.size:
                total[ph] += weights[key] * float(sel.mean())
    for key, vals in per_phase.items():
        total += weights[key] * vals
    return int(np.argmax(total))


def _fine_onsets(y: np.ndarray) -> np.ndarray:
    """Percussive attack times at ~6 ms resolution (padded so t = 0 can be found)."""
    pad = int(0.1 * SR)
    yp = np.concatenate([np.zeros(pad, dtype=y.dtype), y])
    env = librosa.onset.onset_strength(y=yp, sr=SR, hop_length=128)
    on = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=128, backtrack=True, units="time")
    return np.asarray(on, dtype=float) - 0.1


def _refine_phase(beats: np.ndarray, onsets: np.ndarray) -> np.ndarray:
    """Shift the grid by the median offset to the nearest attacks (beat trackers lag)."""
    if onsets.size < 8:
        return beats
    offs = []
    for b in beats:
        i = np.searchsorted(onsets, b)
        cands = [onsets[j] - b for j in (i - 1, i) if 0 <= j < len(onsets)]
        if cands:
            d = min(cands, key=abs)
            if abs(d) < 0.07:
                offs.append(d)
    if len(offs) < max(8, 0.3 * len(beats)):
        return beats
    return beats + float(np.median(offs))


def align_grid_to_hits(grid: Grid, hit_times: list[float], max_dev: float = 0.06) -> Grid | None:
    """Shift a tracked grid so it sits on the transcribed on-beat kicks.

    Beat trackers and separated stems smear attacks by 10–20 ms; the drum transcriber is
    compensated to true attack times, so the median offset of kicks that fall within
    ±60 ms of a beat is the best estimate of the grid's phase error. Returns None when there
    is not enough evidence or the shift is negligible.
    """
    if grid.origin != "tracked" or len(hit_times) < 16 or len(grid.beats) < 8:
        return None
    beats = np.asarray(grid.beats)
    offs = []
    for t in hit_times:
        i = int(np.searchsorted(beats, t))
        cands = [t - beats[j] for j in (i - 1, i) if 0 <= j < len(beats)]
        if cands:
            d = min(cands, key=abs)
            if abs(d) <= max_dev:
                offs.append(d)
    if len(offs) < 12:
        return None
    shift = float(np.median(offs))
    if abs(shift) < 0.003:
        return None
    return grid.model_copy(update={"beats": [round(float(b + shift), 6) for b in beats]})


def analyze_grid(
    mix_wav: Path,
    drums_wav: Path | None,
    bass_wav: Path | None,
    duration: float,
    harmonic_wav: Path | None = None,
) -> Grid:
    src = drums_wav or mix_wav
    y, _ = load_mono(src, SR)
    if duration <= 0:
        duration = len(y) / SR
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median)
    tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, trim=False)
    beats = librosa.frames_to_time(np.asarray(frames), sr=SR, hop_length=HOP)
    if len(beats) < 8:
        bpm = float(np.atleast_1d(tempo)[0]) or 120.0
        period = 60.0 / bpm
        onsets = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=HOP, units="time")
        first = float(onsets[0]) if len(onsets) else 0.0
        first -= math.floor(first / period) * period
        n = int(math.ceil((duration + 2 * period - first) / period)) + 1
        grid_beats, steady = first + period * np.arange(n), True
        bpm = round(bpm, 2)
    else:
        grid_beats, bpm, steady = _regularize(beats, duration)
    if steady:
        grid_beats = _refine_phase(grid_beats, _fine_onsets(y))
        # Keep a beat that the shift moved a hair before zero; drop only real pre-roll.
        period = 60.0 / bpm
        while len(grid_beats) and grid_beats[0] < -0.5 * period:
            grid_beats = grid_beats[1:]

    phase = 0
    inside = grid_beats[grid_beats < duration]
    if len(inside) >= 8:
        per_beat: dict[str, np.ndarray] = {}
        per_phase: dict[str, np.ndarray] = {}
        if drums_wav is not None:
            yd = load_mono(drums_wav, SR)[0]
            per_beat["kick"] = _per_beat_peak(_band_onset(yd, 30, 150), inside)
            per_beat["snare"] = _per_beat_peak(_band_onset(yd, 1500, 6000), inside)
        else:
            per_beat["kick"] = _per_beat_peak(_band_onset(y, 30, 150), inside)
        if bass_wav is not None:
            per_phase["bass"] = _bar_novelty(load_mono(bass_wav, SR)[0], inside)
        harm_src = harmonic_wav or (mix_wav if drums_wav is None else None)
        if harm_src is not None:
            per_phase["harm"] = _bar_novelty(load_mono(harm_src, SR)[0], inside)
        phase = _downbeat_phase(per_beat, per_phase)
    return Grid(
        beats=[round(float(b), 6) for b in grid_beats],
        barLength=4.0,
        timeSig=(4, 4),
        firstDownbeat=phase,
        bpm=bpm,
        origin="tracked",
    )
