/**
 * Fit-to-controller arrangement: how a part is played on a specific device.
 *
 * Keys: notes must fall into the window of N keys shifted by the OCT buttons
 * ([low + 12·oct, low + 12·oct + N − 1]). Octaves are chosen per phrase unit with a
 * Viterbi pass that minimises OCT presses (and prefers changing in rests). A part that is
 * wider than the window is split into passes (upper/lower layer) recorded as separate
 * takes — the natural way to play a piano part on a 25-key controller.
 *
 * Pads: drum classes are assigned to pads by hit count and ergonomics.
 */
import type { Grid } from '../types'
import { type BNote } from './grid'
import { DRUM_LABEL, PAD_PREFERENCE, gmToClass, type DrumClass } from './drums'

export interface KeyboardSpec {
  count: number
  lowNote: number // note of the leftmost key at OCT 0
  octaveRange: [number, number]
}

export interface PadSpec {
  count: number
  banks: number[][] // banks[b][padIndex] = note sent
  ergonomic: boolean // MPK-style 2×4 where pads 1–4 are the bottom row
  bankNames: string[]
}

export interface KeyEvent {
  start: number
  dur: number
  pitch: number // the note the controller will send (== original unless folded)
  srcPitch: number
  vel: number
  key: number // 0-based key index on the controller
  octave: number
  pass: number
  folded: boolean
}

export interface OctaveChange {
  beat: number
  from: number
  to: number
  quick: boolean
}

export interface OctaveSegment {
  start: number
  end: number
  octave: number
}

export interface KeysPass {
  index: number
  label: string
  events: KeyEvent[]
  startOctave: number
  changes: OctaveChange[]
  segments: OctaveSegment[]
  low: number
  high: number
  folded: number
}

export interface KeysArrangement {
  kind: 'keys'
  passes: KeysPass[]
  warnings: string[]
}

export interface PadSlot {
  cls: DrumClass
  bank: number
  pad: number
  note: number
  label: string
  count: number
  gmNotes: number[]
  merged: DrumClass[]
}

export interface PadEvent {
  start: number
  dur: number
  vel: number
  cls: DrumClass
  bank: number
  pad: number
  note: number
  gm: number
}

export interface PadsArrangement {
  kind: 'pads'
  slots: PadSlot[]
  events: PadEvent[]
  warnings: string[]
  banksUsed: number[]
}

export type Arrangement = KeysArrangement | PadsArrangement

// ---------------------------------------------------------------------------------------

/** Octave decisions are made per half bar in 4/4 (finer than a bar, coarser than a beat). */
export function octaveUnitBeats(grid: Grid): number {
  const L = grid.barLength
  return L >= 4 && Number.isInteger(L / 2) ? L / 2 : L
}

/** Simplified mode: at most 4 notes per onset, keeping the top and distinct pitch classes. */
export function simplifyNotes(notes: BNote[]): BNote[] {
  const out: BNote[] = []
  let i = 0
  const sorted = notes.slice().sort((a, b) => a.start - b.start || b.pitch - a.pitch)
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && Math.abs(sorted[j].start - sorted[i].start) < 1 / 48) j++
    const group = sorted.slice(i, j).sort((a, b) => b.pitch - a.pitch)
    const kept: BNote[] = []
    const pcs = new Set<number>()
    for (const n of group) {
      if (kept.length >= 4) break
      const p = ((n.pitch % 12) + 12) % 12
      if (kept.length === 0 || !pcs.has(p)) {
        kept.push(n)
        pcs.add(p)
      }
    }
    out.push(...kept)
    i = j
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/** Otsu threshold on the duration-weighted pitch histogram: split into two registers. */
export function otsuSplit(notes: BNote[]): number {
  let lo = Infinity
  let hi = -Infinity
  for (const n of notes) {
    lo = Math.min(lo, n.pitch)
    hi = Math.max(hi, n.pitch)
  }
  const hist = new Map<number, number>()
  for (const n of notes) hist.set(n.pitch, (hist.get(n.pitch) ?? 0) + n.dur)
  const total = [...hist.values()].reduce((s, x) => s + x, 0)
  const mean = [...hist.entries()].reduce((s, [p, w]) => s + p * w, 0) / total
  let best = Math.floor((lo + hi) / 2) + 1
  let bestVar = -1
  let w0 = 0
  let sum0 = 0
  for (let t = lo; t < hi; t++) {
    const w = hist.get(t) ?? 0
    w0 += w
    sum0 += t * w
    const w1 = total - w0
    if (w0 <= 0 || w1 <= 0) continue
    const m0 = sum0 / w0
    const m1 = (mean * total - sum0) / w1
    const between = w0 * w1 * (m0 - m1) ** 2
    if (between > bestVar) {
      bestVar = between
      best = t + 1
    }
  }
  return best
}

