import type { Grid, Part } from '../types'

/** A note in the beat domain (quarter-note beats from beats[0]). */
export interface BNote {
  pitch: number
  start: number
  dur: number
  vel: number
  idx: number
}

const EPS = 1e-9

function spb(grid: Grid) {
  return 60 / (grid.bpm || 120)
}

/** Time (s) of a fractional beat; linear extrapolation outside the grid. Mirrors gridmath.py. */
export function beatTime(grid: Grid, beat: number): number {
  const b = grid.beats
  const n = b.length
  if (n === 0) return beat * spb(grid)
  if (n === 1) return b[0] + beat * spb(grid)
  if (beat <= 0) return b[0] + beat * (b[1] - b[0])
  if (beat >= n - 1) return b[n - 1] + (beat - (n - 1)) * (b[n - 1] - b[n - 2])
  const i = Math.floor(beat)
  return b[i] + (beat - i) * (b[i + 1] - b[i])
}

/** Fractional beat at time t (inverse of beatTime). */
export function timeToBeat(grid: Grid, t: number): number {
  const b = grid.beats
  const n = b.length
  if (n === 0) return t / spb(grid)
  if (n === 1) return (t - b[0]) / spb(grid)
  if (t <= b[0]) return (t - b[0]) / Math.max(EPS, b[1] - b[0])
  if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / Math.max(EPS, b[n - 1] - b[n - 2])
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (b[mid] <= t) lo = mid
    else hi = mid
  }
  return lo + (t - b[lo]) / Math.max(EPS, b[hi] - b[lo])
}

/** Seconds per beat around a beat position (local tempo). */
export function localBeatSec(grid: Grid, beat: number): number {
  return beatTime(grid, beat + 0.5) - beatTime(grid, beat - 0.5)
}

/** Bar index (0 = bar 1) containing a beat; negative for a pickup before bar 1. */
export function barOfBeat(grid: Grid, beat: number): number {
  return Math.floor((beat - grid.firstDownbeat) / grid.barLength + EPS)
}

/**
 * The bar a note belongs to: a note less than a 64th before a bar line (MIDI rounding, a
 * humanised downbeat) is that bar's downbeat. The window stays under a 64th so 32nd and 64th
 * notes at the end of a bar keep their own bar.
 */
export function noteBar(grid: Grid, beat: number): number {
  return barOfBeat(grid, beat + 0.06)
}

/**
 * Does a note starting at `beat` belong to a stretch? The same rule as noteBar: a note less
 * than a 64th before the stretch is its downbeat, one that close to its end is the next one's.
 */
export function inStretch(beat: number, range: { start: number; end: number }): boolean {
  return beat + 0.06 >= range.start - EPS && beat + 0.06 < range.end - EPS
}

export function barStartBeat(grid: Grid, bar: number): number {
  return grid.firstDownbeat + bar * grid.barLength
}

/**
 * Where exported files start so that they land on a DAW bar line: the latest bar line
 * at or before t = 0, counted back from the first downbeat. Mirrors gridmath.export_origin.
 */
export function exportOrigin(grid: Grid): { beat: number; time: number } {
  const bar = grid.barLength || 4
  let k = 0
  while (beatTime(grid, grid.firstDownbeat - k * bar) > 1e-6 && k < 10000) k++
  const beat = grid.firstDownbeat - k * bar
  return { beat, time: beatTime(grid, beat) }
}

export function quantizeBeat(beat: number, stepsPerBeat: number): number {
  if (!stepsPerBeat) return beat
  return Math.round(beat * stepsPerBeat) / stepsPerBeat
}

/** Convert a part's notes to the beat domain, optionally quantized (steps per beat). */
export function partToBeats(part: Part, grid: Grid, stepsPerBeat = 0, offsetSec = 0): BNote[] {
  const out: BNote[] = []
  part.notes.forEach((n, idx) => {
    let start = timeToBeat(grid, n.s + offsetSec)
    let end = timeToBeat(grid, n.e + offsetSec)
    if (stepsPerBeat) {
      start = quantizeBeat(start, stepsPerBeat)
      end = Math.max(start + 1 / stepsPerBeat, quantizeBeat(end, stepsPerBeat))
    }
    out.push({ pitch: n.p, start, dur: Math.max(1e-3, end - start), vel: n.v, idx })
  })
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return out
}

