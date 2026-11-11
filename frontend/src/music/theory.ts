import type { Grid } from '../types'
import { barStartBeat, type BNote } from './grid'
import { pc, pcName, prefersFlats } from './notes'

export interface KeyInfo {
  tonic: number
  mode: 'major' | 'minor'
  confidence: number
  name: string
  flats: boolean
}

// Krumhansl–Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function pearson(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((s, x) => s + x, 0) / n
  const mb = b.reduce((s, x) => s + x, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

/** Duration × velocity weighted; bass register counts more (it usually carries the tonic). */
export function pitchClassHistogram(notes: { pitch: number; dur: number; vel?: number }[]): number[] {
  const h = new Array(12).fill(0)
  for (const n of notes) h[pc(n.pitch)] += n.dur * ((n.vel ?? 100) / 127) * (n.pitch < 52 ? 1.6 : 1)
  return h
}

/** How strongly the music points at a tonic: bass time on it, plus the first/last bass note. */
function tonicEvidence(notes: { pitch: number; dur: number; start?: number }[], tonic: number): number {
  const bass = notes.filter((n) => n.pitch < 55)
  const pool = bass.length ? bass : notes
  const total = pool.reduce((s, n) => s + n.dur, 0) || 1
  let score = pool.filter((n) => pc(n.pitch) === pc(tonic)).reduce((s, n) => s + n.dur, 0) / total
  const timed = pool.filter((n) => typeof n.start === 'number')
  if (timed.length) {
    const t0 = Math.min(...timed.map((n) => n.start!))
    const t1 = Math.max(...timed.map((n) => n.start!))
    const lowestAt = (t: number) => timed.filter((n) => Math.abs(n.start! - t) < 0.05).sort((a, b) => a.pitch - b.pitch)[0]
    if (pc(lowestAt(t0).pitch) === pc(tonic)) score += 0.5
    if (pc(lowestAt(t1).pitch) === pc(tonic)) score += 0.5
  }
  return score
}

export function detectKey(notes: { pitch: number; dur: number; vel?: number; start?: number }[]): KeyInfo | null {
  const h = pitchClassHistogram(notes)
  if (h.every((x) => x === 0)) return null
  const scores: { tonic: number; mode: 'major' | 'minor'; r: number }[] = []
  for (let t = 0; t < 12; t++) {
    const rot = (prof: number[]) => prof.map((_, i) => prof[(i - t + 12) % 12])
    scores.push({ tonic: t, mode: 'major', r: pearson(h, rot(MAJOR)) })
    scores.push({ tonic: t, mode: 'minor', r: pearson(h, rot(MINOR)) })
  }
  scores.sort((a, b) => b.r - a.r)
  let best = scores[0]
  // A relative major/minor shares the scale (Am–F–C–G is both i–VI–III–VII and vi–IV–I–V);
  // within a margin the tonic evidence decides and both names are shown.
  const relTonic = pc(best.tonic + (best.mode === 'major' ? 9 : 3))
  let rel = scores.find((s) => s.mode !== best.mode && s.tonic === relTonic) ?? null
  if (rel && best.r - rel.r < 0.15) {
    if (tonicEvidence(notes, rel.tonic) > tonicEvidence(notes, best.tonic)) [best, rel] = [rel, best]
  } else rel = null
  const flats = prefersFlats(best.tonic, best.mode)
  const second = scores.find((s) => s !== best) ?? scores[1]
  const label = (k: { tonic: number; mode: 'major' | 'minor' }) =>
    `${pcName(k.tonic, flats)} ${k.mode === 'major' ? 'мажор' : 'минор'}`
  return {
    tonic: best.tonic,
    mode: best.mode,
    confidence: Math.max(0, Math.min(1, Math.abs(best.r - second.r) * 5 + best.r * 0.5)),
    name: rel ? `${label(best)} (≈ ${label(rel)})` : label(best),
    flats,
  }
}

export interface ChordSeg {
  start: number
  end: number
  root: number
  quality: string
  bass: number | null
  name: string
}

interface Template {
  q: string
  iv: number[]
  prior: number
}

// Extensions need clear evidence: a passing melody note must not turn Am into Am7.
const TEMPLATES: Template[] = [
  { q: '', iv: [0, 4, 7], prior: 0 },
  { q: 'm', iv: [0, 3, 7], prior: 0 },
  { q: '7', iv: [0, 4, 7, 10], prior: -0.06 },
  { q: 'maj7', iv: [0, 4, 7, 11], prior: -0.06 },
  { q: 'm7', iv: [0, 3, 7, 10], prior: -0.06 },
  { q: '5', iv: [0, 7], prior: -0.02 },
  { q: 'sus2', iv: [0, 2, 7], prior: -0.07 },
  { q: 'sus4', iv: [0, 5, 7], prior: -0.07 },
  { q: 'dim', iv: [0, 3, 6], prior: -0.07 },
  { q: 'aug', iv: [0, 4, 8], prior: -0.08 },
  { q: 'm7b5', iv: [0, 3, 6, 10], prior: -0.08 },
  { q: '6', iv: [0, 4, 7, 9], prior: -0.09 },
  { q: 'm6', iv: [0, 3, 7, 9], prior: -0.09 },
  { q: 'add9', iv: [0, 2, 4, 7], prior: -0.09 },
]

/** Best chord for a pitch-class weight vector (+ optional bass pitch class). */
export function matchChord(weights: number[], bassPc: number | null): { root: number; quality: string; score: number } | null {
  const total = weights.reduce((s, x) => s + x, 0)
  if (total <= 0) return null
  const w = weights.map((x) => x / total)
  const active = w.filter((x) => x > 0.04).length
  if (active < 2) return null
  let best: { root: number; quality: string; score: number } | null = null
  for (let r = 0; r < 12; r++) {
    for (const t of TEMPLATES) {
      const tones = new Set(t.iv.map((i) => (r + i) % 12))
      let inside = 0
      let outside = 0
      let missing = 0
      for (let k = 0; k < 12; k++) {
        if (tones.has(k)) {
          inside += w[k]
          if (w[k] < 0.03) missing++
        } else outside += w[k]
      }
      let score = inside - 0.6 * outside + t.prior - 0.18 * missing
      if (bassPc !== null && bassPc === r) score += 0.1
      if (!best || score > best.score) best = { root: r, quality: t.q, score }
    }
  }
  return best && best.score > 0.25 ? best : null
}

export function chordName(root: number, quality: string, bass: number | null, flats: boolean): string {
  const base = `${pcName(root, flats)}${quality}`
  return bass !== null && bass !== root ? `${base}/${pcName(bass, flats)}` : base
}

/**
 * Chord per half bar (merged when equal) from harmonic notes; the bass part, if any,
 * decides the root between ambiguous candidates (Am7 vs C6) and slash chords.
 */
export function detectChords(
  harmonic: BNote[],
  bass: BNote[] | null,
  grid: Grid,
  fromBar: number,
  toBar: number,
  flats: boolean,
  segmentsPerBar = 2,
): ChordSeg[] {
  const out: ChordSeg[] = []
  const segLen = grid.barLength / segmentsPerBar
  for (let bar = fromBar; bar <= toBar; bar++) {
    for (let s = 0; s < segmentsPerBar; s++) {
      const a = barStartBeat(grid, bar) + s * segLen
      const b = a + segLen
      const w = new Array(12).fill(0)
      let lowest: number | null = null
      for (const n of harmonic) {
        const ov = Math.min(b, n.start + n.dur) - Math.max(a, n.start)
        if (ov <= 0) continue
        // Sustained notes carry the harmony; short (melodic) notes count proportionally less.
        w[pc(n.pitch)] += ov * (n.vel / 127) * Math.min(1, n.dur)
        if (lowest === null || n.pitch < lowest) lowest = n.pitch
      }
      let bassPc: number | null = null
      if (bass && bass.length) {
        const bw = new Array(12).fill(0)
        for (const n of bass) {
          const ov = Math.min(b, n.start + n.dur) - Math.max(a, n.start)
          if (ov > 0) bw[pc(n.pitch)] += ov
        }
        const m = Math.max(...bw)
        if (m > 0) {
          bassPc = bw.indexOf(m)
          for (let k = 0; k < 12; k++) w[k] += bw[k] * 0.35
        }
      } else if (lowest !== null) {
        bassPc = pc(lowest)
      }
      const match = matchChord(w, bassPc)
      if (!match) continue
      const slash = bassPc !== null && bassPc !== match.root ? bassPc : null
      const name = chordName(match.root, match.quality, slash, flats)
      const prev = out[out.length - 1]
      const adjacent = prev && Math.abs(prev.end - a) < 1e-6
      if (adjacent && prev.name === name) {
        prev.end = b
      } else if (adjacent && s > 0 && prev.root === match.root && prev.bass === slash && nested(prev.quality, match.quality)) {
        // Same root within one bar, one chord's tones inside the other's: a melodic colour
        // (F → Fmaj7, F5 → F), not a chord change. F → Fm or Cmaj7 → C7 stay two chords.
        if (qualityRank(match.quality) < qualityRank(prev.quality)) {
          prev.quality = match.quality
          prev.name = name
        }
        prev.end = b
      } else out.push({ start: a, end: b, root: match.root, quality: match.quality, bass: slash, name })
    }
  }
  return out
}

const TEMPLATE_TONES = new Map(TEMPLATES.map((t) => [t.q, t.iv]))

function nested(a: string, b: string): boolean {
  const x = TEMPLATE_TONES.get(a)
  const y = TEMPLATE_TONES.get(b)
  if (!x || !y) return false
  const within = (p: number[], q: number[]) => p.every((i) => q.includes(i))
  return within(x, y) || within(y, x)
}

function qualityRank(q: string): number {
  if (q === '' || q === 'm') return 0
  if (q === '5') return 1
  if (q === '7' || q === 'm7' || q === 'maj7') return 2
  return 3
}
