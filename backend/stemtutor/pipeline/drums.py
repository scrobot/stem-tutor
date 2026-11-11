"""Drum transcription of a drum stem into General MIDI notes.

Onsets are detected independently in frequency bands (so a kick and a hat on the same
16th are both found) and classified by band and envelope:

* kick       — low band (30–150 Hz) onset with a real energy jump;
* snare/clap — mid-high noise (1.5–6 kHz) that *sustains* ≥ 50 ms (a kick click does not)
               and is not dwarfed by the top band;
* hats       — top band (7–16 kHz); decay length tells closed (42) from open (46); a long,
               loud, broadband tail is a crash (49).
"""

from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

from ..schemas import Note
from .audio import load_mono

SR = 44100
N_FFT = 2048
HOP = 256
FRAME = HOP / SR  # ~5.8 ms
# Centred STFT frames see an attack before it happens: log flux peaks ~18 ms early; the
# hat detector (which also uses linear amplitude flux) peaks a little later.
ONSET_LAG = 0.018
HAT_LAG = 0.008

BANDS = {
    "low": (30.0, 150.0),
    "mid": (180.0, 1200.0),
    "noise": (1500.0, 6000.0),
    "high": (7000.0, 16000.0),
}


def _band_levels(S: np.ndarray, freqs: np.ndarray) -> dict[str, np.ndarray]:
    out = {}
    for name, (lo, hi) in BANDS.items():
        sel = (freqs >= lo) & (freqs < hi)
        out[name] = 10 * np.log10(np.sum(S[sel] ** 2, axis=0) + 1e-10)
    return out


def _band_flux(logS: np.ndarray, freqs: np.ndarray, lo: float, hi: float) -> np.ndarray:
    sel = (freqs >= lo) & (freqs < hi)
    # Prepend silence so a hit in the very first frame still counts as an onset.
    d = np.diff(logS[sel], axis=1, prepend=np.zeros((int(sel.sum()), 1)))
    return np.maximum(0.0, d).mean(axis=0)


def _median_norm(f: np.ndarray, wait_frames: int) -> np.ndarray:
    if f.max() <= 0:
        return f
    cand = _pick(f, 0.08 * float(f.max()), wait_frames)
    ref = float(np.median(f[cand])) if cand.size else float(f.max())
    return f / (ref + 1e-12)


def _detection(S: np.ndarray, logS: np.ndarray, freqs: np.ndarray, lo: float, hi: float, wait_frames: int) -> np.ndarray:
    """Onset detection function robust to ringing tails.

    Log flux is level-independent but shrinks when a hit lands on the tail of a previous
    one (an open hat, a snare); the linear amplitude increase does not. Each is normalised
    to its typical hit and the larger one wins.
    """
    log_flux = _band_flux(logS, freqs, lo, hi)
    sel = (freqs >= lo) & (freqs < hi)
    amp = np.sqrt(np.sum(S[sel] ** 2, axis=0))
    lin_flux = np.maximum(0.0, np.diff(amp, prepend=0.0))
    return np.maximum(_median_norm(log_flux, wait_frames), _median_norm(lin_flux, wait_frames))


def _pick(flux: np.ndarray, delta: float, wait_frames: int) -> np.ndarray:
    """Peaks above the local mean + delta, keeping the *strongest* peak within `wait_frames`.

    librosa's picker is greedy (first peak wins, the next `wait` frames are ignored). Stems
    from source separation carry a weak pre-echo ~40 ms before an attack, so the greedy pick
    lands on the echo and drops the real hit; non-maximum suppression keeps the real one.
    """
    idx = librosa.util.peak_pick(flux, pre_max=3, post_max=3, pre_avg=12, post_avg=12, delta=delta, wait=0)
    keep: list[int] = []
    for i in sorted((int(i) for i in idx), key=lambda i: -flux[i]):
        if all(abs(i - k) > wait_frames for k in keep):
            keep.append(i)
    return np.asarray(sorted(keep), dtype=int)


