import { describe, expect, it } from 'vitest'
import { BUILTIN_LESSONS, builtinLesson, chordFingers, exercisePassBars } from '../builtin/lessons'
import { heldChordName } from '../components/ChordReadout'
import { rangeLabel, snapSelection } from '../components/Waterfall'
import { PROFILES } from '../instruments/profiles'
import type { Grid, Lesson } from '../types'
import {
  HAND_NOTES,
  HAND_SPAN,
  arrangeKeys,
  arrangePads,
  dropGhosts,
  fitLayer,
  onsetGroups,
  oneHandChord,
  type KeyboardSpec,
  type KeysArrangement,
  type PadSpec,
} from './arrange'
import { chordFlats, chordInfo } from './explain'
import { exportPartMidi, exportStretchMidi } from './exportMidi'
import { barSpan, beatTime, editGrid, exportOrigin, scaleGrid, timeToBeat, uniformGrid, type BNote } from './grid'
import { buildPartModel, layerBlocks } from './model'
import { writeMidiFile } from './midifile'
import { noteName } from './notes'
import { analyzePatterns, mainUnit } from './patterns'
import { detectChords, detectKey } from './theory'

const grid120 = (beats = 200, offset = 0): Grid => ({
  beats: Array.from({ length: beats }, (_, i) => offset + i * 0.5),
  barLength: 4,
  timeSig: [4, 4],
  firstDownbeat: 0,
  bpm: 120,
  origin: 'midi',
})

const MPK: KeyboardSpec = { count: 25, lowNote: 48, octaveRange: [-4, 4] }
const n = (pitch: number, start: number, dur = 1, vel = 100, idx = 0): BNote => ({ pitch, start, dur, vel, idx })

describe('grid', () => {
  it('beatTime and timeToBeat are inverse, also with tempo changes', () => {
    const g: Grid = { ...grid120(), beats: [0, 0.5, 1, 1.5, 2, 2.4, 2.8, 3.2] }
    for (const b of [0, 0.25, 1, 3.5, 4.5, 6, 9]) expect(timeToBeat(g, beatTime(g, b))).toBeCloseTo(b, 6)
    expect(beatTime(g, -1)).toBeCloseTo(-0.5)
  })
  it('export origin lands on a bar line at or before zero', () => {
    const g = { ...grid120(), beats: Array.from({ length: 100 }, (_, i) => 0.3 + i * 0.5), firstDownbeat: 1 }
    const o = exportOrigin(g)
    expect(o.time).toBeLessThanOrEqual(1e-6)
    expect((g.firstDownbeat - o.beat) % 4).toBe(0)
    expect(o.time).toBeCloseTo(0.8 - 2, 6)
  })
  it('uniform grid places bar 1 at the downbeat', () => {
    const g = uniformGrid(124, 1.2, 30)
    expect(beatTime(g, g.firstDownbeat)).toBeCloseTo(1.2, 5)
    expect(g.beats[0]).toBeGreaterThanOrEqual(0)
  })
  it('edits keep tracked beats unless tempo changes', () => {
    const g = grid120()
    expect(editGrid(g, 60, { shiftBeats: 1 }).firstDownbeat).toBe(1)
    expect(editGrid(g, 60, { shiftBeats: -1 }).firstDownbeat).toBe(3)
    expect(editGrid(g, 60, { bpm: 60 }).bpm).toBe(60)
    expect(scaleGrid(g, 2).beats[1]).toBeCloseTo(0.25)
    expect(scaleGrid(g, 0.5).bpm).toBe(60)
  })
  it('names notes in Ableton and scientific conventions', () => {
    expect(noteName(60)).toBe('C3')
    expect(noteName(60, 'scientific')).toBe('C4')
    expect(noteName(28)).toBe('E0')
  })
})

