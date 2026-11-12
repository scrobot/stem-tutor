/**
 * «План кавера»: how to rebuild a track in a DAW by hand — track by track, loop by loop.
 *
 * Built by rules from what the trainer already knows. Every part is laid on the controller
 * (one-hand layers on the keys, or hits on the pads); a track of the plan is one such layer.
 * Each track is split into repeated blocks — exactly the trainer's «Из чего состоит дорожка»
 * (music/model.ts layerBlocks) — so a loop is learnt and recorded once, and its clip is copied
 * to every place where it repeats. An AI producer (optional, see producer.ts) may rename,
 * reorder, include or exclude tracks and explain them — the notes always come from here.
 */
import { effectiveProfile, keyboardSpec, type InstrumentProfile } from '../instruments/profiles'
import { fitLayer, onsetGroups, type BeatRange, type KeysLayer, type LayerKind } from '../music/arrange'
import { DRUM_LABEL } from '../music/drums'
import { plural } from '../music/explain'
import { exportOrigin, inStretch } from '../music/grid'
import { buildLessonModel, buildPartModel, layerBlocks, type LessonModel, type PartModel } from '../music/model'
import type { PatternEvent } from '../music/patterns'
import type { Calibration, Lesson, Role } from '../types'

export interface CoverLoop {
  /**
   * `<track id>.b<start>_<end>` — named by where it first plays (beats), so the plan's ticks stay
   * on their loop when the learner changes «длина куска» (a loop that no longer exists simply
   * loses its tick). The AI sees pattern-based aliases instead (producer.ts loopAlias).
   */
  id: string
  /** The pattern id in the block analysis. */
  pattern: number
  /** A, B, A′ … — the same letters as «Из чего состоит дорожка» in the trainer. */
  label: string
  /** The loop this one is a near copy of (A for A′). */
  variantOf: string | null
  /** The first time it plays (beats). */
  range: BeatRange
  /** App bar index (0 = «такт 1» in the trainer) of the first time it plays. */
  firstBar: number
  bars: number
  /** Bars (app indices) where it starts, in song order. */
  at: number[]
  notes: number
  /** OCT setting for this loop (keys; 0 on pads). */
  octave: number
  /** Notes of the first pass moved by an octave to fit the keys. */
  folded: number
  difficulty: 1 | 2 | 3
}

/** One block of the song map: which loop plays there ('' and null: a rest). */
export interface CoverBlock {
  startBar: number
  bars: number
  label: string
  loopId: string | null
}

export interface CoverTrack {
  /** `<part id>:<layer kind>` (ASCII). */
  id: string
  partId: string
  /** Index of the part in lesson.parts (stable: the AI digest refers to tracks by it). */
  partIndex: number
  partName: string
  layerKind: LayerKind | 'pads'
  layerIndex: number
  layerCount: number
  layerLabel: string
  role: Role
  isDrum: boolean
  /** Name for the DAW track. */
  name: string
  /** What it does in the song, in plain words. */
  what: string
  /** Which Ableton sound to start from. */
  instrument: string
  /** How to make recording it easier (rules), or null. */
  tip: string | null
  device: 'keys' | 'pads'
  /** Pads: which note each sound is on (Drum Rack cells to fill), in pad order. */
  padMap: { note: number; label: string }[] | null
  /** The rules' choice; the AI and the learner may override it. */
  include: boolean
  skipReason: string | null
  /** OCT that fits the whole layer (most loops use it). */
  octave: number
  unitBars: number
  loops: CoverLoop[]
  blocks: CoverBlock[]
  noteCount: number
  low: number
  high: number
  perBar: number
  /** Share of note starts that are chords (2+ notes together). */
  chordShare: number
  maxChord: number
  /** Mean note length, beats. */
  meanDur: number
  origin: 'midi' | 'transcribed'
  program: number | null
}

export interface CoverPlan {
  lessonId: string
  bpm: number
  timeSig: [number, number]
  barLength: number
  keyName: string | null
  /** The song's bars (app indices, inclusive): from its first note to its last. */
  firstBar: number
  lastBar: number
  /** DAW bar number of an app bar: `bar + dawOffset` (exports start on the export origin). */
  dawOffset: number
  tracks: CoverTrack[]
  lessonModel: LessonModel
  /** Part models by part id (for MIDI exports). */
  models: Map<string, PartModel>
}

/** Recording order: rhythm first, then what the rest sits on, the melody last, the voice after it. */
const ROLE_ORDER: Record<Role, number> = { drums: 0, bass: 1, chords: 2, other: 3, melody: 4, vocal: 5 }