/** First and last bar index that contain notes (inclusive), or null. */
export function barSpan(notes: BNote[], grid: Grid): [number, number] | null {
  if (!notes.length) return null
  let lo = Infinity
  let hi = -Infinity
  for (const n of notes) {
    lo = Math.min(lo, noteBar(grid, n.start))
    hi = Math.max(hi, noteBar(grid, n.start), barOfBeat(grid, n.start + n.dur - 1e-6))
  }
  return [lo, hi]
}

/** A constant-tempo grid with bar 1 at ``downbeatSec`` (used by manual grid edits). */
export function uniformGrid(
  bpm: number,
  downbeatSec: number,
  durationSec: number,
  barLength = 4,
  timeSig: [number, number] = [4, 4],
): Grid {
  const step = 60 / bpm
  const back = Math.floor(downbeatSec / step + 1e-9) // beats that fit before the downbeat
  const first = downbeatSec - back * step
  const beats: number[] = []
  for (let t = first; t <= durationSec + 4 * step; t += step) beats.push(Math.round(t * 1e6) / 1e6)
  return { beats, barLength, timeSig, firstDownbeat: back, bpm: Math.round(bpm * 1000) / 1000, origin: 'manual' }
}

/**
 * Manual grid edits. A new BPM or bar length regenerates a uniform grid anchored at the
 * current downbeat; shifting the downbeat or nudging keeps tracked (non-uniform) beats.
 */
export function editGrid(
  grid: Grid,
  durationSec: number,
  change: { bpm?: number; shiftBeats?: number; nudgeSec?: number; barLength?: number },
): Grid {
  const newTempo = change.bpm !== undefined && Math.abs(change.bpm - grid.bpm) > 1e-6
  const newBar = change.barLength !== undefined && change.barLength !== grid.barLength
  if (newTempo || newBar) {
    const bpm = change.bpm ?? grid.bpm
    const barLength = change.barLength ?? grid.barLength
    const timeSig: [number, number] = newBar ? [Math.round(barLength), 4] : grid.timeSig
    let downbeat = beatTime(grid, grid.firstDownbeat + (change.shiftBeats ?? 0)) + (change.nudgeSec ?? 0)
    const barSec = (60 / bpm) * barLength
    if (downbeat < 0) downbeat += Math.ceil(-downbeat / barSec) * barSec
    return uniformGrid(bpm, downbeat, durationSec, barLength, timeSig)
  }
  const beats = change.nudgeSec ? grid.beats.map((b) => Math.round((b + change.nudgeSec!) * 1e6) / 1e6) : grid.beats
  let fd = grid.firstDownbeat + (change.shiftBeats ?? 0)
  const step = Math.max(1, Math.ceil(grid.barLength))
  while (fd < 0) fd += step
  return { ...grid, beats, firstDownbeat: fd, origin: 'manual' }
}

/** Double (factor 2) or halve (factor 0.5) the tempo, keeping tracked beat timing. */
export function scaleGrid(grid: Grid, factor: 2 | 0.5): Grid {
  const b = grid.beats
  if (factor === 2) {
    const beats: number[] = []
    for (let i = 0; i < b.length; i++) {
      beats.push(b[i])
      if (i + 1 < b.length) beats.push((b[i] + b[i + 1]) / 2)
    }
    return { ...grid, beats, firstDownbeat: grid.firstDownbeat * 2, bpm: grid.bpm * 2, origin: 'manual' }
  }
  const parity = grid.firstDownbeat % 2
  const beats = b.filter((_, i) => i % 2 === parity)
  return { ...grid, beats, firstDownbeat: Math.floor(grid.firstDownbeat / 2), bpm: grid.bpm / 2, origin: 'manual' }
}