describe('one hand, one OCT', () => {
  const layerKinds = (notes: BNote[]) => arrangeKeys(notes, MPK, grid120()).layers.map((l) => l.kind)
  const fitsHand = (notes: BNote[]) =>
    onsetGroups(notes).every((g) => {
      const ps = g.map((x) => x.pitch)
      return new Set(ps).size <= HAND_NOTES && Math.max(...ps) - Math.min(...ps) <= HAND_SPAN
    })

  it('a bass line in E1..G2 is one layer, untouched, at OCT −2', () => {
    const notes = [28, 31, 33, 35, 36, 38, 40, 43].map((p, i) => n(p, i))
    const a = arrangeKeys(notes, MPK, grid120())
    expect(a.layers.map((l) => l.kind)).toEqual(['all'])
    const fit = fitLayer(a.layers[0], MPK)
    expect(fit.octave).toBe(-2)
    expect(fit.events.every((e) => e.key >= 0 && e.key <= 24 && !e.folded)).toBe(true)
    expect(fit.events[0].key).toBe(28 - 24)
  })
  it('prefers the default octave when several fit', () => {
    const a = arrangeKeys([60, 62, 64, 65, 67].map((p, i) => n(p, i)), MPK, grid120())
    expect(fitLayer(a.layers[0], MPK).octave).toBe(0)
  })
  it('gives every stretch one OCT: a low and a high phrase each fit without a change inside', () => {
    const low = [36, 38, 40, 43].map((p, i) => n(p, i, 0.9))
    const high = [84, 86, 88, 91].map((p, i) => n(p, 8 + i, 0.9))
    const layer = arrangeKeys([...low, ...high], MPK, grid120()).layers[0]
    const first = fitLayer(layer, MPK, { start: 0, end: 4 })
    const second = fitLayer(layer, MPK, { start: 8, end: 12 })
    expect(first.folded).toBe(0)
    expect(second.folded).toBe(0)
    expect(second.octave).toBeGreaterThan(first.octave)
    expect(first.events.filter((e) => e.start < 4).every((e) => !e.folded && e.key >= 0 && e.key <= 24)).toBe(true)
    expect(second.events.filter((e) => e.start >= 8).every((e) => !e.folded && e.key >= 0 && e.key <= 24)).toBe(true)
  })
  it('a stretch keeps the layer’s own OCT when it fits there', () => {
    const notes = [55, 60, 64, 67, 72, 76, 79, 74].map((p, i) => n(p, i))
    const layer = arrangeKeys(notes, MPK, grid120()).layers[0]
    const home = fitLayer(layer, MPK).octave
    expect(fitLayer(layer, MPK, { start: 4, end: 8 }).octave).toBe(home)
  })
  it('moves notes a 25-key stretch cannot hold by an octave and counts only the stretch', () => {
    const layer = arrangeKeys([48, 60, 72, 84, 50].map((p, i) => n(p, i)), MPK, grid120()).layers[0]
    const fit = fitLayer(layer, MPK, { start: 0, end: 4 })
    expect(fit.octave).toBe(0)
    expect(fit.folded).toBe(1)
    expect(fit.events.every((e) => e.key >= 0 && e.key <= 24)).toBe(true)
    expect(fit.events.find((e) => e.srcPitch === 84)!.pitch).toBe(72)
  })
  it('splits a two-hand piano part into melody, chords and bass, each playable by one hand', () => {
    const notes: BNote[] = []
    for (let bar = 0; bar < 4; bar++) {
      const t = bar * 4
      notes.push(n(36, t, 2), n(43, t + 2, 2)) // left hand: one bass note at a time
      notes.push(n(60, t, 1), n(64, t, 1), n(72, t, 1), n(74, t + 1, 1)) // right hand: a chord with the tune on top, a passing note
      notes.push(n(60, t + 2, 1), n(65, t + 2, 1), n(76, t + 2, 1), n(74, t + 3, 1))
    }
    const a = arrangeKeys(notes, MPK, grid120())
    expect(a.layers.map((l) => l.kind)).toEqual(['melody', 'chords', 'bass'])
    expect(a.layers[0].notes.slice(0, 4).map((x) => x.pitch)).toEqual([72, 74, 76, 74])
    expect(a.layers[2].notes.slice(0, 2).map((x) => x.pitch)).toEqual([36, 43])
    for (const l of a.layers) expect(fitsHand(l.notes)).toBe(true)
    expect(a.warnings.join(' ')).toContain('слои')
  })
  it('pads under a lead: the lead is the melody, the pad (tops included) stays a chord for one hand', () => {
    const notes: BNote[] = []
    for (let bar = 0; bar < 4; bar++) {
      const t = bar * 4
      notes.push(...[48, 55, 64, 67, 72].map((p) => n(p, t, 4, 70)))
      notes.push(n(76, t + 1, 0.5), n(79, t + 1.5, 0.5), n(81, t + 2, 1), n(84, t + 3, 1))
    }
    const a = arrangeKeys(notes, MPK, grid120())
    const melody = a.layers.find((l) => l.kind === 'melody')!
    const chords = a.layers.find((l) => l.kind === 'chords')!
    expect(new Set(melody.notes.map((x) => x.pitch))).toEqual(new Set([76, 79, 81, 84]))
    expect(chords.notes.some((x) => x.pitch >= 76)).toBe(false)
    expect(fitsHand(chords.notes)).toBe(true)
    expect(chords.revoiced).toBeGreaterThan(0)
  })
  it('block chords in any inversion stay one chords layer', () => {
    const triads = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]] // Am F C G, close voicings
    const notes = [0, 1].flatMap((r) => triads.flatMap((t, i) => t.map((p) => n(p, (r * 4 + i) * 4, 3.9))))
    expect(layerKinds(notes)).toEqual(['chords'])
  })
  it('a big chord cut to four notes keeps its 3rd and loses its 5th first', () => {
    const c9 = [48, 52, 55, 58, 62].map((p) => ({ ...n(p, 0), src: p })) // C E G Bb D
    const r = oneHandChord(c9)
    const pcs = new Set(r.notes.map((x) => x.pitch % 12))
    expect(r.notes.length).toBeLessThanOrEqual(HAND_NOTES)
    expect(pcs.has(4)).toBe(true)
    expect(pcs.has(7)).toBe(false)
    expect(Math.max(...r.notes.map((x) => x.pitch)) - Math.min(...r.notes.map((x) => x.pitch))).toBeLessThanOrEqual(HAND_SPAN)
  })
  it('drops quiet overtone ghosts of transcribed notes', () => {
    const notes = [n(60, 0, 1, 100), n(72, 0, 1, 40), n(79, 0, 1, 30), n(62, 1, 1, 100), n(74, 1, 1, 90)]
    expect(dropGhosts(notes).map((x) => x.pitch)).toEqual([60, 62, 74])
  })
  it('drums on keys and big keyboards keep the part as it is', () => {
    const drums = [36, 38, 42, 36, 38, 42].map((p, i) => n(p, i / 2))
    const a = arrangeKeys(drums, MPK, grid120(), { untouched: true })
    expect(a.layers).toHaveLength(1)
    expect(a.layers[0].notes.map((x) => x.pitch)).toEqual([36, 38, 42, 36, 38, 42])
    const kb88: KeyboardSpec = { count: 88, lowNote: 21, octaveRange: [0, 0] }
    const big = arrangeKeys([21, 108, 60].map((p, i) => n(p, i)), kb88, grid120(), { untouched: true })
    expect(fitLayer(big.layers[0], kb88).events.map((e) => e.key)).toEqual([0, 87, 39])
  })
})