const WHAT: Record<Role, string> = {
  drums: 'Ритм трека: бочка, малый барабан, тарелки. Играется на пэдах.',
  bass: 'Низкая линия, на которой держится трек. Обычно одна нота за раз.',
  chords: 'Аккорды — несколько нот вместе. Задают настроение трека.',
  melody: 'Мелодия — то, что можно напеть.',
  vocal: 'Мелодия голоса. Её можно сыграть синтезатором.',
  other: 'Остальные звуки трека.',
}
const DRUMS_ON_KEYS = 'Ритм трека: бочка, малый барабан, тарелки. Играется на клавишах: каждая клавиша — свой барабан.'

/** Sound families of General MIDI programs (by program / 8) → where to look in Live's browser. */
const GM_FAMILY_SOUND: (string | null)[] = [
  'Sounds → Piano & Keys (пианино)',
  'Sounds → Mallets (колокольчики, маримба)',
  'Sounds → Piano & Keys (орган)',
  'Sounds → Guitar & Plucked (гитара)',
  'Sounds → Bass',
  'Sounds → Strings (струнные)',
  'Sounds → Strings (оркестр, хор)',
  'Sounds → Brass (духовые)',
  'Sounds → Winds (саксофон, кларнет)',
  'Sounds → Winds (флейта)',
  'Sounds → Lead',
  'Sounds → Pad',
  'Sounds → Ambient & Evolving',
  null,
  null,
  null,
]

export const MIN_NOTES = 8
/** Loops shown first on a track card; the rest (the rarer ones) sit under «ещё N». */
export const MAX_LOOPS = 8

function instrumentFor(role: Role, program: number | null, meanDur: number, chordShare: number): string {
  if (role === 'drums') return 'Drum Rack: браузер Live → Drums, готовый набор (Kit); звуки можно заменить на похожие.'
  const family = program !== null && program >= 0 ? GM_FAMILY_SOUND[Math.floor(program / 8)] ?? null : null
  if (family) return `Браузер Live → ${family}.`
  const pad = meanDur >= 1.5 && chordShare >= 0.3
  switch (role) {
    case 'bass':
      return 'Браузер Live → Sounds → Bass (например, пресет на Drift или Operator).'
    case 'chords':
      return pad ? 'Браузер Live → Sounds → Pad — для тянущихся аккордов.' : 'Браузер Live → Sounds → Piano & Keys или Synth Keys.'
    case 'melody':
      return 'Браузер Live → Sounds → Lead.'
    case 'vocal':
      return 'Браузер Live → Sounds → Lead или Voices — мягкий звук без резкой атаки.'
    default:
      return pad ? 'Браузер Live → Sounds → Pad.' : 'Браузер Live → Sounds → Synth Keys.'
  }
}

const bpmText = (bpm: number) => `${Number(bpm.toFixed(2))} BPM`

function tipFor(isDrum: boolean, hard: boolean, bpm: number): string | null {
  if (isDrum) {
    return (
      'Ударные удобно записывать в несколько кругов: сначала бочку, потом малый, потом тарелки. Для этого включите дозапись — ' +
      'кнопку MIDI Arrangement Overdub («+» рядом с кнопкой записи): новые удары добавятся в тот же клип. Когда ударные готовы, ' +
      'выключите её — иначе на следующих дорожках круги сложатся в один клип.'
    )
  }
  if (!hard) return null
  return (
    `Если в темпе трудно — запишите петлю медленнее: поставьте в Ableton ${bpmText(Math.round(bpm * 0.8))} вместо ${bpmText(bpm)}, ` +
    `запишите и верните ${bpmText(bpm)}. MIDI-клип заиграет в темпе трека, ноты не поплывут.`
  )
}

const safeId = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'x'

function difficultyOf(notes: { start: number; dur: number; pitch: number }[], bars: number, pads: boolean, folded: number): 1 | 2 | 3 {
  if (!notes.length) return 1
  const perBar = notes.length / Math.max(1, bars)
  let score: number
  if (pads) {
    score = perBar / 8
  } else {
    const groups = onsetGroups(notes.map((n, idx) => ({ ...n, vel: 100, idx })))
    const maxChord = Math.max(...groups.map((g) => g.length))
    const distinct = new Set(notes.map((n) => n.pitch)).size
    score = perBar / 4 + (maxChord >= 3 ? 1 : maxChord === 2 ? 0.5 : 0) + (folded > 0 ? 0.5 : 0) + (distinct > 8 ? 0.5 : 0)
  }
  return score < 1.25 ? 1 : score < 2.5 ? 2 : 3
}

