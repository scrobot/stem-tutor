/**
 * The AI producer's side of the cover plan.
 *
 * The harness: the app sends a compact digest of its own analysis (tempo, chords by bar, the
 * tracks and their loops with a few notes each) and the ids the model may refer to; the
 * backend asks the model for a strict JSON schema with those ids as enums. The answer can only
 * rename, reorder, include / exclude tracks and add words — every note, bar and OCT setting
 * still comes from the rule-based plan. Whatever comes back is checked again here.
 */
import { DRUM_LABEL } from '../music/drums'
import { barOfBeat, barStartBeat, beatTime, inStretch } from '../music/grid'
import { noteName } from '../music/notes'
import type { InstrumentProfile } from '../instruments/profiles'
import type { AiModel, Lesson, ProducerAnswer, ProducerTrack } from '../types'
import type { CoverLoop, CoverPlan, CoverTrack } from './plan'

/** What the producer said about one track (already cleaned). */
export type AiNotes = Omit<ProducerTrack, 'id'>

export interface PlannedTrack extends CoverTrack {
  /** The AI producer's notes, if it was asked and knew this track. */
  ai: AiNotes | null
  /** Producer tips by loop id. */
  tips: Record<string, string>
}

export interface ProducedPlan {
  tracks: PlannedTrack[]
  ai: {
    summary: string
    tips: string[]
    model: string
    createdAt: string
    cost: number | null
    audio: boolean
    /** The track (or its analysis) changed since the answer: loop tips were left out. */
    stale: boolean
  } | null
}

const MAX_TRACKS = 40
const MAX_LOOP_IDS = 400
const LOOPS_PER_TRACK = 12
const NOTE_GROUPS = 32

const GM_FAMILY = [
  'piano', 'chromatic percussion', 'organ', 'guitar', 'bass', 'strings', 'ensemble', 'brass',
  'reed', 'pipe', 'synth lead', 'synth pad', 'synth effects', 'ethnic', 'percussive', 'sound effects',
]

