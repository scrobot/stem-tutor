/**
 * Fit-to-controller arrangement: how a part is played on a specific device.
 *
 * Keys: a mini keyboard is played with one hand at one OCT setting — pressing OCT while
 * playing is not realistic on 25 keys. So a keys part becomes one or more one-hand *layers*
 * (the whole line; or, for a part with chords, the melody on top, the chords and the bass),
 * each recorded as its own take, the way tracks are rebuilt loop by loop. Chords are re-voiced
 * so one hand can hold them, and a practice stretch gets exactly one OCT setting: the one that
 * fits most of its notes in the window [low + 12·oct, low + 12·oct + N − 1]. Notes that still
 * do not fit are moved by octaves (and marked).
 *
 * Pads: drum classes are assigned to pads by hit count and ergonomics.
 */
import type { Grid } from '../types'
import { inStretch, type BNote } from './grid'
import { DRUM_LABEL, PAD_PREFERENCE, gmToClass, type DrumClass } from './drums'
import { plural } from './explain'
import { pc } from './notes'

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

export interface BeatRange {
  start: number
  end: number
}

/** A note of a one-hand layer: `pitch` is what to play, `src` the pitch in the original part. */
export interface LayerNote extends BNote {
  src: number
}

export type LayerKind = 'all' | 'melody' | 'chords' | 'bass'

export interface KeysLayer {
  index: number
  kind: LayerKind
  label: string
  hint: string
  notes: LayerNote[]
  /** Chord notes moved closer together (or left out) so one hand can take the chord. */
  revoiced: number
  low: number
  high: number
}

export interface KeyEvent {
  idx: number // index of the note in the part
  start: number
  dur: number
  pitch: number // the note the controller will send
  srcPitch: number // the note in the original part
  vel: number
  key: number // 0-based key index on the controller
  folded: boolean // moved by an octave or re-voiced: not where the original has it
}

/** One layer laid on the keys for one stretch: a single OCT setting for all of it. */
export interface KeysFit {
  octave: number
  events: KeyEvent[]
  /** Notes inside the stretch moved by an octave to fit the window. */
  folded: number
}