describe('built-in lessons', () => {
  it('every exercise is one layer at OCT 0 with nothing moved, and every note has a finger', () => {
    for (const def of BUILTIN_LESSONS) {
      const built = builtinLesson(def.id)!
      for (const part of built.lesson.parts) {
        const m = buildPartModel(built.lesson, part, PROFILES[0], null)!
        const a = m.arrangement as KeysArrangement
        expect(a.kind, `${def.id}/${part.id}`).toBe('keys')
        expect(a.layers, `${def.id}/${part.id}`).toHaveLength(1)
        const fit = fitLayer(a.layers[0], MPK)
        expect(fit.octave, `${def.id}/${part.id}`).toBe(0)
        expect(fit.events.every((e) => !e.folded), `${def.id}/${part.id}`).toBe(true)
        const info = built.info.get(part.id)!
        expect(part.notes.every((_, i) => info.fingers.has(i))).toBe(true)
      }
    }
  })
  it('chord voicings fit one hand on the keys at OCT 0 and are what they are called', () => {
    for (const def of BUILTIN_LESSONS) {
      for (const ex of def.exercises) {
        for (const s of ex.steps ?? []) {
          expect(Math.min(...s.notes)).toBeGreaterThanOrEqual(48)
          expect(Math.max(...s.notes)).toBeLessThanOrEqual(72)
          expect(s.notes.length).toBeLessThanOrEqual(HAND_NOTES)
          expect(Math.max(...s.notes) - Math.min(...s.notes)).toBeLessThanOrEqual(HAND_SPAN)
          expect(heldChordName(s.notes), `${def.id}: ${s.chord}`).toBe(s.chord)
        }
      }
    }
  })
  it('chord marks sit on bar lines, one per written bar', () => {
    const built = builtinLesson('chords-pop')!
    const g = built.lesson.grid!
    const info = built.info.get('pop-whole')!
    expect(info.chords.map((c) => c.name)).toEqual(['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F'])
    for (const c of info.chords) expect((c.start - g.firstDownbeat) % g.barLength).toBe(0)
  })
  it('names the right-hand fingers of a chord', () => {
    expect(chordFingers([60, 64, 67])).toEqual([1, 3, 5])
    expect(chordFingers([59, 62, 67])).toEqual([1, 2, 5])
    expect(chordFingers([57, 60, 64, 67])).toEqual([1, 2, 3, 5])
  })
})