function planPass(notes: BNote[], index: number, total: number, kb: KeyboardSpec, grid: Grid): KeysPass {
  const width = kb.count - 1
  const unitLen = octaveUnitBeats(grid)
  const unitOf = (beat: number) => Math.floor((beat - grid.firstDownbeat) / unitLen + 1e-9)
  const byUnit = new Map<number, BNote[]>()
  for (const n of notes) {
    const u = unitOf(n.start)
    const list = byUnit.get(u)
    if (list) list.push(n)
    else byUnit.set(u, [n])
  }
  const units = [...byUnit.keys()].sort((a, b) => a - b)
  const [omin, omax] = kb.octaveRange
  const states: number[] = []
  for (let o = omin; o <= omax; o++) states.push(o)

  const windowLow = (o: number) => kb.lowNote + 12 * o
  const outside = (u: number, o: number) => {
    const a = windowLow(o)
    return byUnit.get(u)!.filter((n) => n.pitch < a || n.pitch > a + width).length
  }

  // Gap (rest) before each unit and whether the unit boundary falls mid-bar.
  const firstStart: number[] = []
  const gapBefore: number[] = []
  const midBar: boolean[] = []
  let lastEnd = -Infinity
  for (const u of units) {
    const list = byUnit.get(u)!
    const s = Math.min(...list.map((n) => n.start))
    firstStart.push(s)
    gapBefore.push(s - lastEnd)
    const unitStart = grid.firstDownbeat + u * unitLen
    midBar.push(Math.abs((unitStart - grid.firstDownbeat) / grid.barLength - Math.round((unitStart - grid.firstDownbeat) / grid.barLength)) > 1e-6)
    lastEnd = Math.max(lastEnd, ...list.map((n) => n.start + n.dur))
  }

  // Viterbi.
  const K = units.length
  const S = states.length
  const cost: number[][] = Array.from({ length: K }, () => new Array(S).fill(Infinity))
  const back: number[][] = Array.from({ length: K }, () => new Array(S).fill(0))
  for (let s = 0; s < S; s++) cost[0][s] = Math.abs(states[s]) * 0.3 + outside(units[0], states[s]) * 10
  for (let k = 1; k < K; k++) {
    const restFactor = gapBefore[k] >= 0.5 ? 1 : 3
    for (let s = 0; s < S; s++) {
      const emit = outside(units[k], states[s]) * 10
      let best = Infinity
      let arg = 0
      for (let p = 0; p < S; p++) {
        const d = Math.abs(states[s] - states[p])
        const c = cost[k - 1][p] + d * restFactor + (d && midBar[k] ? 0.5 : 0)
        if (c < best) {
          best = c
          arg = p
        }
      }
      cost[k][s] = best + emit
      back[k][s] = arg
    }
  }
  const choice = new Array(K).fill(0)
  if (K) {
    let s = 0
    for (let i = 1; i < S; i++) if (cost[K - 1][i] < cost[K - 1][s]) s = i
    for (let k = K - 1; k >= 0; k--) {
      choice[k] = states[s]
      s = back[k][s]
    }
  }

  const events: KeyEvent[] = []
  const changes: OctaveChange[] = []
  const segments: OctaveSegment[] = []
  let folded = 0
  let prevEnd = -Infinity
  units.forEach((u, k) => {
    const o = choice[k]
    if (k > 0 && o !== choice[k - 1]) {
      const gap = firstStart[k] - prevEnd
      const beat = gap > 0 ? prevEnd + Math.min(0.25, gap / 2) : firstStart[k]
      changes.push({ beat, from: choice[k - 1], to: o, quick: gap < 0.5 })
    }
    const unitStart = grid.firstDownbeat + u * unitLen
    const seg = segments[segments.length - 1]
    if (seg && seg.octave === o) seg.end = unitStart + unitLen
    else segments.push({ start: unitStart, end: unitStart + unitLen, octave: o })
    const a = windowLow(o)
    for (const n of byUnit.get(u)!) {
      let pitch = n.pitch
      let isFolded = false
      while (pitch < a) {
        pitch += 12
        isFolded = true
      }
      while (pitch > a + width) {
        pitch -= 12
        isFolded = true
      }
      if (isFolded) folded++
      events.push({
        start: n.start, dur: n.dur, pitch, srcPitch: n.pitch, vel: n.vel,
        key: pitch - a, octave: o, pass: index, folded: isFolded,
      })
      prevEnd = Math.max(prevEnd, n.start + n.dur)
    }
  })
  events.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  const pitches = notes.map((n) => n.pitch)
  return {
    index,
    label: total === 1 ? 'Вся партия' : index === 0 ? 'Проход 1 · верхний регистр' : 'Проход 2 · нижний регистр',
    events,
    startOctave: K ? choice[0] : 0,
    changes,
    segments,
    low: Math.min(...pitches),
    high: Math.max(...pitches),
    folded,
  }
}