def _peaks(flux: np.ndarray, rel: float, wait_frames: int) -> np.ndarray:
    """Two-pass peak picking relative to the *typical* hit: candidates with a low bar first,
    then the bar is set from their median, so stacked hits (kick+snare+hat) do not hide
    single hats."""
    if flux.max() <= 0:
        return np.array([], dtype=int)
    cand = _pick(flux, 0.08 * float(flux.max()), wait_frames)
    if cand.size == 0:
        return cand
    ref = float(np.median(flux[cand]))
    return _pick(flux, rel * ref, wait_frames)


def _decay_frames(level: np.ndarray, i: int, drop_db: float, max_frames: int) -> int:
    peak = level[i : i + 4].max() if i < len(level) else level[-1]
    end = min(len(level), i + max_frames)
    for j in range(i + 1, end):
        if level[j] < peak - drop_db:
            return j - i
    return end - i


def _velocity(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return values.astype(int)
    hi = np.percentile(values, 95) or values.max() or 1.0
    return np.clip(np.round(45 + 82 * (values / hi)), 30, 127).astype(int)


def _cymbal_note(lv: dict[str, np.ndarray], top: dict[str, float], i: int, crash_after: float) -> int:
    j = min(len(lv["high"]) - 1, i + 2)
    decay = _decay_frames(lv["high"], i, 12.0, int(1.5 / FRAME)) * FRAME
    if decay > crash_after and lv["noise"][j] >= top["noise"] - 12:
        return 49
    return 46 if decay > 0.15 else 42


def transcribe_drums(wav: Path) -> list[Note]:
    y, _ = load_mono(wav, SR)
    if y.size < N_FFT or float(np.max(np.abs(y))) < 1e-4:
        return []
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=N_FFT)
    logS = np.log1p(1000 * S)
    lv = _band_levels(S, freqs)
    top = {k: float(np.percentile(v, 99.5)) for k, v in lv.items()}
    wait = int(0.045 / FRAME)

    hits: list[tuple[float, int, float]] = []  # (time, gm note, strength)

    # Kick candidates; decided once the snares are known (below).
    f_low = _band_flux(logS, freqs, *BANDS["low"])
    n_frames = len(f_low)
    kick_cands: list[tuple[int, float, float]] = []  # (frame, low-band level, body change)
    for i in _peaks(f_low, 0.25, wait):
        j = min(n_frames - 1, i + 3)
        # Before the track starts there is silence: a kick at 0:00 has no earlier frame to compare.
        jump = lv["low"][j] - (lv["low"][i - 3] if i >= 3 else -100.0)
        if jump >= 6 and lv["low"][j] >= top["low"] - 28:
            if i < 3 and lv["low"][i + 5 : i + int(0.5 / FRAME)].min(initial=np.inf) > lv["low"][j] - 6:
                continue  # low sound already playing at 0:00 (bass bleed, a held tone), not a hit
            body = lv["low"][min(n_frames - 1, i + 8)] - lv["low"][j]  # ~30 ms after the attack
            kick_cands.append((int(i), float(lv["low"][j]), float(body)))

    # Snare / clap: sustained mid-high noise.
    f_noise = _band_flux(logS, freqs, *BANDS["noise"])
    f_mid = _band_flux(logS, freqs, *BANDS["mid"])
    snare_frames = []
    for i in _peaks(f_noise + 0.5 * f_mid, 0.3, wait):
        j = min(len(f_noise) - 1, i + 3)
        level = lv["noise"][j]
        if level < top["noise"] - 24:
            continue
        sustain = lv["noise"][min(len(f_noise) - 1, i + int(0.05 / FRAME))] - level
        dominance = lv["noise"][j] - lv["high"][j]
        if sustain >= -12 and dominance >= -10:
            snare_frames.append(i)
            hits.append((i * FRAME, 38, float(f_noise[i])))

    # A snare's body leaks into the kick band at its attack. Next to a snare, keep a kick only
    # if its low end holds up after the attack (a kick's body rings on, the snare's leakage
    # dies at once; a very short kick at full kick level still counts) and it is about as loud
    # as the kicks of the same passage (±4 s, so soft intros, fades and build-ups are judged
    # against their own kicks).
    def near_snare(i: int) -> bool:
        return any(abs(i - s) <= 3 for s in snare_frames)

    lone = [(i, lvl) for i, lvl, _ in kick_cands if not near_snare(i)]
    pool = [lvl for _, lvl in lone] or [lvl for _, lvl, _ in kick_cands]
    global_ref = float(np.median(pool)) if pool else top["low"]
    ref_pts = sorted(lone + [(i, lvl) for i, lvl, body in kick_cands if near_snare(i) and body >= -6])
    ref_i = np.array([i for i, _ in ref_pts], dtype=int)
    ref_l = np.array([lvl for _, lvl in ref_pts], dtype=float)
    span = int(4.0 / FRAME)
    for i, lvl, body in kick_cands:
        if near_snare(i):
            if body < -6 and lvl < top["low"] - 6:
                continue
            a, b = np.searchsorted(ref_i, [i - span, i + span + 1])
            ref = float(np.median(ref_l[a:b])) if b - a >= 3 else global_ref
            if lvl < ref - 12:
                continue
        hits.append((i * FRAME, 36, float(f_low[i])))

    # Hats / cymbals: hats often land on ringing tails, so use the tail-robust detector.
    hat_wait = int(0.04 / FRAME)
    f_high = _detection(S, logS, freqs, *BANDS["high"], hat_wait)
    sel_vh = (freqs >= 10000) & (freqs < 16000)
    vhigh = 10 * np.log10(np.sum(S[sel_vh] ** 2, axis=0) + 1e-10)
    pure_hat_vh: list[float] = []
    under_snare: list[tuple[int, float]] = []
    for i in _pick(f_high, 0.3, hat_wait):
        j = min(len(f_high) - 1, i + 2)
        if lv["high"][j] < top["high"] - 26:
            continue
        if any(abs(i - s) <= 3 for s in snare_frames):
            under_snare.append((i, float(vhigh[j])))  # decide below: snare top end or a real hat
            continue
        pure_hat_vh.append(float(vhigh[j]))
        hits.append((i * FRAME, _cymbal_note(lv, top, i, crash_after=0.6), float(f_high[i])))
    # A hat under a snare shows up as top-octave (10–16 kHz) energy comparable to the
    # track's own lone hats; a bare snare is noticeably darker up there.
    if pure_hat_vh:
        hat_level = float(np.median(pure_hat_vh))
        for i, vh in under_snare:
            if vh >= hat_level - 3:
                # The snare's own tail hides an open hat's ring, so only a crash (which rings far
                # longer than any snare) is told apart here; otherwise it is a closed hat. The hit
                # must lift the top band itself — a hat under a still-ringing crash does not.
                j = min(len(lv["high"]) - 1, i + 2)
                rise = lv["high"][j] - lv["high"][max(0, i - 3)]
                crash = rise >= 10 and _cymbal_note(lv, top, i, crash_after=0.6) == 49
                note = 49 if crash else 42
                hits.append((i * FRAME, note, float(f_high[i])))

    if not hits:
        return []
    hits.sort()
    notes: list[Note] = []
    for gm in sorted({h[1] for h in hits}):
        sel = [h for h in hits if h[1] == gm]
        vel = _velocity(np.array([h[2] for h in sel]))
        dur = 0.1 if gm in (36, 38, 42) else 0.25
        lag = ONSET_LAG if gm in (36, 38) else HAT_LAG
        for (t, _, _), v in zip(sel, vel):
            t = max(0.0, t + lag)
            notes.append(Note(p=gm, s=round(t, 4), e=round(t + dur, 4), v=int(v)))
    notes.sort(key=lambda n: (n.s, n.p))
    return notes