describe('note view and plain words', () => {
  const g = grid120()
  it('a click picks its bar, a drag the bars it touches, Alt whole beats', () => {
    expect(snapSelection(g, 5.3, 5.3)).toEqual({ start: 4, end: 8 })
    expect(snapSelection(g, 13.5, 5.2)).toEqual({ start: 4, end: 16 })
    expect(snapSelection(g, 5.3, 6.6, true)).toEqual({ start: 5, end: 7 })
  })
  it('labels a stretch for people', () => {
    expect(rangeLabel(g, { start: 4, end: 8 })).toBe('такт 2')
    expect(rangeLabel(g, { start: 4, end: 16 })).toBe('такты 2–4')
    expect(rangeLabel(g, { start: 5, end: 7 })).toBe('такт 2, доли 2–3')
  })
  it('explains chords in plain words', () => {
    expect(chordInfo('Am')?.short).toBe('минор')
    expect(chordInfo('F/C')?.short).toContain('внизу C')
    expect(chordInfo('H7')).toBeNull()
  })
})

describe('pads arrangement', () => {
  const PADS: PadSpec = {
    count: 8,
    banks: [
      [36, 37, 38, 39, 40, 41, 42, 43],
      [44, 45, 46, 47, 48, 49, 50, 51],
    ],
    ergonomic: true,
    bankNames: ['A', 'B'],
  }
  it('kick / snare / hat land on pads 1–3 of bank A', () => {
    const notes: BNote[] = []
    for (let b = 0; b < 16; b++) {
      notes.push(n(36, b, 0.1))
      if (b % 2) notes.push(n(38, b, 0.1))
      notes.push(n(42, b, 0.1), n(42, b + 0.5, 0.1))
    }
    const a = arrangePads(notes, PADS)
    const pad = (cls: string) => a.slots.find((s) => s.cls === cls)!
    expect(pad('kick').pad).toBe(0)
    expect(pad('snare').pad).toBe(1)
    expect(pad('closedHat').pad).toBe(2)
    expect(a.banksUsed).toEqual([0])
    expect(a.events.find((e) => e.cls === 'snare')!.note).toBe(37)
  })
  it('respects overrides and overflows into bank B', () => {
    const many = [36, 38, 39, 37, 42, 46, 45, 47, 50, 49, 51].map((p, i) => n(p, i))
    const a = arrangePads(many, PADS, { kick: { bank: 0, pad: 7 } })
    expect(a.slots.find((s) => s.cls === 'kick')!.pad).toBe(7)
    expect(a.banksUsed).toContain(1)
  })
})