interface LayerInput {
  kind: LayerKind | 'pads'
  index: number
  count: number
  label: string
  events: PatternEvent[]
  notes: { start: number; dur: number; pitch: number }[]
  layer: KeysLayer | null
}

function layerInputs(model: PartModel): LayerInput[] {
  const a = model.arrangement
  if (a.kind === 'pads') {
    return [
      {
        kind: 'pads',
        index: 0,
        count: 1,
        label: 'Пэды',
        events: a.events.map((e) => ({ start: e.start, target: `${e.bank}:${e.pad}` })),
        notes: a.events.map((e) => ({ start: e.start, dur: e.dur, pitch: e.note })),
        layer: null,
      },
    ]
  }
  return a.layers.map((l, i) => ({
    kind: l.kind,
    index: i,
    count: a.layers.length,
    label: l.label,
    events: l.notes.map((n) => ({ start: n.start, target: n.pitch })),
    notes: l.notes.map((n) => ({ start: n.start, dur: n.dur, pitch: n.pitch })),
    layer: l,
  }))
}

export function buildCoverPlan(
  lesson: Lesson,
  base: InstrumentProfile,
  calibration: Calibration | null,
  /** The learner's «длина куска» (settings.ui.unitBars): the trainer splits by it too. */
  opts: { unitBars?: number } = {},
): CoverPlan | null {
  const grid = lesson.grid
  if (!grid || lesson.status !== 'ready') return null
  const profile = effectiveProfile(base, calibration)
  const kb = keyboardSpec(profile)
  const lessonModel = buildLessonModel(lesson)
  const [firstBar, lastBar] = lessonModel.bars
  const dawOffset = Math.round((grid.firstDownbeat - exportOrigin(grid).beat) / (grid.barLength || 4)) + 1
  const models = new Map<string, PartModel>()
  const tracks: CoverTrack[] = []

  lesson.parts.forEach((part, partIndex) => {
    if (part.silent || !part.notes.length) return
    const model = buildPartModel(lesson, part, base, calibration)
    if (!model) return
    models.set(part.id, model)
    const a = model.arrangement
    for (const li of layerInputs(model)) {
      if (!li.events.length) continue
      // A voice stays a voice whatever its layers; drums stay drums on the keys too.
      const role: Role = part.isDrum ? 'drums' : part.role === 'vocal' ? 'vocal' : li.kind === 'all' || li.kind === 'pads' ? part.role : li.kind
      const id = `${safeId(part.id)}:${li.kind}`
      const analysis = layerBlocks(model, grid, li.kind === 'pads' ? null : li.index, opts.unitBars)
      const beat = (b: number) => `${+b.toFixed(3)}`
      const loopIdOf = new Map<number, string>()
      for (const p of analysis.patterns) {
        const u = analysis.units[p.units[0]]
        if (u) loopIdOf.set(p.id, `${id}.b${beat(u.startBeat)}_${beat(u.endBeat)}`)
      }
      const loops: CoverLoop[] = analysis.patterns.map((p) => {
        const units = p.units.map((i) => analysis.units[i])
        const first = units[0]
        const range = { start: first.startBeat, end: first.endBeat }
        const inside = li.notes.filter((n) => inStretch(n.start, range))
        const fit = li.layer ? fitLayer(li.layer, kb, range) : null
        const folded = fit?.folded ?? 0
        return {
          id: loopIdOf.get(p.id)!,
          pattern: p.id,
          label: p.label,
          variantOf: p.variantOf !== null ? analysis.patterns[p.variantOf]?.label ?? null : null,
          range,
          firstBar: first.startBar,
          bars: first.bars,
          at: units.map((u) => u.startBar),
          notes: inside.length,
          octave: fit?.octave ?? 0,
          folded,
          difficulty: difficultyOf(inside, first.bars, li.kind === 'pads', folded),
        }
      })
      const blocks: CoverBlock[] = analysis.units.map((u) => ({
        startBar: u.startBar,
        bars: u.bars,
        label: u.empty ? '' : u.label,
        loopId: u.empty ? null : loopIdOf.get(u.patternId) ?? null,
      }))
      const groups = li.kind === 'pads' ? [] : onsetGroups(li.notes.map((n, idx) => ({ ...n, vel: 100, idx })))
      const chordShare = groups.length ? groups.filter((g) => g.length > 1).length / groups.length : 0
      const maxChord = groups.length ? Math.max(...groups.map((g) => g.length)) : 1
      const meanDur = li.notes.reduce((s, n) => s + n.dur, 0) / li.notes.length
      const pitches = li.notes.map((n) => n.pitch)
      const nBars = Math.max(1, model.bars[1] - model.bars[0] + 1)
      let include = true
      let skipReason: string | null = null
      if (li.notes.length < MIN_NOTES) {
        include = false
        skipReason = 'В дорожке почти нет нот.'
      } else if (part.role === 'vocal') {
        include = false
        skipReason = 'Голос обычно оставляют из оригинала. Его мелодию можно сыграть синтезатором — включите, если хотите.'
      }
      const device = li.kind === 'pads' ? 'pads' : 'keys'
      tracks.push({
        id,
        partId: part.id,
        partIndex,
        partName: part.name,
        layerKind: li.kind,
        layerIndex: li.index,
        layerCount: li.count,
        layerLabel: li.label,
        role,
        isDrum: part.isDrum,
        name: li.count > 1 ? `${part.name} · ${li.label}` : part.name,
        what: role === 'drums' && device === 'keys' ? DRUMS_ON_KEYS : WHAT[role],
        instrument: instrumentFor(role, part.isDrum ? null : part.program ?? null, meanDur, chordShare),
        tip: tipFor(part.isDrum, loops.some((l) => l.difficulty >= 2), grid.bpm),
        device,
        padMap: a.kind === 'pads' ? a.slots.map((s) => ({ note: s.note, label: DRUM_LABEL[s.cls] })) : null,
        include,
        skipReason,
        octave: li.layer ? fitLayer(li.layer, kb).octave : 0,
        unitBars: analysis.unitBars,
        loops,
        blocks,
        noteCount: li.notes.length,
        low: pitches.length ? Math.min(...pitches) : 0,
        high: pitches.length ? Math.max(...pitches) : 0,
        perBar: li.notes.length / nBars,
        chordShare,
        maxChord,
        meanDur,
        origin: part.origin,
        program: part.program ?? null,
      })
    }
  })
  tracks.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || b.noteCount - a.noteCount)
  return {
    lessonId: lesson.id,
    bpm: grid.bpm,
    timeSig: grid.timeSig,
    barLength: grid.barLength,
    keyName: lessonModel.key?.name ?? null,
    firstBar,
    lastBar,
    dawOffset,
    tracks,
    lessonModel,
    models,
  }
}

