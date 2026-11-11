/** Transport sources: metronome and synth playback of note lists (song time in seconds). */
import type { Grid } from '../types'
import { beatTime, timeToBeat } from '../music/grid'
import type { ScheduleFn } from './engine'
import { playClick, playDrum, playNote, type SynthPreset } from './synth'

/** `enabled(t)` is asked per click (song time), so a count-in can stop exactly at the start
 * even though clicks are scheduled ahead. */
export function metronomeSource(grid: Grid, opts: { enabled: (t: number) => boolean; gain?: () => number }): ScheduleFn {
  return (from, to, tr) => {
    const b0 = Math.ceil(timeToBeat(grid, from) - 1e-9)
    const b1 = timeToBeat(grid, to)
    for (let b = b0; b < b1; b++) {
      const t = beatTime(grid, b)
      if (t < from - 1e-6 || t >= to || !opts.enabled(t)) continue
      const rel = (((b - grid.firstDownbeat) % grid.barLength) + grid.barLength) % grid.barLength
      playClick(tr.ctxTime(t), rel < 1e-6, { gain: opts.gain?.() ?? 1 })
    }
  }
}

export interface TimedNote {
  s: number // song seconds
  e: number
  pitch: number
  vel: number
  drum?: boolean
}

export function notesSource(
  notes: TimedNote[],
  opts: { preset: SynthPreset; enabled: () => boolean; gain?: () => number },
): ScheduleFn {
  const sorted = notes.slice().sort((a, b) => a.s - b.s)
  return (from, to, tr) => {
    if (!opts.enabled() || !sorted.length) return
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid].s < from) lo = mid + 1
      else hi = mid
    }
    const g = opts.gain?.() ?? 1
    for (let i = lo; i < sorted.length && sorted[i].s < to; i++) {
      const n = sorted[i]
      const when = tr.ctxTime(n.s)
      if (n.drum) playDrum(n.pitch, when, n.vel, { gain: g })
      else playNote(n.pitch, when, (n.e - n.s) / tr.rate, n.vel, opts.preset, { gain: g })
    }
  }
}