describe('patterns', () => {
  it('a two-bar loop repeated four times is one pattern', () => {
    const g = grid120()
    const notes: { start: number; target: number }[] = []
    for (let rep = 0; rep < 4; rep++) {
      const t = rep * 8
      ;[0, 1, 2, 3].forEach((b) => notes.push({ start: t + b, target: 40 }))
      ;[4, 5, 6, 7].forEach((b) => notes.push({ start: t + b, target: 43 }))
    }
    const p = analyzePatterns(notes, g, 0, 7)
    expect(p.unitBars).toBe(2)
    expect(p.patterns).toHaveLength(1)
    expect(p.units.map((u) => u.label).join('')).toBe('AAAA')
  })
  it('a downbeat a hair early (MIDI rounding, humanised playing) still belongs to its bar', () => {
    const g = grid120()
    const notes: { start: number; target: number }[] = []
    for (let bar = 0; bar < 8; bar++) {
      const t = bar * 4
      notes.push({ start: bar ? t - 9e-6 : 0, target: 36 }, { start: t + 1, target: 38 }, { start: t + 2, target: 36 }, { start: t + 3, target: 38 })
    }
    const p = analyzePatterns(notes, g, 0, 7)
    expect(p.patterns).toHaveLength(1)
    expect(p.units.map((u) => u.label).join('')).toMatch(/^A+$/)
  })
  it('a 32nd-note roll into the bar line stays in its own bar', () => {
    const g = grid120()
    const notes: { start: number; target: number }[] = []
    for (let bar = 0; bar < 8; bar++) {
      const t = bar * 4
      notes.push({ start: t, target: 36 }, { start: t + 2, target: 38 })
      for (const x of [3.5, 3.625, 3.75, 3.875]) notes.push({ start: t + x, target: 42 })
    }
    const p = analyzePatterns(notes, g, 0, 7)
    expect(p.patterns).toHaveLength(1)
    expect(p.units.map((u) => u.label).join('')).toMatch(/^A+$/)
  })
  it('a first note played a little early does not open an empty bar before bar 1', () => {
    const g = grid120()
    expect(barSpan([n(40, -0.008, 1), n(43, 7, 1)], g)).toEqual([0, 1])
  })
  it('uses the block length the learner picked', () => {
    const g = grid120()
    const notes = Array.from({ length: 32 }, (_, i) => ({ start: i, target: 40 + (i % 4) }))
    expect(analyzePatterns(notes, g, 0, 7).unitBars).toBe(1)
    const eight = analyzePatterns(notes, g, 0, 7, 4, 1, 8)
    expect(eight.unitBars).toBe(8)
    expect(eight.units).toHaveLength(1)
    expect(analyzePatterns(notes, g, 0, 7, 4, 1, 16).unitBars).toBe(8) // never longer than the part
  })
  it('labels variants with a prime', () => {
    const g = grid120()
    const bar = (t: number, last: number) => [0, 1, 2, 3].map((b) => ({ start: t + b, target: b === 3 ? last : 40 }))
    const notes = [...bar(0, 40), ...bar(4, 40), ...bar(8, 40), ...bar(12, 47)]
    const p = analyzePatterns(notes, g, 0, 3)
    expect(p.units.map((u) => u.label)).toEqual(['A', 'A', 'A', 'A′'])
  })
  it('tolerates transcription noise when asked', () => {
    const g = grid120()
    // 16 sixteenths per bar; one bar misses a hit and another has an extra one.
    const bar = (t: number, drop = -1, extra = false) => {
      const ev = Array.from({ length: 16 }, (_, i) => ({ start: t + i / 4, target: 42 })).filter((_, i) => i !== drop)
      if (extra) ev.push({ start: t + 0.125, target: 42 })
      return ev
    }
    const notes = [...bar(0), ...bar(4, 5), ...bar(8), ...bar(12, -1, true)]
    expect(analyzePatterns(notes, g, 0, 3).patterns.length).toBeGreaterThan(1)
    const tolerant = analyzePatterns(notes, g, 0, 3, 4, 0.85)
    expect(tolerant.patterns).toHaveLength(1)
    expect(tolerant.units.map((u) => u.label).join('')).toMatch(/^A+$/)
  })
})