// -- words for the song map ---------------------------------------------------------------

/** «такт 1» / «такты 1–4» as the trainer numbers them (bar 1 = the first downbeat). */
export function appBars(startBar: number, bars: number): string {
  const a = startBar + 1
  return bars <= 1 ? `такт ${a}` : `такты ${a}–${a + bars - 1}`
}

/** «такт 5» / «такты 5–8» in DAW numbering (bar 1 = where the exported files start). */
export function dawBars(plan: Pick<CoverPlan, 'dawOffset'>, startBar: number, bars: number): string {
  const a = startBar + plan.dawOffset
  return bars <= 1 ? `такт ${a}` : `такты ${a}–${a + bars - 1}`
}

/**
 * Where each loop goes in the arrangement (DAW bars), as runs: «2–17 (4 раза подряд), 26».
 * One entry per loop, in the order loops first appear.
 */
export function placement(plan: Pick<CoverPlan, 'dawOffset'>, track: Pick<CoverTrack, 'blocks' | 'loops'>): { loopId: string; label: string; text: string; count: number }[] {
  const out: { loopId: string; label: string; text: string; count: number }[] = []
  const loops = track.loops.slice().sort((a, b) => a.firstBar - b.firstBar)
  for (const loop of loops) {
    const runs: { start: number; n: number; bars: number }[] = []
    for (const b of track.blocks) {
      if (b.loopId !== loop.id) continue
      const last = runs[runs.length - 1]
      if (last && last.start + last.n * last.bars === b.startBar && last.bars === b.bars) last.n++
      else runs.push({ start: b.startBar, n: 1, bars: b.bars })
    }
    const parts = runs.map((r) =>
      r.n === 1
        ? `${r.start + plan.dawOffset}`
        : `${r.start + plan.dawOffset}–${r.start + r.n * r.bars - 1 + plan.dawOffset} (${r.n} ${plural(r.n, 'раз', 'раза', 'раз')} подряд)`,
    )
    out.push({ loopId: loop.id, label: loop.label, text: parts.join(', '), count: loop.at.length })
  }
  return out
}

export const DIFFICULTY_LABEL: Record<1 | 2 | 3, string> = { 1: 'лёгкая', 2: 'средняя', 3: 'сложная' }

export const octLabel = (o: number) => `OCT ${o > 0 ? '+' : o < 0 ? '−' : ''}${Math.abs(o)}`