export function arrangeKeys(
  input: BNote[],
  kb: KeyboardSpec,
  grid: Grid,
  opts: { simplify?: boolean } = {},
): KeysArrangement {
  const warnings: string[] = []
  const notes = opts.simplify ? simplifyNotes(input) : input.slice()
  if (!notes.length) return { kind: 'keys', passes: [], warnings }
  const width = kb.count - 1
  const unitLen = octaveUnitBeats(grid)
  const spans = new Map<number, [number, number]>()
  for (const n of notes) {
    const u = Math.floor((n.start - grid.firstDownbeat) / unitLen + 1e-9)
    const s = spans.get(u)
    if (s) {
      s[0] = Math.min(s[0], n.pitch)
      s[1] = Math.max(s[1], n.pitch)
    } else spans.set(u, [n.pitch, n.pitch])
  }
  const wideUnits = [...spans.values()].filter(([lo, hi]) => hi - lo > width).length
  let layers: BNote[][] = [notes]
  if (wideUnits > 0) {
    const split = otsuSplit(notes)
    const upper = notes.filter((n) => n.pitch >= split)
    const lower = notes.filter((n) => n.pitch < split)
    layers = [upper, lower].filter((l) => l.length > 0)
    if (layers.length > 1) {
      warnings.push(
        `Партия шире ${kb.count} клавиш в ${wideUnits} местах — разбита на 2 прохода: верхний и нижний регистр записываются отдельными дублями.`,
      )
    }
  }
  const passes = layers.map((layer, i) => planPass(layer, i, layers.length, kb, grid))
  const folded = passes.reduce((s, p) => s + p.folded, 0)
  if (folded > 0) {
    warnings.push(`${folded} нот не помещаются в окно клавиш даже по проходам — перенесены на октаву (помечены).`)
  }
  return { kind: 'keys', passes, warnings }
}

// ---------------------------------------------------------------------------------------

export type PadOverrides = Record<string, { bank: number; pad: number }>

export function arrangePads(notes: BNote[], pads: PadSpec, overrides: PadOverrides = {}): PadsArrangement {
  const warnings: string[] = []
  const counts = new Map<DrumClass, number>()
  const gmNotes = new Map<DrumClass, Set<number>>()
  for (const n of notes) {
    const cls = gmToClass(n.pitch)
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
    if (!gmNotes.has(cls)) gmNotes.set(cls, new Set())
    gmNotes.get(cls)!.add(n.pitch)
  }
  const classes = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!)
  const nBanks = Math.max(1, pads.banks.length)
  const occupied = new Map<string, PadSlot>()
  const slotOf = new Map<DrumClass, PadSlot>()
  const keyOf = (bank: number, pad: number) => `${bank}:${pad}`
  const makeSlot = (cls: DrumClass, bank: number, pad: number): PadSlot => ({
    cls, bank, pad, note: pads.banks[bank]?.[pad] ?? 36 + pad, label: DRUM_LABEL[cls],
    count: counts.get(cls) ?? 0, gmNotes: [...(gmNotes.get(cls) ?? [])].sort((a, b) => a - b), merged: [],
  })

  for (const cls of classes) {
    const ov = overrides[cls]
    if (!ov || ov.bank >= nBanks || ov.pad >= pads.count || occupied.has(keyOf(ov.bank, ov.pad))) continue
    const slot = makeSlot(cls, ov.bank, ov.pad)
    occupied.set(keyOf(ov.bank, ov.pad), slot)
    slotOf.set(cls, slot)
  }
  for (const cls of classes) {
    if (slotOf.has(cls)) continue
    let placed: [number, number] | null = null
    const prefs = pads.ergonomic ? PAD_PREFERENCE[cls] : []
    for (const p of prefs) {
      if (p < pads.count && !occupied.has(keyOf(0, p))) {
        placed = [0, p]
        break
      }
    }
    for (let b = 0; b < nBanks && !placed; b++) {
      for (let p = 0; p < pads.count; p++) {
        if (!occupied.has(keyOf(b, p))) {
          placed = [b, p]
          break
        }
      }
    }
    if (placed) {
      const slot = makeSlot(cls, placed[0], placed[1])
      occupied.set(keyOf(placed[0], placed[1]), slot)
      slotOf.set(cls, slot)
    } else {
      // Out of pads: share the least used existing slot.
      const target = [...occupied.values()].sort((a, b) => a.count - b.count)[0]
      target.merged.push(cls)
      slotOf.set(cls, target)
      warnings.push(`${DRUM_LABEL[cls]} делит пэд с ${target.label}: пэдов меньше, чем звуков.`)
    }
  }
  const events: PadEvent[] = notes.map((n) => {
    const cls = gmToClass(n.pitch)
    const slot = slotOf.get(cls)!
    return { start: n.start, dur: n.dur, vel: n.vel, cls, bank: slot.bank, pad: slot.pad, note: slot.note, gm: n.pitch }
  })
  const banksUsed = [...new Set([...occupied.values()].map((s) => s.bank))].sort()
  if (banksUsed.some((b) => b > 0)) {
    warnings.push(`Звуков больше, чем пэдов в банке ${pads.bankNames[0] ?? 'A'} — часть в банке ${pads.bankNames[1] ?? 'B'} (переключай кнопкой BANK).`)
  }
  const slots = [...new Set(occupied.values())].sort((a, b) => a.bank - b.bank || a.pad - b.pad)
  return { kind: 'pads', slots, events, warnings, banksUsed }
}