export function clean(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** FNV-1a, 32 bit, hex: a short fingerprint of the digest (no crypto needed). */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** «A A A A B B» as runs: «A×4 B×2»; rests are «-». */
function structureOf(track: CoverTrack): string {
  const runs: { label: string; n: number }[] = []
  for (const b of track.blocks) {
    const label = b.label || '-'
    const last = runs[runs.length - 1]
    if (last && last.label === label) last.n++
    else runs.push({ label, n: 1 })
  }
  return runs.map((r) => (r.n > 1 ? `${r.label}×${r.n}` : r.label)).join(' ')
}

/** Chords by DAW bar, equal neighbours merged: «2–5: Am F | 6: C». */
function chordsByBar(plan: CoverPlan, lesson: Lesson, maxBars = 96): string {
  const grid = lesson.grid!
  const byBar = new Map<number, string[]>()
  for (const c of plan.lessonModel.chords) {
    const bar = barOfBeat(grid, c.start + 1e-6)
    const names = byBar.get(bar) ?? []
    if (names[names.length - 1] !== c.name) names.push(c.name)
    byBar.set(bar, names)
  }
  const bars = [...byBar.keys()].sort((a, b) => a - b)
  const runs: { from: number; to: number; text: string }[] = []
  for (const b of bars.slice(0, maxBars)) {
    const text = byBar.get(b)!.join(' ')
    const last = runs[runs.length - 1]
    if (last && last.text === text && last.to === b - 1) last.to = b
    else runs.push({ from: b, to: b, text })
  }
  const d = plan.dawOffset
  const out = runs.map((r) => `${r.from === r.to ? r.from + d : `${r.from + d}–${r.to + d}`}: ${r.text}`).join(' | ')
  return bars.length > maxBars ? `${out} | …` : out
}

/** The first pass of a loop as «beat:notes» (beats from the loop start), e.g. «0:A1 1.5:C3+E3». */
function loopNotes(plan: CoverPlan, track: CoverTrack, range: { start: number; end: number }): string {
  const model = plan.models.get(track.partId)
  if (!model) return ''
  const a = model.arrangement
  const items: { start: number; text: string }[] = []
  if (a.kind === 'pads') {
    for (const e of a.events) if (inStretch(e.start, range)) items.push({ start: e.start, text: DRUM_LABEL[e.cls] })
  } else {
    const layer = a.layers[track.layerIndex]
    for (const n of layer?.notes ?? []) if (inStretch(n.start, range)) items.push({ start: n.start, text: noteName(n.pitch) })
  }
  items.sort((x, y) => x.start - y.start)
  const groups: { beat: number; names: string[] }[] = []
  for (const it of items) {
    const beat = Math.round(Math.max(0, it.start - range.start) * 4) / 4
    const g = groups[groups.length - 1]
    if (g && g.beat === beat) {
      if (!g.names.includes(it.text)) g.names.push(it.text)
    } else groups.push({ beat, names: [it.text] })
  }
  const shown = groups.slice(0, NOTE_GROUPS).map((g) => `${g.beat}:${g.names.join('+')}`)
  return groups.length > NOTE_GROUPS ? `${shown.join(' ')} …(+${groups.length - NOTE_GROUPS})` : shown.join(' ')
}

function drumCounts(plan: CoverPlan, track: CoverTrack): string | undefined {
  const a = plan.models.get(track.partId)?.arrangement
  if (!a || a.kind !== 'pads') return undefined
  const counts = new Map<string, number>()
  for (const e of a.events) counts.set(DRUM_LABEL[e.cls], (counts.get(DRUM_LABEL[e.cls]) ?? 0) + 1)
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} ×${v}`)
    .join(', ')
}

export interface Digest {
  digest: Record<string, unknown>
  trackIds: string[]
  loopIds: string[]
  /** Fingerprint of the musical content (names left out). */
  key: string
}

/** The id the model sees for a track: the part's place in the lesson and its layer — no file names. */
export const trackAlias = (t: Pick<CoverTrack, 'partIndex' | 'layerKind'>) => `t${t.partIndex}:${t.layerKind}`
export const loopAlias = (t: Pick<CoverTrack, 'partIndex' | 'layerKind'>, l: Pick<CoverLoop, 'pattern'>) => `${trackAlias(t)}.p${l.pattern}`

const ROLE_RU: Record<CoverTrack['role'], string> = {
  drums: 'Ударные',
  bass: 'Бас',
  chords: 'Аккорды',
  melody: 'Мелодия',
  vocal: 'Вокал',
  other: 'Прочее',
}

/** The controller in the words of the digest: keys, OCT, pads (or none). */
export function playerLine(profile: Pick<InstrumentProfile, 'keys' | 'pads'>): string {
  const pads = profile.pads ? ` and ${profile.pads.count} drum pads` : '; no drum pads (drums are played on the keys)'
  return `one hand on a ${profile.keys.count}-key MIDI keyboard (one OCT setting per loop, no octave switching while playing)${pads}; records loops into Ableton Live`
}

/**
 * What is sent to the model: the analysis in compact form, shown to the learner before sending.
 * Without `names` the title, the artist and the part names stay at home (part names often are
 * the song or file name); ids never carry them.
 */
export function buildDigest(plan: CoverPlan, lesson: Lesson, opts: { names: boolean; player: string }): Digest {
  const build = (names: boolean) => {
    const trackIds: string[] = []
    const loopIds: string[] = []
    const tracks = plan.tracks.slice(0, MAX_TRACKS).map((t) => {
      const alias = trackAlias(t)
      trackIds.push(alias)
      const part = lesson.parts[t.partIndex]
      const budget = Math.max(0, MAX_LOOP_IDS - loopIds.length)
      const loops = t.loops
        .slice()
        .sort((a, b) => b.at.length - a.at.length || a.firstBar - b.firstBar)
        .slice(0, Math.min(LOOPS_PER_TRACK, budget))
        .sort((a, b) => a.firstBar - b.firstBar)
        .map((l) => {
          const id = loopAlias(t, l)
          loopIds.push(id)
          return {
            id,
            label: l.label,
            ...(l.variantOf ? { nearCopyOf: l.variantOf } : {}),
            bars: l.bars,
            plays: l.at.length,
            firstBar: l.firstBar + plan.dawOffset,
            ...(t.device === 'keys' ? { oct: l.octave } : {}),
            difficulty: l.difficulty,
            notes: loopNotes(plan, t, l.range),
          }
        })
      const gm = t.program !== null && !part?.isDrum ? ` (GM ${GM_FAMILY[Math.floor(t.program / 8)] ?? 'instrument'})` : ''
      const from =
        part?.origin === 'transcribed'
          ? `${names ? `stem "${t.partName}"` : 'stem'} (notes recognised from audio, may contain errors)`
          : `${names ? `MIDI track "${t.partName}"` : 'MIDI track'}${gm}`
      return {
        id: alias,
        from,
        layer:
          t.device === 'pads' ? 'drum pads' : t.layerCount > 1 ? `${t.layerKind} layer (the part is split for one hand)` : 'whole part',
        proposedName: names ? t.name : ROLE_RU[t.role],
        role: t.role,
        includedByRules: t.include,
        ...(t.skipReason ? { ruleNote: t.skipReason } : {}),
        ...(t.device === 'keys'
          ? {
              range: `${noteName(t.low)}–${noteName(t.high)}`,
              notesAtOnceMax: t.maxChord,
              chordShare: Math.round(t.chordShare * 100) / 100,
              meanNoteBeats: Math.round(t.meanDur * 100) / 100,
            }
          : { hits: drumCounts(plan, t) }),
        notesPerBar: Math.round(t.perBar * 10) / 10,
        blockBars: t.unitBars,
        structure: structureOf(t),
        loopsTotal: t.loops.length,
        loops,
      }
    })
    const song = {
      ...(names ? { title: lesson.title, ...(lesson.artist ? { artist: lesson.artist } : {}) } : {}),
      tempoBpm: Math.round(plan.bpm * 100) / 100,
      meter: `${plan.timeSig[0]}/${plan.timeSig[1]}`,
      key: plan.keyName,
      bars: plan.lastBar - plan.firstBar + 1,
      chordsByBar: chordsByBar(plan, lesson),
    }
    const digest = {
      about:
        'StemTutor analysis of the song. Bars are numbered as in Ableton after importing the exported files (bar 1 = file start). ' +
        'Loop notes: beat from the loop start, then note names (C3 = middle C, Ableton naming) or drum names.',
      player: opts.player,
      song,
      tracks,
    }
    return { digest, trackIds, loopIds }
  }
  // The fingerprint is of the music only, so the names box does not make an answer stale.
  const key = fingerprint(JSON.stringify(build(false).digest))
  return { ...build(opts.names), key }
}

/**
 * The plan with the producer's answer applied. Ids are the digest's aliases (full plan ids
 * are accepted too); unknown ones are ignored, texts are trimmed, and an answer that would
 * leave no track to record is ignored on that point.
 */
export function applyProducer(plan: CoverPlan, answer: ProducerAnswer | null, currentKey: string): ProducedPlan {
  const base: PlannedTrack[] = plan.tracks.map((t) => ({ ...t, ai: null, tips: {} }))
  const r = answer?.result
  if (!answer || !r) return { tracks: base, ai: null }
  const byId = new Map<string, PlannedTrack>()
  const loopOf = new Map<string, { track: PlannedTrack; loopId: string }>()
  for (const t of base) {
    byId.set(trackAlias(t), t)
    byId.set(t.id, t)
    for (const l of t.loops) {
      loopOf.set(loopAlias(t, l), { track: t, loopId: l.id })
      loopOf.set(l.id, { track: t, loopId: l.id })
    }
  }
  const notes = new Map<string, AiNotes>()
  for (const x of Array.isArray(r.tracks) ? r.tracks : []) {
    const t = x && byId.get(x.id)
    if (!t || notes.has(t.id)) continue
    notes.set(t.id, {
      include: x.include !== false,
      name: clean(x.name, 40),
      what: clean(x.what, 300),
      instrument: clean(x.instrument, 300),
      sound: clean(x.sound, 300),
      simplify: clean(x.simplify, 300),
    })
  }
  const keepsSome = base.some((t) => notes.get(t.id)?.include ?? t.include)
  const stale = answer.digestKey !== currentKey
  for (const t of base) {
    const n = notes.get(t.id)
    if (!n) continue
    t.ai = n
    if (keepsSome) t.include = n.include
    if (n.name) t.name = n.name
  }
  if (!stale) {
    for (const tip of Array.isArray(r.loopTips) ? r.loopTips : []) {
      const owner = tip && loopOf.get(tip.id)
      const text = clean(tip?.tip, 300)
      if (owner && text && !owner.track.tips[owner.loopId]) owner.track.tips[owner.loopId] = text
    }
  }
  const order: PlannedTrack[] = []
  for (const id of Array.isArray(r.order) ? r.order : []) {
    const t = byId.get(id)
    if (t && !order.includes(t)) order.push(t)
  }
  for (const t of base) if (!order.includes(t)) order.push(t)
  return {
    tracks: order,
    ai: {
      summary: clean(r.summary, 800),
      tips: (Array.isArray(r.tips) ? r.tips : []).map((x) => clean(x, 300)).filter(Boolean).slice(0, 6),
      model: answer.model,
      createdAt: answer.createdAt,
      cost: typeof answer.usage?.cost === 'number' ? answer.usage.cost : null,
      audio: !!answer.audio,
      stale,
    },
  }
}

/** About how much one plan costs with a model (USD), from the digest size and an answer of ~2k tokens. */
export function estimateCost(m: AiModel, digestChars: number, audioSec: number): number | null {
  if (m.promptPrice === null || m.completionPrice === null) return null
  const prompt = digestChars / 3 + 900 // the digest plus the instructions
  const completion = 2000
  let usd = (prompt * m.promptPrice + completion * m.completionPrice) / 1e6
  if (audioSec > 0) usd += ((audioSec * 32) * (m.audioPrice ?? m.promptPrice)) / 1e6
  return usd
}

export function fmtUsd(v: number | null): string {
  if (v === null) return 'цена неизвестна'
  if (v === 0) return 'бесплатно'
  if (v < 0.01) return 'меньше 1 цента'
  return `≈ $${v < 1 ? v.toFixed(2) : v.toFixed(1)}`
}

/**
 * Where to let the model listen: about 30 s where most of the tracks play together
 * (`bar`/`bars`: the same stretch in app bars, for the label). Null when the lesson has no audio.
 */
export function audioWindow(
  plan: CoverPlan,
  lesson: Lesson,
  tracks: Pick<CoverTrack, 'blocks' | 'include'>[],
  seconds = 30,
): { start: number; duration: number; bar: number; bars: number } | null {
  const grid = lesson.grid
  const hasAudio = !!lesson.media.mix || lesson.parts.some((p) => !!p.media.stemWav)
  if (!grid || !hasAudio || lesson.durationSec < 5) return null
  const barSec = (60 / (grid.bpm || 120)) * (grid.barLength || 4)
  // A short song is heard whole (the backend cuts the clip at the end of the audio).
  const span = Math.max(1, Math.min(Math.round(seconds / barSec), plan.lastBar - plan.firstBar + 1))
  const score = new Map<number, number>()
  for (const t of tracks) {
    if (!t.include) continue
    for (const b of t.blocks) {
      if (!b.label) continue
      for (let k = 0; k < b.bars; k++) score.set(b.startBar + k, (score.get(b.startBar + k) ?? 0) + 1)
    }
  }
  let best = plan.firstBar
  let bestSum = -1
  for (let s = plan.firstBar; s <= Math.max(plan.firstBar, plan.lastBar - span + 1); s++) {
    let sum = 0
    for (let k = 0; k < span; k++) sum += score.get(s + k) ?? 0
    if (sum > bestSum) {
      bestSum = sum
      best = s
    }
  }
  const duration = Math.min(seconds, lesson.durationSec)
  const start = Math.max(0, Math.min(beatTime(grid, barStartBeat(grid, best)), lesson.durationSec - duration))
  if (duration < 5) return null
  return { start: Math.round(start * 100) / 100, duration: Math.round(duration * 100) / 100, bar: best, bars: span }
}