export interface KeysArrangement {
  kind: 'keys'
  layers: KeysLayer[]
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

/** Semitones one hand takes at once (thumb to little finger, an octave). */
export const HAND_SPAN = 12
/** Notes per chord for one hand (fewer with "simplify"). */
export const HAND_NOTES = 4
/** Notes starting closer than this (beats) are struck together. */
const ONSET = 1 / 24

const LAYER_TEXT: Record<LayerKind, { label: string; hint: string }> = {
  all: { label: 'Вся партия', hint: 'Партия целиком — она играется одной рукой.' },
  melody: { label: 'Мелодия', hint: 'Верхние одиночные ноты — то, что можно напеть. Без аккордов под ними.' },
  chords: { label: 'Аккорды', hint: 'Ноты, которые звучат вместе. Собраны так, чтобы взять их одной рукой.' },
  bass: { label: 'Бас', hint: 'Самые низкие ноты партии — по одной за раз.' },
}

export function onsetGroups<T extends BNote>(notes: T[]): T[][] {
  const sorted = notes.slice().sort((a, b) => a.start - b.start || b.pitch - a.pitch)
  const out: T[][] = []
  for (const n of sorted) {
    const g = out[out.length - 1]
    if (g && Math.abs(n.start - g[0].start) < ONSET) g.push(n)
    else out.push([n])
  }
  return out
}

const distinct = (g: BNote[]) => new Set(g.map((n) => n.pitch)).size

/** Share of onsets that strike two or more different keys at once. */
export function chordShare(groups: BNote[][]): number {
  if (!groups.length) return 0
  return groups.filter((g) => distinct(g) >= 2).length / groups.length
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
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

const asLayerNote = (n: BNote): LayerNote => ({ ...n, src: n.pitch })

/**
 * Transcription "ghosts": a quiet copy an octave (or an octave and a fifth, two octaves) above
 * a louder note struck at the same time — an overtone, not a played note.
 */
export function dropGhosts<T extends BNote>(notes: T[]): T[] {
  const out: T[] = []
  for (const g of onsetGroups(notes)) {
    for (const n of g) {
      const ghost = g.some((m) => m !== n && [12, 19, 24].includes(n.pitch - m.pitch) && n.vel < 0.6 * m.vel)
      if (!ghost) out.push(n)
    }
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/** Which chord notes matter most after the top and the lowest: the 3rd, the 7th, … the 5th last. */
const INTERVAL_PRIORITY = [3, 4, 10, 11, 1, 2, 5, 8, 9, 6, 0, 7]

/**
 * A chord for one hand: at most `maxNotes` different notes within an octave. The top note
 * (what the ear follows) and the lowest one (usually the root) are kept, then the 3rd and the
 * 7th (the colour of the chord); the 5th goes first. Kept notes are moved by octaves into the
 * hand's octave under the top note, doubled notes are left out.
 */
export function oneHandChord(group: LayerNote[], maxNotes = HAND_NOTES): { notes: LayerNote[]; changed: number } {
  const byPitch: LayerNote[] = []
  for (const n of group.slice().sort((a, b) => b.pitch - a.pitch)) if (!byPitch.some((m) => m.pitch === n.pitch)) byPitch.push(n)
  const top = byPitch[0].pitch
  const lowest = byPitch[byPitch.length - 1]
  const span = top - lowest.pitch
  if (byPitch.length <= maxNotes && span <= HAND_SPAN) return { notes: byPitch, changed: group.length - byPitch.length }
  const lift = (p: number) => {
    let x = p
    while (x < top - HAND_SPAN) x += 12
    return x
  }
  const rank = (n: LayerNote) => INTERVAL_PRIORITY.indexOf(pc(n.pitch - lowest.pitch))
  const middle = byPitch.slice(1, -1).sort((a, b) => rank(a) - rank(b))
  const order = byPitch.length > 1 ? [byPitch[0], lowest, ...middle] : [byPitch[0]]
  const kept: LayerNote[] = []
  const used = new Set<number>()
  let changed = 0
  for (const n of order) {
    const p = lift(n.pitch)
    if (kept.length >= maxNotes || used.has(pc(p)) || kept.some((m) => m.pitch === p)) {
      changed++
      continue
    }
    used.add(pc(p))
    if (p !== n.pitch) changed++
    kept.push({ ...n, pitch: p })
  }
  kept.sort((a, b) => b.pitch - a.pitch)
  return { notes: kept, changed: changed + (group.length - byPitch.length) }
}

/** Lowest note of every onset: a bass line from a low register. */
function lowestLine(notes: LayerNote[]): LayerNote[] {
  return onsetGroups(notes).map((g) => g.reduce((lo, n) => (n.pitch < lo.pitch ? n : lo)))
}

/** One key at a time: each note ends where the next one starts. */
function monophonic(notes: LayerNote[]): LayerNote[] {
  const s = notes.slice().sort((a, b) => a.start - b.start || b.pitch - a.pitch)
  return s.map((n, i) => {
    const next = s[i + 1]
    return next && next.start < n.start + n.dur ? { ...n, dur: Math.max(0.05, next.start - n.start) } : n
  })
}

export interface LayerOptions {
  /** At most 3 notes per chord. */
  simplify?: boolean
  /** Notes come from audio: drop overtone ghosts and quiet blips. */
  transcribed?: boolean
  /** Keep the part as it is (drums played on keys, a keyboard big enough for two hands). */
  untouched?: boolean
  /** The part is a tune (role melody / vocal): look for a melody on top even among chords. */
  melodic?: boolean
  /** Take the top note of every chord as the melody (block chords with the tune on top). */
  topAsMelody?: boolean
}

/**
 * Split a keys part into one-hand layers.
 * - Mostly single notes → one layer, the whole part.
 * - Otherwise a low register a hand or more below the rest (a left hand / bass line) becomes
 *   "Бас". In the rest, a tune — single notes, and the top notes of chords in the tune's range
 *   — is "Мелодия", and the notes struck together under it are "Аккорды" (re-voiced for one
 *   hand). Block chords with no tune of their own stay one "Аккорды" layer.
 */
export function keysLayers(input: BNote[], opts: LayerOptions = {}): KeysLayer[] {
  if (!input.length) return []
  if (opts.untouched) {
    const notes = input.map(asLayerNote).sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    const pitches = notes.map((n) => n.pitch)
    return [{ index: 0, kind: 'all', ...LAYER_TEXT.all, notes, revoiced: 0, low: Math.min(...pitches), high: Math.max(...pitches) }]
  }
  const cleaned = opts.transcribed ? dropGhosts(input.filter((n) => !(n.dur < 0.125 && n.vel < 45))) : input
  const notes = (cleaned.length ? cleaned : input).map(asLayerNote)
  const maxNotes = opts.simplify ? 3 : HAND_NOTES
  const groups = onsetGroups(notes)
  const layers: Omit<KeysLayer, 'index'>[] = []
  const make = (kind: LayerKind, list: LayerNote[], revoiced = 0): Omit<KeysLayer, 'index'> => {
    const sorted = list.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    const pitches = sorted.map((n) => n.pitch)
    return { kind, ...LAYER_TEXT[kind], notes: sorted, revoiced, low: Math.min(...pitches), high: Math.max(...pitches) }
  }
  /** Every onset made playable by one hand (single notes and small chords stay as they are). */
  const forHand = (kind: LayerKind, list: LayerNote[][]) => {
    let revoiced = 0
    const out: LayerNote[] = []
    for (const g of list) {
      const r = oneHandChord(g, maxNotes)
      revoiced += r.changed
      out.push(...r.notes)
    }
    return make(kind, out, revoiced)
  }

  if (chordShare(groups) < 0.15) {
    // A line: one hand plays it as it is (an occasional double note is kept if it fits the hand).
    return [{ index: 0, ...forHand('all', groups) }]
  }

  // A left hand / bass line: a low register clearly apart from the rest, mostly one note at a time.
  let upper = notes
  let bass: LayerNote[] | null = null
  let bassLeftOut = 0 // other notes of low onsets: the bass line keeps the lowest one
  if (notes.length >= 8) {
    const split = otsuSplit(notes)
    const low = notes.filter((n) => n.pitch < split)
    const high = notes.filter((n) => n.pitch >= split)
    const enough = (xs: LayerNote[]) => xs.length >= Math.max(4, 0.1 * notes.length)
    if (
      enough(low) &&
      enough(high) &&
      median(high.map((n) => n.pitch)) - median(low.map((n) => n.pitch)) >= HAND_SPAN &&
      median(low.map((n) => n.pitch)) < 57 &&
      chordShare(onsetGroups(low)) < 0.35
    ) {
      bass = lowestLine(low)
      bassLeftOut = low.length - bass.length
      upper = high
    }
  }

  const U = onsetGroups(upper)
  const lone = U.filter((g) => distinct(g) === 1)
  // A tune on top of chords shows itself by single notes between the chords, or by a top note
  // that sits above the chord and lasts a different time (a lead over a pad).
  const ownTop = (g: LayerNote[]) => {
    const s = g.slice().sort((a, b) => b.pitch - a.pitch)
    const rest = s.filter((n) => n.pitch !== s[0].pitch)
    if (!rest.length) return false
    const d = median(rest.map((n) => n.dur))
    return s[0].pitch - rest[0].pitch >= 3 && Math.abs(s[0].dur - d) >= 0.35 * Math.max(s[0].dur, d)
  }
  const topped = U.filter((g) => distinct(g) > 1 && ownTop(g))
  if (U.length - lone.length < 0.15 * U.length) {
    // What is left above the bass is a tune.
    layers.push(forHand('melody', U))
  } else if (!(opts.topAsMelody || opts.melodic || lone.length + topped.length >= 0.3 * U.length)) {
    // Block chords (pads, strummed chords): the top note belongs to the chord.
    layers.push(forHand('chords', U))
  } else {
    // The tune lives where those notes are; a chord's top note in that range, not under a
    // melody note still sounding, is the tune too (a piano right hand).
    const tunePitches = [...lone.map((g) => g[0].pitch), ...topped.map((g) => Math.max(...g.map((n) => n.pitch)))].sort((a, b) => a - b)
    const floor = opts.topAsMelody || !tunePitches.length ? -Infinity : tunePitches[Math.floor(0.25 * (tunePitches.length - 1))] - 2
    const melody: LayerNote[] = []
    const chordGroups: LayerNote[][] = []
    let last: LayerNote | null = null
    for (const g of U) {
      const sorted = g.slice().sort((a, b) => b.pitch - a.pitch)
      const top = sorted[0]
      const under = last !== null && last.pitch > top.pitch && last.start + last.dur > top.start + 0.125
      if (distinct(sorted) === 1) {
        melody.push(top)
        last = top
      } else if (top.pitch >= floor && !under) {
        melody.push(top)
        last = top
        chordGroups.push(sorted.filter((n) => n.pitch !== top.pitch))
      } else chordGroups.push(sorted)
    }
    if (melody.length >= Math.max(4, 0.1 * U.length)) {
      layers.push(make('melody', monophonic(melody)))
      if (chordGroups.length) layers.push(forHand('chords', chordGroups))
    } else layers.push(forHand('chords', U))
  }
  if (bass?.length) layers.push(make('bass', bass, bassLeftOut))
  return layers.map((l, index) => ({ index, ...l }))
}

/**
 * The OCT setting for a stretch: the one that fits the most notes in the window; then the
 * one that keeps them nearest the middle of the keys; then the one closest to the default.
 */
export function bestOctave(notes: BNote[], kb: KeyboardSpec, range?: BeatRange | null): number {
  const inRange = range ? notes.filter((n) => inStretch(n.start, range)) : notes
  const pool = inRange.length ? inRange : notes
  if (!pool.length) return 0
  let best = 0
  let bestCost = Infinity
  for (let o = kb.octaveRange[0]; o <= kb.octaveRange[1]; o++) {
    const a = kb.lowNote + 12 * o
    const b = a + kb.count - 1
    const mid = (a + b) / 2
    let out = 0
    let centre = 0
    for (const n of pool) {
      if (n.pitch < a || n.pitch > b) out++
      centre += Math.abs(n.pitch - mid)
    }
    const cost = out * 100 + (centre / pool.length) * 0.5 + Math.abs(o) * 0.8
    if (cost < bestCost) {
      bestCost = cost
      best = o
    }
  }
  return best
}

/**
 * A layer on the keys with one OCT setting for `range` (or the whole layer). A stretch keeps
 * the layer's own OCT when all its notes fit there, so moving between loops of one layer
 * rarely asks for another OCT setting.
 */
export function fitLayer(layer: KeysLayer, kb: KeyboardSpec, range?: BeatRange | null): KeysFit {
  const home = bestOctave(layer.notes, kb)
  let octave = home
  if (range) {
    const inRange = layer.notes.filter((n) => inStretch(n.start, range))
    const lo = kb.lowNote + 12 * home
    const fitsHome = inRange.every((n) => n.pitch >= lo && n.pitch <= lo + kb.count - 1)
    if (!fitsHome) octave = bestOctave(inRange, kb)
  }
  const a = kb.lowNote + 12 * octave
  const width = kb.count - 1
  let folded = 0
  const events: KeyEvent[] = []
  const sorted = layer.notes.slice().sort((x, y) => x.start - y.start || x.pitch - y.pitch)
  for (const n of sorted) {
    let pitch = n.pitch
    while (pitch < a) pitch += 12
    while (pitch > a + width) pitch -= 12
    const moved = pitch !== n.pitch
    if (moved && (!range || inStretch(n.start, range))) folded++
    // An octave doubling folded onto its twin's key: one key, struck once.
    let twin: KeyEvent | undefined
    for (let j = events.length - 1; j >= 0 && n.start - events[j].start < ONSET; j--) if (events[j].pitch === pitch) twin = events[j]
    if (twin) {
      twin.dur = Math.max(twin.dur, n.dur)
      twin.folded = true
      continue
    }
    events.push({ idx: n.idx, start: n.start, dur: n.dur, pitch, srcPitch: n.src, vel: n.vel, key: pitch - a, folded: moved || n.pitch !== n.src })
  }
  events.sort((x, y) => x.start - y.start || x.pitch - y.pitch)
  return { octave, events, folded }
}

export function arrangeKeys(
  input: BNote[],
  _kb: KeyboardSpec,
  _grid: Grid,
  opts: LayerOptions = {},
): KeysArrangement {
  const warnings: string[] = []
  const layers = keysLayers(input, opts)
  if (layers.length > 1) {
    warnings.push(
      `Одной рукой всю партию не сыграть, поэтому она разложена на слои: ${layers.map((l) => l.label).join(', ')}. ` +
        'Учите и записывайте их по очереди — каждый на свою дорожку в DAW.',
    )
  }
  const revoiced = layers.reduce((s, l) => s + l.revoiced, 0)
  if (revoiced > 0) {
    warnings.push(
      `Чтобы всё бралось одной рукой, ${revoiced} ${plural(revoiced, 'нота переставлена', 'ноты переставлены', 'нот переставлены')} на октаву ` +
        `или ${plural(revoiced, 'убрана', 'убраны', 'убраны')}. Переставленные ноты отмечены пунктиром.`,
    )
  }
  return { kind: 'keys', layers, warnings }
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