describe('theory', () => {
  const g = grid120()
  const triad = (pitches: number[], bar: number) => pitches.map((p) => n(p, bar * 4, 4))
  it('detects Am–F–C–G (key: A minor or its relative C major)', () => {
    const harm = [...triad([57, 60, 64], 0), ...triad([53, 57, 60], 1), ...triad([55, 60, 64], 2), ...triad([55, 59, 62], 3)]
    const bass = [33, 29, 36, 31].map((p, i) => n(p, i * 4, 4))
    const chords = detectChords(harm, bass, g, 0, 3, false)
    expect(chords.map((c) => c.name)).toEqual(['Am', 'F', 'C', 'G'])
    const key = detectKey([...harm, ...bass].map((x) => ({ ...x, start: x.start })))
    // Same scale as C major; the bass starting on A decides for A minor.
    expect(`${key?.tonic}${key?.mode}`).toBe('9minor')
  })
  it('finds an unambiguous minor key (Am–Dm–E–Am)', () => {
    const harm = [...triad([57, 60, 64], 0), ...triad([57, 62, 65], 1), ...triad([56, 59, 64], 2), ...triad([57, 60, 64], 3)]
    const bass = [33, 38, 40, 33].map((p, i) => n(p, i * 4, 4))
    const key = detectKey([...harm, ...bass])
    expect(key?.tonic).toBe(9)
    expect(key?.mode).toBe('minor')
    expect(detectChords(harm, bass, g, 0, 3, false).map((c) => c.name)).toEqual(['Am', 'Dm', 'E', 'Am'])
  })
  it('a melody over sustained chords does not turn triads into extensions', () => {
    // Am F C G pads + a lead on 8ths (as Demucs puts both into "other").
    const harm = [...triad([57, 60, 64], 0), ...triad([53, 57, 60], 1), ...triad([55, 60, 64], 2), ...triad([55, 59, 62], 3)]
    const lead = [0, 1, 2, 3].flatMap((bar) => [69, 72, 76, 74, 72, 71, 69, 67].map((p, i) => n(p, bar * 4 + i / 2, 0.45, 90)))
    const bass = [33, 29, 36, 31].map((p, i) => n(p, i * 4, 4))
    const names = detectChords([...harm, ...lead], bass, g, 0, 3, false).map((c) => c.name)
    expect(names).toEqual(['Am', 'F', 'C', 'G'])
  })
  it('merges a same-root colour inside one bar (Fmaj7 + F → F)', () => {
    const fBar = [...[53, 57, 60, 64].map((p) => n(p, 0, 2)), ...[53, 57, 60].map((p) => n(p, 2, 2))]
    const out = detectChords(fBar, [n(29, 0, 4)], g, 0, 0, false)
    expect(out.map((c) => c.name)).toEqual(['F'])
    expect(out[0].end).toBe(4)
  })
  it('keeps a real change of quality inside a bar (F → Fm, Cmaj7 → C7)', () => {
    const fFm = [...[53, 57, 60].map((p) => n(p, 0, 2)), ...[53, 56, 60].map((p) => n(p, 2, 2)), ...[48, 52, 55].map((p) => n(p, 4, 4))]
    expect(detectChords(fFm, [n(29, 0, 4), n(36, 4, 4)], g, 0, 1, false).map((c) => c.name)).toEqual(['F', 'Fm', 'C'])
    const c7 = [...[48, 52, 55, 59].map((p) => n(p, 0, 2)), ...[48, 52, 55, 58].map((p) => n(p, 2, 2))]
    expect(detectChords(c7, [n(36, 0, 4)], g, 0, 0, false).map((c) => c.name)).toEqual(['Cmaj7', 'C7'])
  })
  it('uses the bass to tell Am7 from C6', () => {
    const tones = triad([57, 60, 64, 67], 0)
    expect(detectChords(tones, [n(33, 0, 4)], g, 0, 0, false)[0].name).toBe('Am7')
    expect(detectChords(tones, [n(36, 0, 4)], g, 0, 0, false)[0].name).toBe('C6')
  })
})

