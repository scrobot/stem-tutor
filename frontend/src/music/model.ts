/** Builds everything the UI needs for a lesson/part from raw notes + the chosen controller. */
import type { Grid, Lesson, Part } from '../types'
import { effectiveProfile, keyboardSpec, padSpec, type InstrumentProfile } from '../instruments/profiles'
import { arrangeKeys, arrangePads, type Arrangement, type PadOverrides } from './arrange'
import { barSpan, partToBeats, type BNote } from './grid'
import { analyzeBlocks, type PatternAnalysis, type PatternEvent } from './patterns'
import { detectChords, detectKey, type ChordSeg, type KeyInfo } from './theory'

export interface LessonModel {
  key: KeyInfo | null
  chords: ChordSeg[]
  bars: [number, number]
}

export interface PartStats {
  notes: number
  low: number
  high: number
  polyphony: number
  perBar: number
}

export interface PartModel {
  part: Part
  notes: BNote[]
  arrangement: Arrangement
  patterns: PatternAnalysis
  bars: [number, number]
  stats: PartStats
  onPads: boolean
  /** What the pattern analysis ran on, so the block length can change without re-arranging. */
  patternInput: { events: PatternEvent[]; tolerance: number }
}

/**
 * The blocks of one layer of a part (keys), or of its pad hits (`layerIndex` null): what the
 * trainer shows in «Из чего состоит дорожка» and the cover plan lists as loops. One function
 * for both, so their letters and stretches always agree.
 */
export function layerBlocks(model: PartModel, grid: Grid, layerIndex: number | null, unitBars?: number): PatternAnalysis {
  const a = model.arrangement
  const layer = a.kind === 'keys' && layerIndex !== null ? a.layers[layerIndex] : undefined
  const events = layer ? layer.notes.map((n) => ({ start: n.start, target: n.pitch })) : model.patternInput.events
  return analyzeBlocks(events, grid, model.bars[0], model.bars[1], 4, model.patternInput.tolerance, unitBars)
}

export function defaultQuantize(part: Part, lesson: Lesson): number {
  const q = lesson.prefs.quantize
  if (typeof q === 'number') return q
  return part.origin === 'transcribed' ? 4 : 0
}

/** Notes in beats. (prefs.audioOffset moves the reference audio, never the notes.) */
export function partBeats(lesson: Lesson, part: Part): BNote[] {
  if (!lesson.grid) return []
  return partToBeats(part, lesson.grid, defaultQuantize(part, lesson))
}

export function buildLessonModel(lesson: Lesson): LessonModel {
  const grid = lesson.grid
  if (!grid) return { key: null, chords: [], bars: [0, 0] }
  const melodic = lesson.parts.filter((p) => !p.isDrum && !p.silent && p.notes.length)
  const all = melodic.flatMap((p) => partBeats(lesson, p))
  const key = detectKey(all.map((n) => ({ pitch: n.pitch, dur: n.dur, vel: n.vel, start: n.start })))
  const harmonicParts = melodic.filter((p) => p.role === 'chords' || p.role === 'other')
  const harmonic = (harmonicParts.length ? harmonicParts : melodic.filter((p) => p.role !== 'bass')).flatMap((p) =>
    partBeats(lesson, p),
  )
  const bassPart = melodic.find((p) => p.role === 'bass')
  const bass = bassPart ? partBeats(lesson, bassPart) : null
  const everything = lesson.parts.filter((p) => !p.silent).flatMap((p) => partBeats(lesson, p))
  const bars = barSpan(everything, grid) ?? [0, 0]
  const chords = harmonic.length ? detectChords(harmonic, bass, grid, bars[0], bars[1], key?.flats ?? false) : []
  return { key, chords, bars }
}

function polyphonyOf(notes: BNote[]): number {
  const ev: [number, number][] = []
  for (const n of notes) {
    ev.push([n.start, 1], [n.start + n.dur, -1])
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let active = 0
  let last = ev.length ? ev[0][0] : 0
  let weighted = 0
  let sounding = 0
  for (const [t, d] of ev) {
    const dt = t - last
    if (active > 0 && dt > 0) {
      weighted += active * dt
      sounding += dt
    }
    active += d
    last = t
  }
  return sounding ? weighted / sounding : 0
}

export function buildPartModel(
  lesson: Lesson,
  part: Part,
  baseProfile: InstrumentProfile,
  calibration: Parameters<typeof effectiveProfile>[1],
  opts: { simplify?: boolean; unitBars?: number; topAsMelody?: boolean } = {},
): PartModel | null {
  const grid = lesson.grid
  if (!grid) return null
  const profile = effectiveProfile(baseProfile, calibration)
  const notes = partBeats(lesson, part)
  const pads = padSpec(profile)
  const onPads = part.isDrum && pads !== null
  let arrangement: Arrangement
  let events: PatternEvent[]
  if (onPads) {
    const overrides: PadOverrides = (lesson.prefs.padOverrides?.[part.id] as PadOverrides) ?? {}
    const a = arrangePads(notes, pads!, overrides)
    arrangement = a
    events = a.events.map((e) => ({ start: e.start, target: `${e.bank}:${e.pad}` }))
  } else {
    const kb = keyboardSpec(profile)
    const a = arrangeKeys(notes, kb, grid, {
      simplify: opts.simplify,
      topAsMelody: opts.topAsMelody,
      transcribed: part.origin === 'transcribed',
      // Drums played on keys keep their notes (an octave away is another drum); a big keyboard has room for two hands.
      untouched: part.isDrum || kb.count >= 49,
      melodic: part.role === 'melody' || part.role === 'vocal',
    })
    arrangement = a
    // Blocks are found on what is actually played (all layers together).
    events = a.layers.flatMap((l) => l.notes.map((e) => ({ start: e.start, target: e.pitch })))
  }
  const bars = barSpan(notes, grid) ?? [0, 0]
  // Transcribed parts carry a little noise (a missed hat, a ghost note): match loosely.
  const tolerance = part.origin === 'transcribed' ? 0.85 : 1
  const patterns = analyzeBlocks(events, grid, bars[0], bars[1], 4, tolerance, opts.unitBars)
  const pitches = notes.map((n) => n.pitch)
  const nBars = Math.max(1, bars[1] - bars[0] + 1)
  return {
    part,
    notes,
    arrangement,
    patterns,
    bars,
    onPads,
    patternInput: { events, tolerance },
    stats: {
      notes: notes.length,
      low: pitches.length ? Math.min(...pitches) : 0,
      high: pitches.length ? Math.max(...pitches) : 0,
      polyphony: polyphonyOf(notes),
      perBar: notes.length / nBars,
    },
  }
}
