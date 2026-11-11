import { describe, expect, it } from 'vitest'
import type { Grid } from '../types'
import { arrangeKeys, arrangePads, type KeyboardSpec, type PadSpec } from './arrange'
import { barSpan, beatTime, editGrid, exportOrigin, scaleGrid, timeToBeat, uniformGrid, type BNote } from './grid'
import { writeMidiFile } from './midifile'
import { noteName } from './notes'
import { analyzePatterns } from './patterns'
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

describe('keys arrangement', () => {
  it('a bass line in E1..G2 plays on OCT −2 without octave changes', () => {
    const notes = [28, 31, 33, 35, 36, 38, 40, 43].map((p, i) => n(p, i))
    const a = arrangeKeys(notes, MPK, grid120())
    expect(a.passes).toHaveLength(1)
    expect(a.passes[0].startOctave).toBe(-2)
    expect(a.passes[0].changes).toHaveLength(0)
    expect(a.passes[0].events.every((e) => e.key >= 0 && e.key <= 24 && !e.folded)).toBe(true)
    expect(a.passes[0].events[0].key).toBe(28 - 24)
  })
  it('prefers the default octave when several fit', () => {
    const a = arrangeKeys([60, 62, 64, 65, 67].map((p, i) => n(p, i)), MPK, grid120())
    expect(a.passes[0].startOctave).toBe(0)
  })
  it('changes octave between phrases, inside a rest', () => {
    // Bar 1: low phrase (36..43), bars 2: rest, bar 3: high phrase (84..91).
    const low = [36, 38, 40, 43].map((p, i) => n(p, i, 0.9))
    const high = [84, 86, 88, 91].map((p, i) => n(p, 8 + i, 0.9))
    const a = arrangeKeys([...low, ...high], MPK, grid120())
    const pass = a.passes[0]
    expect(a.passes).toHaveLength(1)
    expect(pass.changes).toHaveLength(1)
    const ch = pass.changes[0]
    expect(ch.beat).toBeGreaterThan(3.9)
    expect(ch.beat).toBeLessThan(8)
    expect(ch.quick).toBe(false)
    expect(pass.events.every((e) => !e.folded)).toBe(true)
  })
  it('splits a 4-octave chord part into two passes', () => {
    const notes: BNote[] = []
    for (let bar = 0; bar < 4; bar++) {
      const t = bar * 4
      notes.push(n(36, t, 4), n(43, t, 4), n(76, t, 4), n(79, t, 4), n(84, t, 4))
    }
    const a = arrangeKeys(notes, MPK, grid120())
    expect(a.passes).toHaveLength(2)
    const [upper, lower] = a.passes
    expect(upper.low).toBeGreaterThanOrEqual(76)
    expect(lower.high).toBeLessThanOrEqual(43)
    expect(upper.changes).toHaveLength(0)
    expect(lower.changes).toHaveLength(0)
    expect(a.warnings.length).toBeGreaterThan(0)
  })
  it('an 88-key keyboard never needs octave changes', () => {
    const a = arrangeKeys([21, 108, 60].map((p, i) => n(p, i)), { count: 88, lowNote: 21, octaveRange: [0, 0] }, grid120())
    expect(a.passes).toHaveLength(1)
    expect(a.passes[0].events.map((e) => e.key)).toEqual([0, 87, 39])
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
