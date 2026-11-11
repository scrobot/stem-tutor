/**
 * Falling-notes view (canvas). Lanes are the controller's keys (drawn as a real keyboard)
 * or the used pads. Time flows top → bottom in beats; the hit line sits on the keyboard.
 * Everything per-frame lives in refs so React never re-renders at 60 fps.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import { keyboardGeometry, type KeyGeom } from '../instruments/layout'
import type { OctaveChange } from '../music/arrange'
import { barStartBeat } from '../music/grid'
import { noteName, type OctaveNames } from '../music/notes'
import type { TutorEvent, TutorLanes } from '../tutorial/events'
import type { Grid } from '../types'

export type Grade = 'perfect' | 'good' | 'ok' | 'miss'
export type HoldGrade = 'held' | 'short' | 'long'

export interface WaterfallState {
  pressed: Set<number>
  wrong: Map<number, number>
  expected: Set<number> | null
  done: Set<number>
  grades: Map<number, Grade>
  /** Long notes being held: event → beat where the key was let go (null while still held). */
  held: Map<number, number | null>
  holdGrades: Map<number, HoldGrade>
  flashes: { lane: number; text: string; color: string; t: number }[]
}

export function newWaterfallState(): WaterfallState {
  return {
    pressed: new Set(),
    wrong: new Map(),
    expected: null,
    done: new Set(),
    grades: new Map(),
    held: new Map(),
    holdGrades: new Map(),
    flashes: [],
  }
}

interface Props {
  lanes: TutorLanes
  events: TutorEvent[]
  grid: Grid
  getNow: () => number
  state: MutableRefObject<WaterfallState>
  changes: OctaveChange[]
  loop: { start: number; end: number } | null
  octaveAt: (beat: number) => number
  names: OctaveNames
  zoom: number
}

const GRADE_COLOR: Record<Grade, string> = { perfect: '#5bd6a7', good: '#9be37a', ok: '#ffd36b', miss: '#ff6b6b' }

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  g.beginPath()
  g.moveTo(x + rr, y)
  g.arcTo(x + w, y, x + w, y + h, rr)
  g.arcTo(x + w, y + h, x, y + h, rr)
  g.arcTo(x, y + h, x, y, rr)
  g.arcTo(x, y, x + w, y, rr)
  g.closePath()
}

