/**
 * Progress through a cover plan, kept in the lesson's prefs so it survives a reload:
 * - `prefs.cover` — what the learner ticked on the plan page (written by the plan page);
 * - `prefs.coverLearned` — stretches played well in the trainer (merged one mark at a time by
 *   the backend, so two trainer tabs cannot overwrite each other).
 * Two keys, two writers: a patch replaces a whole prefs key, so neither page can undo the
 * other's ticks.
 */
import { MAX_LOOPS, type CoverLoop, type CoverTrack } from './plan'

export interface CoverPrefs {
  done: Record<string, boolean>
  include: Record<string, boolean>
  /** «выучена» unticked by hand (ms): only a good pass played after that ticks it again. */
  unticked: Record<string, number>
}

export interface LearnedMark {
  part: string
  layer: string
  start: number
  end: number
  acc: number
  tempo: number
  /** When it was played (ms since epoch; 0 for marks saved before times were kept). */
  at: number
}

/** A pass in «Играть» counts as learnt from this accuracy at this share of the original tempo. */
export const LEARN_ACCURACY = 0.85
export const LEARN_TEMPO = 0.9
const MAX_MARKS = 300

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (x: unknown): x is number => typeof x === 'number' && isFinite(x)

function boolMap(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (isRecord(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'boolean') out[k] = x
  return out
}

function numMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (isRecord(v)) for (const [k, x] of Object.entries(v)) if (isNum(x)) out[k] = x
  return out
}

export function readCoverPrefs(v: unknown): CoverPrefs {
  const r = isRecord(v) ? v : {}
  return { done: boolMap(r.done), include: boolMap(r.include), unticked: numMap(r.unticked) }
}

export function readLearned(v: unknown): LearnedMark[] {
  if (!Array.isArray(v)) return []
  const out: LearnedMark[] = []
  for (const m of v) {
    if (!isRecord(m) || typeof m.part !== 'string' || typeof m.layer !== 'string') continue
    if (![m.start, m.end, m.acc, m.tempo].every(isNum)) continue
    out.push({
      part: m.part,
      layer: m.layer,
      start: m.start as number,
      end: m.end as number,
      acc: m.acc as number,
      tempo: m.tempo as number,
      at: isNum(m.at) ? m.at : 0,
    })
  }
  return out
}

export function goodPass(entry: { accuracy: number; tempo: number }): boolean {
  return entry.accuracy >= LEARN_ACCURACY - 1e-9 && entry.tempo >= LEARN_TEMPO - 1e-6
}

/**
 * Add a mark: per stretch the best numbers and the newest time ("last played well" — a pass
 * after an untick counts even when it is no new best); a replayed stretch moves to the end, and
 * only the most recent few hundred are kept. The same rule as the backend's POST /cover/learned
 * (used here when the backend is an older version).
 */
export function addLearned(list: LearnedMark[], mark: LearnedMark): LearnedMark[] {
  const same = (m: LearnedMark) =>
    m.part === mark.part && m.layer === mark.layer && Math.abs(m.start - mark.start) < 1e-3 && Math.abs(m.end - mark.end) < 1e-3
  const old = list.find(same)
  const best = old && old.acc * old.tempo > mark.acc * mark.tempo ? old : mark
  return [...list.filter((m) => !same(m)), { ...best, at: Math.max(old?.at ?? 0, mark.at) }].slice(-MAX_MARKS)
}

/**
 * The best good pass that covered all of a loop's first time (a longer stretch counts too),
 * played after `after` (ms).
 */
export function learnedFor(
  marks: LearnedMark[],
  track: Pick<CoverTrack, 'partId' | 'layerKind'>,
  loop: Pick<CoverLoop, 'range'>,
  after = -Infinity,
): LearnedMark | null {
  let best: LearnedMark | null = null
  for (const m of marks) {
    if (m.part !== track.partId || m.layer !== track.layerKind) continue
    if (m.start > loop.range.start + 1e-3 || m.end < loop.range.end - 1e-3) continue
    if (m.at <= after) continue
    if (!best || m.acc * m.tempo > best.acc * best.tempo) best = m
  }
  return best
}

export const stepId = {
  setup: 'setup',
  create: (t: Pick<CoverTrack, 'id'>) => `${t.id}:create`,
  learn: (l: Pick<CoverLoop, 'id'>) => `${l.id}:learn`,
  record: (l: Pick<CoverLoop, 'id'>) => `${l.id}:rec`,
  place: (t: Pick<CoverTrack, 'id'>) => `${t.id}:place`,
  final: 'final',
}

/**
 * Is a loop learnt? A tick on the plan says yes; an untick says no until a good pass is played
 * after it; otherwise any good pass in the trainer that covered the loop says yes.
 */
export function loopLearned(
  prefs: CoverPrefs,
  marks: LearnedMark[],
  track: Pick<CoverTrack, 'partId' | 'layerKind'>,
  loop: Pick<CoverLoop, 'id' | 'range'>,
): { learned: boolean; mark: LearnedMark | null } {
  const id = stepId.learn(loop)
  const mark = learnedFor(marks, track, loop)
  if (prefs.done[id]) return { learned: true, mark }
  const untick = prefs.unticked[id]
  if (untick !== undefined) return { learned: learnedFor(marks, track, loop, untick) !== null, mark }
  return { learned: mark !== null, mark }
}

/** Tick or untick «выучена» by hand. */
export function setLearned(prefs: CoverPrefs, loop: Pick<CoverLoop, 'id'>, value: boolean, now: number): CoverPrefs {
  const id = stepId.learn(loop)
  const done = { ...prefs.done }
  const unticked = { ...prefs.unticked }
  if (value) {
    done[id] = true
    delete unticked[id]
  } else {
    delete done[id]
    unticked[id] = now
  }
  return { ...prefs, done, unticked }
}

/**
 * A track's loops split for the card: the most played ones first (up to MAX_LOOPS, in song
 * order), then the rarer rest (also in song order). Every loop is a step either way.
 */
export function splitLoops<L extends Pick<CoverLoop, 'at' | 'firstBar'>>(loops: L[]): { main: L[]; rest: L[] } {
  const ranked = loops.slice().sort((a, b) => b.at.length - a.at.length || a.firstBar - b.firstBar)
  const bySong = (a: L, b: L) => a.firstBar - b.firstBar
  return { main: ranked.slice(0, MAX_LOOPS).sort(bySong), rest: ranked.slice(MAX_LOOPS).sort(bySong) }
}

/** Ticked / all steps of the tracks being recorded (every loop counts). */
export function planProgress(
  tracks: (Pick<CoverTrack, 'id' | 'partId' | 'layerKind' | 'loops'> & { include: boolean })[],
  prefs: CoverPrefs,
  marks: LearnedMark[],
): { done: number; total: number } {
  let done = 0
  let total = 0
  const tick = (ok: boolean) => {
    total++
    if (ok) done++
  }
  tick(!!prefs.done[stepId.setup])
  for (const t of tracks) {
    if (!t.include) continue
    tick(!!prefs.done[stepId.create(t)])
    for (const l of t.loops) {
      tick(loopLearned(prefs, marks, t, l).learned)
      tick(!!prefs.done[stepId.record(l)])
    }
    tick(!!prefs.done[stepId.place(t)])
  }
  tick(!!prefs.done[stepId.final])
  return { done, total }
}
