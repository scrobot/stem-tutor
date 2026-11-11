import type { Grid } from '../types'
import { barStartBeat, noteBar } from './grid'

/** Anything with a start (beats) and a target (pitch or pad id) can be analysed. */
export interface PatternEvent {
  start: number
  target: number | string
}

export interface PatternUnit {
  index: number
  startBar: number
  bars: number
  startBeat: number
  endBeat: number
  patternId: number // -1 for an empty (rest) unit
  label: string
  empty: boolean
}

export interface Pattern {
  id: number
  label: string
  units: number[]
  variantOf: number | null
}

export interface PatternAnalysis {
  unitBars: number
  units: PatternUnit[]
  patterns: Pattern[]
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function barTokens(events: PatternEvent[], grid: Grid, firstBar: number, lastBar: number, steps: number): string[][] {
  const bars: string[][] = []
  for (let b = firstBar; b <= lastBar; b++) bars.push([])
  for (const e of events) {
    const bar = noteBar(grid, e.start)
    if (bar < firstBar || bar > lastBar) continue
    // Snap away float noise first, so a 32nd's half-step tie rounds the same way in every bar.
    const step = Math.round(Math.round((e.start - barStartBeat(grid, bar)) * steps * 1000) / 1000)
    bars[bar - firstBar].push(`${step}:${e.target}`)
  }
  for (const t of bars) t.sort()
  return bars
}

/** Shared events / size of the larger unit: one changed note of four → 0.75. */
function similarity(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1
  const ca = new Map<string, number>()
  for (const x of a) ca.set(x, (ca.get(x) ?? 0) + 1)
  let inter = 0
  const cb = new Map<string, number>()
  for (const x of b) cb.set(x, (cb.get(x) ?? 0) + 1)
  for (const [k, v] of ca) inter += Math.min(v, cb.get(k) ?? 0)
  return inter / Math.max(a.length, b.length)
}

/**
 * Split a part into repeated units (1/2/4/8 bars) so the learner only practises unique
 * material. The unit length minimises "bars to learn" = unique units × length; ties go
 * to the longer phrase (but 8-bar units only when strictly better).
 */
const PRIMES = ['′', '″', '‴']
const variantLabel = (base: string, n: number) => (n <= PRIMES.length ? `${base}${PRIMES[n - 1]}` : `${base}${n}`)

/** Count units that are distinct under a similarity tolerance (1 = exact match only). */
function distinctUnits(units: string[][], tolerance: number): number {
  const reps: string[][] = []
  for (const u of units) {
    if (!u.length) continue
    if (!reps.some((r) => similarity(r, u) >= tolerance)) reps.push(u)
  }
  return reps.length
}

/**
 * `tolerance` < 1 treats nearly identical units as the same pattern — for transcribed
 * parts, where one missed hat should not turn a loop into "A A′ A″ …".
 */
export function analyzePatterns(
  events: PatternEvent[],
  grid: Grid,
  firstBar: number,
  lastBar: number,
  stepsPerBeat = 4,
  tolerance = 1,
  unitBars?: number, // chosen by the user; otherwise the length that minimises bars to learn
): PatternAnalysis {
  const nBars = lastBar - firstBar + 1
  if (nBars <= 0) return { unitBars: 1, units: [], patterns: [] }
  const bars = barTokens(events, grid, firstBar, lastBar, stepsPerBeat)
  const unitTokens = (L: number, u: number) => bars.slice(u * L, u * L + L).flatMap((t, i) => t.map((x) => `${i}/${x}`))

  const forced = unitBars && unitBars > 0 ? Math.min(Math.round(unitBars), nBars) : null
  const candidates = forced ? [forced] : [1, 2, 4, 8].filter((L) => L === 1 || nBars >= 2 * L)
  let bestL = 1
  let bestCost = Infinity
  const preference = (L: number) => ({ 4: 0, 2: 1, 1: 2, 8: 3 })[L] ?? 9
  for (const L of candidates) {
    const units: string[][] = []
    for (let u = 0; u * L < nBars; u++) units.push(unitTokens(L, u))
    const cost = distinctUnits(units, tolerance) * L
    if (cost < bestCost || (cost === bestCost && preference(L) < preference(bestL))) {
      bestCost = cost
      bestL = L
    }
  }

  const units: PatternUnit[] = []
  const patterns: Pattern[] = []
  const sigToPattern = new Map<string, number>()
  const tokensOf: string[][] = []
  for (let u = 0; u * bestL < nBars; u++) {
    const slice = bars.slice(u * bestL, u * bestL + bestL)
    const tokens = slice.flatMap((t, i) => t.map((x) => `${i}/${x}`))
    const sig = slice.map((t) => t.join(',')).join('|')
    const startBar = firstBar + u * bestL
    const bars_ = slice.length
    const unit: PatternUnit = {
      index: u,
      startBar,
      bars: bars_,
      startBeat: barStartBeat(grid, startBar),
      endBeat: barStartBeat(grid, startBar + bars_),
      patternId: -1,
      label: '—',
      empty: tokens.length === 0,
    }
    if (!unit.empty) {
      let pid = sigToPattern.get(sig)
      if (pid === undefined) {
        let nearest: number | null = null
        let bestSim = 0
        for (const p of patterns) {
          const sim = similarity(tokens, tokensOf[p.id])
          if (sim > bestSim) {
            bestSim = sim
            nearest = p.id
          }
        }
        if (nearest !== null && bestSim >= tolerance && tolerance < 1) {
          pid = nearest // the same pattern, up to transcription noise
        } else {
          let variantOf: number | null = null
          if (nearest !== null && bestSim >= 0.7) variantOf = patterns[nearest].variantOf ?? nearest
          pid = patterns.length
          const base = variantOf === null ? null : patterns[variantOf]
          const n = base ? patterns.filter((p) => p.variantOf === base.id).length + 1 : 0
          const letterIdx = patterns.filter((p) => p.variantOf === null).length
          const label = base ? variantLabel(base.label, n) : (LETTERS[letterIdx] ?? `P${letterIdx + 1}`)
          patterns.push({ id: pid, label, units: [], variantOf })
          tokensOf[pid] = tokens
        }
        sigToPattern.set(sig, pid)
      }
      unit.patternId = pid
      unit.label = patterns[pid].label
      patterns[pid].units.push(u)
    }
    units.push(unit)
  }
  return { unitBars: bestL, units, patterns }
}