export function Waterfall(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    const el = canvas.current!
    const ctx = el.getContext('2d')!
    let raf = 0
    let w = 0
    let h = 0
    let dpr = 1
    const resize = () => {
      const r = el.getBoundingClientRect()
      dpr = window.devicePixelRatio || 1
      w = Math.max(200, r.width)
      h = Math.max(200, r.height)
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    let keyCache: { key: string; geo: KeyGeom[] } | null = null
    const laneGeo = (p: Props, kbTop: number, kbH: number): KeyGeom[] => {
      const k = `${p.lanes.kind}:${p.lanes.count}:${p.lanes.lowNote}:${w}:${kbTop}:${kbH}`
      if (keyCache?.key === k) return keyCache.geo
      let geo: KeyGeom[]
      if (p.lanes.kind === 'keys') geo = keyboardGeometry(p.lanes.lowNote, p.lanes.count, 0, kbTop, w, kbH)
      else {
        const gap = 10
        const lw = Math.min(150, (w - gap * (p.lanes.count + 1)) / Math.max(1, p.lanes.count))
        const total = lw * p.lanes.count + gap * (p.lanes.count - 1)
        const x0 = (w - total) / 2
        geo = Array.from({ length: p.lanes.count }, (_, i) => ({ index: i, black: false, x: x0 + i * (lw + gap), y: kbTop, w: lw, h: kbH }))
      }
      keyCache = { key: k, geo }
      return geo
    }

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const p = propsRef.current
      const st = p.state.current
      const now = p.getNow()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const keys = p.lanes.kind === 'keys'
      const kbH = keys ? Math.max(80, Math.min(150, h * 0.24)) : 78
      const hitY = h - kbH - 6
      const ppb = (hitY / 8) * p.zoom // pixels per beat: ~8 beats visible at zoom 1
      const yOf = (beat: number) => hitY - (beat - now) * ppb
      const geo = laneGeo(p, hitY + 6, kbH)
      const visFrom = now - (kbH + 6) / ppb
      const visTo = now + hitY / ppb

      // Background + loop shading.
      ctx.fillStyle = '#0d1015'
      ctx.fillRect(0, 0, w, h)
      if (keys) {
        for (const kg of geo) {
          if (kg.black) continue
          ctx.fillStyle = kg.index % 2 ? '#10141a' : '#0e1217'
          ctx.fillRect(kg.x, 0, kg.w, hitY)
        }
      } else {
        for (const kg of geo) {
          ctx.fillStyle = '#121720'
          ctx.fillRect(kg.x, 0, kg.w, hitY)
        }
      }
      if (p.loop) {
        ctx.fillStyle = 'rgba(0,0,0,0.58)'
        const yEnd = yOf(p.loop.end)
        if (yEnd > 0) ctx.fillRect(0, 0, w, Math.min(hitY, yEnd))
        const yStart = yOf(p.loop.start)
        if (yStart < hitY) ctx.fillRect(0, Math.max(0, yStart), w, hitY - Math.max(0, yStart))
      }

      // Bar and beat lines.
      const g = p.grid
      const firstBar = Math.floor((visFrom - g.firstDownbeat) / g.barLength) - 1
      const lastBar = Math.ceil((visTo - g.firstDownbeat) / g.barLength) + 1
      ctx.font = '600 12px var(--sans, system-ui)'
      for (let bar = firstBar; bar <= lastBar; bar++) {
        const b0 = barStartBeat(g, bar)
        for (let k = 0; k < g.barLength; k++) {
          const y = yOf(b0 + k)
          if (y < 0 || y > hitY) continue
          ctx.fillStyle = k === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)'
          ctx.fillRect(0, y, w, k === 0 ? 1.5 : 1)
          if (k === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.45)'
            ctx.fillText(`${bar + 1}`, 6, y - 4)
          }
        }
      }

      // Octave change markers.
      for (const c of p.changes) {
        const y = yOf(c.beat)
        if (y < -20 || y > hitY + 4) continue
        ctx.strokeStyle = '#ffb547'
        ctx.setLineDash([8, 6])
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
        ctx.setLineDash([])
        const up = c.to > c.from
        const n = Math.abs(c.to - c.from)
        const text = `${up ? '▲ OCT +' : '▼ OCT −'} ×${n}  →  OCT ${c.to > 0 ? '+' : ''}${c.to}`
        ctx.font = '700 14px var(--sans, system-ui)'
        const tw = ctx.measureText(text).width
        ctx.fillStyle = '#ffb547'
        roundRect(ctx, w - tw - 28, y - 26, tw + 18, 22, 6)
        ctx.fill()
        ctx.fillStyle = '#111'
        ctx.fillText(text, w - tw - 19, y - 10)
      }

      // Events.
      const evs = p.events
      const sounding = new Set<number>()
      ctx.font = '700 12px var(--sans, system-ui)'
      for (const e of evs) {
        if (e.start > visTo) break
        if (e.start + e.dur < visFrom) continue
        const kg = geo[e.lane]
        if (!kg) continue
        const yBottom = yOf(e.start)
        const hh = Math.max(e.drum ? 10 : 8, e.dur * ppb - 2)
        const x = kg.x + (keys ? 2 : 6)
        const ww = kg.w - (keys ? 4 : 12)
        const done = st.done.has(e.i)
        const grade = st.grades.get(e.i)
        if (e.start <= now + 0.02 && e.start + e.dur > now - 0.02) sounding.add(e.lane)
        ctx.globalAlpha = done ? 0.25 : 1
        ctx.fillStyle = grade === 'miss' ? '#5b2a2a' : e.color
        roundRect(ctx, x, yBottom - hh, ww, hh, 5)
        ctx.fill()
        // A held long note glows from its start up to where the key is (or was) let go; the
        // part released too early stays dark.
        const heldTo = st.held.get(e.i)
        if (heldTo !== undefined) {
          const until = Math.min(e.start + e.dur, heldTo ?? now)
          if (until > e.start) {
            const yTop = yOf(until)
            ctx.fillStyle = 'rgba(255,255,255,0.42)'
            roundRect(ctx, x, yTop, ww, yBottom - yTop, 5)
            ctx.fill()
          }
          if (st.holdGrades.get(e.i) === 'short' && heldTo !== null && heldTo < e.start + e.dur) {
            const yCut = yOf(heldTo)
            const yEnd = yBottom - hh
            ctx.fillStyle = 'rgba(0,0,0,0.5)'
            roundRect(ctx, x, yEnd, ww, yCut - yEnd, 5)
            ctx.fill()
          }
        }
        if (grade && grade !== 'miss') {
          ctx.strokeStyle = GRADE_COLOR[grade]
          ctx.lineWidth = 3
          ctx.stroke()
        }
        if (e.folded) {
          ctx.strokeStyle = '#fff'
          ctx.setLineDash([3, 3])
          ctx.lineWidth = 1.5
          ctx.stroke()
          ctx.setLineDash([])
        }
        if (keys && hh >= 18 && ww >= 16) {
          ctx.fillStyle = 'rgba(0,0,0,0.75)'
          ctx.textAlign = 'center'
          ctx.fillText(e.label, x + ww / 2, yBottom - 6)
          ctx.textAlign = 'left'
        }
        ctx.globalAlpha = 1
      }

      // Hit line.
      ctx.fillStyle = 'rgba(111,168,255,0.9)'
      ctx.fillRect(0, hitY, w, 2)

      // Keyboard / pads.
      const expected = st.expected ?? sounding
      const nowMs = performance.now()
      const drawLane = (kg: KeyGeom) => {
        const i = kg.index
        const wrongAt = st.wrong.get(i)
        const wrong = wrongAt !== undefined && nowMs - wrongAt < 350
        const pressed = st.pressed.has(i)
        const exp = expected.has(i)
        let fill: string
        if (keys) fill = kg.black ? '#15181d' : '#e9edf2'
        else fill = '#1b212b'
        if (exp) fill = keys ? (kg.black ? '#3d6fd6' : '#9cc0ff') : p.lanes.colors[i] ?? '#9cc0ff'
        if (pressed) fill = '#6fa8ff'
        if (wrong) fill = '#ff6b6b'
        ctx.fillStyle = fill
        roundRect(ctx, kg.x + 1, kg.y, kg.w - 2, kg.h, keys ? 4 : 10)
        ctx.fill()
        ctx.strokeStyle = keys ? '#0b0d10' : (p.lanes.colors[i] ?? '#333')
        ctx.lineWidth = keys ? 1 : 2
        ctx.stroke()
        if (!keys) {
          ctx.fillStyle = exp || pressed ? '#111' : (p.lanes.colors[i] ?? '#ccc')
          ctx.textAlign = 'center'
          ctx.font = '700 13px var(--sans, system-ui)'
          const [padName, ...rest] = (p.lanes.labels[i] ?? '').split(' ')
          ctx.fillText(padName, kg.x + kg.w / 2, kg.y + 26)
          ctx.font = '600 12px var(--sans, system-ui)'
          ctx.fillText(rest.join(' '), kg.x + kg.w / 2, kg.y + 46)
          ctx.textAlign = 'left'
        }
      }
      for (const kg of geo) if (!kg.black) drawLane(kg)
      for (const kg of geo) if (kg.black) drawLane(kg)
      if (keys) {
        // C labels on the keyboard, for orientation at the current octave.
        const oct = p.octaveAt(now)
        ctx.font = '600 11px var(--sans, system-ui)'
        ctx.textAlign = 'center'
        for (const kg of geo) {
          const pitch = p.lanes.lowNote + 12 * oct + kg.index
          if (!kg.black && pitch % 12 === 0) {
            ctx.fillStyle = '#5a6472'
            ctx.fillText(noteName(pitch, p.names), kg.x + kg.w / 2, kg.y + kg.h - 8)
          }
        }
        ctx.textAlign = 'left'
      }

      // Feedback flashes.
      st.flashes = st.flashes.filter((f) => nowMs - f.t < 700)
      ctx.textAlign = 'center'
      ctx.font = '800 15px var(--sans, system-ui)'
      for (const f of st.flashes) {
        const kg = geo[f.lane]
        if (!kg) continue
        const age = (nowMs - f.t) / 700
        ctx.globalAlpha = 1 - age
        ctx.fillStyle = f.color
        ctx.fillText(f.text, kg.x + kg.w / 2, hitY - 12 - age * 30)
      }
      ctx.globalAlpha = 1
      ctx.textAlign = 'left'
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvas} className="waterfall" />
}