describe('midi file', () => {
  it('writes a valid type-1 header, tempo and notes', () => {
    const bytes = writeMidiFile(
      [{ name: 'Bass', channel: 0, notes: [{ tick: 0, dur: 480, note: 40, vel: 100 }, { tick: 480, dur: 240, note: 43, vel: 90 }] }],
      { bpm: 124, timeSig: [4, 4] },
    )
    const s = (i: number, len: number) => String.fromCharCode(...bytes.slice(i, i + len))
    expect(s(0, 4)).toBe('MThd')
    expect(bytes[9]).toBe(1) // format 1
    expect(bytes[11]).toBe(2) // conductor + 1 track
    expect((bytes[12] << 8) | bytes[13]).toBe(480)
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(hex).toContain('ff5103' + (Math.round(60000000 / 124)).toString(16).padStart(6, '0'))
    expect(hex).toContain('902864') // note on E1 vel 100
    expect(hex).toContain('802800') // note off
  })
})

/** Note-ons of every track of a MIDI file: [track, tick, note]. */
function noteOns(bytes: Uint8Array): [number, number, number][] {
  const out: [number, number, number][] = []
  let i = 14 // after MThd
  let track = -1
  while (i + 8 <= bytes.length) {
    const len = (bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7]
    let j = i + 8
    const end = j + len
    track++
    let tick = 0
    while (j < end) {
      let delta = 0
      while (bytes[j] & 0x80) delta = (delta << 7) | (bytes[j++] & 0x7f)
      delta = (delta << 7) | bytes[j++]
      tick += delta
      const status = bytes[j++]
      if (status === 0xff) {
        j++ // meta type
        let l = 0
        while (bytes[j] & 0x80) l = (l << 7) | (bytes[j++] & 0x7f)
        l = (l << 7) | bytes[j++]
        j += l
      } else {
        if ((status & 0xf0) === 0x90) out.push([track, tick, bytes[j]])
        j += 2
      }
    }
    i = end
  }
  return out
}

describe('review fixes', () => {
  const g = grid120()
  const lessonOf = (notes: [number, number, number][]): Lesson => ({
    id: 't', title: 't', createdAt: '', updatedAt: '', source: { kind: 'midi', stemFiles: [] }, status: 'ready', progress: 1,
    warnings: [], durationSec: 30, grid: g, media: {}, prefs: {},
    parts: [{ id: 'p', name: 'Lead', role: 'melody', isDrum: false, origin: 'midi', media: {}, silent: false,
      notes: notes.map(([p, b, d]) => ({ p, s: beatTime(g, b), e: beatTime(g, b + d), v: 100 })) }],
  })

  it('a built-in exercise opens on one written pass: every chord of it is in the default loop', () => {
    for (const def of BUILTIN_LESSONS) {
      const built = builtinLesson(def.id)!
      for (const part of built.lesson.parts) {
        const info = built.info.get(part.id)!
        const m = buildPartModel(built.lesson, part, PROFILES[0], null)!
        expect((m.arrangement as KeysArrangement).layers).toHaveLength(1)
        const pass = exercisePassBars(info.exercise)
        // Exactly what the trainer shows (and the cover plan would list).
        const p = layerBlocks(m, built.lesson.grid!, 0, pass)
        const u = mainUnit(p)!
        expect(u.bars, `${def.id}/${part.id}`).toBe(pass)
        if (info.exercise.steps) {
          const inside = info.chords.filter((c) => c.start >= u.startBeat - 1e-6 && c.end <= u.endBeat + 1e-6).map((c) => c.name)
          expect(new Set(inside), `${def.id}/${part.id}`).toEqual(new Set(info.exercise.steps.map((s) => s.chord)))
        }
      }
    }
  })
  it('the whole-part MIDI keeps every note at its real pitch (each stretch has its own OCT)', () => {
    const verse: [number, number, number][] = [55, 57, 59, 60, 62, 64, 65, 67].map((p, i) => [p, i, 0.9])
    const chorus: [number, number, number][] = [74, 76, 79, 81, 83, 84, 86, 84].map((p, i) => [p, 16 + i, 0.9])
    const lesson = lessonOf([...verse, ...chorus])
    const model = buildPartModel(lesson, lesson.parts[0], PROFILES[0], null)!
    const pitches = noteOns(exportPartMidi(lesson, model, PROFILES[0])).map(([, , note]) => note)
    expect(pitches).toEqual([...verse, ...chorus].map(([p]) => p))
  })
  it('the MIDI of a stretch keeps a downbeat played a hair early and leaves out the next one', () => {
    const lesson = lessonOf([[60, 0, 1]])
    const events = [
      { start: 3.98, dur: 1, target: 60, vel: 100 },
      { start: 5, dur: 1, target: 62, vel: 100 },
      { start: 7.98, dur: 1, target: 60, vel: 100 },
    ]
    expect(noteOns(exportStretchMidi(lesson, 'x', events, { start: 4, end: 8 }, 0)).map(([, tick, note]) => [tick, note])).toEqual([
      [0, 60],
      [480, 62],
    ])
  })
  it('an octave doubling folded onto its twin is one key struck once', () => {
    const notes = [...[64, 67, 71, 76].map((p) => n(p, 0, 4)), ...[55, 59, 62, 67].map((p) => n(p, 4, 4))].map((x) => ({ ...x, src: x.pitch }))
    const layer = { index: 0, kind: 'chords' as const, label: 'Аккорды', hint: '', notes, revoiced: 0, low: 55, high: 76 }
    const fit = fitLayer(layer, MPK, { start: 0, end: 8 })
    const first = fit.events.filter((e) => e.start === 0).map((e) => e.pitch)
    expect(new Set(first).size).toBe(first.length)
    expect(fit.octave).toBe(0)
  })
  it('a tune too short for its own layer leaves the chords fitted to one hand', () => {
    const chords = [[48, 52, 55, 60, 64], [45, 48, 52, 57, 60], [41, 45, 48, 53, 57]]
    const notes = chords.flatMap((c, i) => c.map((p) => n(p, i * 4, 4)))
    const a = arrangeKeys(notes, MPK, grid120(), { melodic: true })
    for (const l of a.layers) {
      for (const grp of onsetGroups(l.notes)) {
        const ps = grp.map((x) => x.pitch)
        expect(Math.max(...ps) - Math.min(...ps)).toBeLessThanOrEqual(HAND_SPAN)
        expect(new Set(ps).size).toBeLessThanOrEqual(HAND_NOTES)
      }
    }
  })
  it('the low notes a bass line leaves out are counted and reported', () => {
    const notes: BNote[] = []
    for (let bar = 0; bar < 4; bar++) {
      const t = bar * 4
      notes.push(n(36, t, 1), n(43, t, 1), n(36, t + 1, 1), n(36, t + 2, 1), n(36, t + 3, 1)) // C2 + G2 on one, then C2 alone
      notes.push(n(60, t, 1), n(64, t, 1), n(72, t, 1), n(74, t + 1, 1), n(60, t + 2, 1), n(65, t + 2, 1), n(76, t + 2, 1), n(74, t + 3, 1))
    }
    const a = arrangeKeys(notes, MPK, grid120())
    const bass = a.layers.find((l) => l.kind === 'bass')!
    expect(bass.revoiced).toBe(4)
    expect(a.warnings.join(' ')).toContain('убраны')
  })
  it('spells chords and fingers the way the lessons teach them', () => {
    expect(chordFlats('Ab')).toBe(true)
    expect(chordFlats('Cm')).toBe(true)
    expect(chordFlats('E')).toBe(false)
    expect(chordFlats('G#m')).toBe(false)
    expect(chordFingers([57, 62, 64])).toEqual([1, 4, 5]) // Asus4: two neighbouring top keys
    expect(chordFingers([57, 59, 64])).toEqual([1, 2, 5]) // Asus2
  })
})
