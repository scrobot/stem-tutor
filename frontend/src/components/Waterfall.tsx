/**
 * Falling-notes view (canvas) — a piano roll turned on its side: every note is a bar as long as
 * the note lasts, falling onto the key that plays it. Lanes are the controller's keys (drawn as
 * a real keyboard) or the used pads. Time flows top → bottom in beats; the hit line sits on
 * the keyboard.
 *
 * While playback is stopped the view can be scrolled with the wheel or the arrow keys (up = what
 * comes next) and a stretch to practise can be picked right on the notes: a double-click picks
 * one bar, a drag picks bars (with Alt: whole beats). A plain click only focuses the view.
 * Everything per-frame lives in refs so React never re-renders at 60 fps.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import { keyboardGeometry, type KeyGeom } from '../instruments/layout'
import { barOfBeat, barStartBeat } from '../music/grid'
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

export interface BeatRange {
  start: number
  end: number
}

/**
 * The stretch a click or a drag from beat `a` to beat `b` picks: the bars it touches (at least
 * one), or with `fine` the whole beats it touches.
 */
export function snapSelection(grid: Grid, a: number, b: number, fine = false): BeatRange {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (fine) {
    const start = Math.floor(lo + 1e-6)
    return { start, end: Math.max(start + 1, Math.ceil(hi - 1e-6)) }
  }
  const b0 = barOfBeat(grid, lo)
  const b1 = Math.max(b0, barOfBeat(grid, hi - 1e-6))
  return { start: barStartBeat(grid, b0), end: barStartBeat(grid, b1 + 1) }
}

/** "такт 5" / "такты 5–8" / "такт 5, доли 2–3" for a picked stretch. */
export function rangeLabel(grid: Grid, r: BeatRange): string {
  const b0 = barOfBeat(grid, r.start + 1e-6)
  const b1 = barOfBeat(grid, r.end - 1e-6)
  const whole = Math.abs(r.start - barStartBeat(grid, b0)) < 1e-6 && Math.abs(r.end - barStartBeat(grid, b1 + 1)) < 1e-6
  if (whole) return b0 === b1 ? `такт ${b0 + 1}` : `такты ${b0 + 1}–${b1 + 1}`
  const beatIn = (beat: number, bar: number) => Math.round((beat - barStartBeat(grid, bar)) * 100) / 100 + 1
  if (b0 === b1) {
    const s = beatIn(r.start, b0)
    const e = beatIn(r.end, b0) - 1
    return s === e ? `такт ${b0 + 1}, доля ${s}` : `такт ${b0 + 1}, доли ${s}–${e}`
  }
  return `с такта ${b0 + 1} (доля ${beatIn(r.start, b0)}) до такта ${b1 + 1}`
}

interface Props {
  lanes: TutorLanes
  events: TutorEvent[]
  grid: Grid
  getNow: () => number
  state: MutableRefObject<WaterfallState>
  loop: BeatRange | null
  /** The OCT setting the keys are drawn for (one per practice track). */
  octave: number
  names: OctaveNames
  zoom: number
  /** Stopped: the wheel scrolls the view and a click or drag over the notes picks bars. */
  interactive?: boolean
  onSelect?: (range: BeatRange) => void
  /** Scrolling stays within these beats. */
  bounds?: BeatRange
  /** The view jumps back to the play position whenever this changes. */
  resetKey?: string
  /** Ctrl + wheel: zoom by this factor. */
  onZoom?: (factor: number) => void
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

interface Drag {
  a: number
  b: number
  y0: number
  moved: boolean
  fine: boolean
  id: number
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

    // View state shared by the frame loop and the pointer handlers.
    let offset = 0 // beats the view is scrolled ahead (+) or back (−) of the play position
    let lastReset: string | undefined = propsRef.current.resetKey
    let drag: Drag | null = null
    const geom = { hitY: 0, ppb: 1, view: 0, real: 0 }
    let backPill: { x: number; y: number; w: number; h: number } | null = null

    const yToBeat = (y: number) => geom.view + (geom.hitY - y) / geom.ppb
    const localY = (e: PointerEvent | WheelEvent) => e.clientY - el.getBoundingClientRect().top
    const localX = (e: PointerEvent) => e.clientX - el.getBoundingClientRect().left
    const clampOffset = (o: number) => {
      const b = propsRef.current.bounds
      if (!b) return o
      const lo = b.start - 2 - geom.real
      const hi = Math.max(lo, b.end - geom.real)
      return Math.max(lo, Math.min(hi, o))
    }

    const onWheel = (e: WheelEvent) => {
      const p = propsRef.current
      if (e.ctrlKey && p.onZoom) {
        e.preventDefault()
        p.onZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)
        return
      }
      if (!p.interactive) return
      e.preventDefault()
      const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * h : e.deltaY
      offset = clampOffset(offset - px / geom.ppb)
    }
    const onKey = (e: KeyboardEvent) => {
      const p = propsRef.current
      if (!p.interactive) return
      const bar = p.grid.barLength
      const step = e.key === 'ArrowUp' ? bar : e.key === 'ArrowDown' ? -bar : e.key === 'PageUp' ? 4 * bar : e.key === 'PageDown' ? -4 * bar : 0
      if (step) {
        e.preventDefault()
        offset = clampOffset(offset + step)
      } else if (e.key === 'Home') {
        e.preventDefault()
        offset = 0
      }
    }
    const onDown = (e: PointerEvent) => {
      const p = propsRef.current
      if (!p.interactive || e.button !== 0) return
      const x = localX(e)
      const y = localY(e)
      if (backPill && x >= backPill.x && x <= backPill.x + backPill.w && y >= backPill.y && y <= backPill.y + backPill.h) {
        offset = 0
        return
      }
      if (y > geom.hitY || !p.onSelect) return
      const beat = yToBeat(y)
      drag = { a: beat, b: beat, y0: y, moved: false, fine: e.altKey, id: e.pointerId }
      el.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      const y = localY(e)
      drag.b = yToBeat(Math.max(0, Math.min(geom.hitY, y)))
      drag.fine = e.altKey
      if (Math.abs(y - drag.y0) > 5) drag.moved = true
    }
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      const d = drag
      drag = null
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      const p = propsRef.current
      // A plain click only focuses the view (picking a stretch would end a paused run).
      if (!d.moved || !p.interactive || !p.onSelect) return
      p.onSelect(snapSelection(p.grid, d.a, d.b, d.fine))
    }
    const onDouble = (e: MouseEvent) => {
      const p = propsRef.current
      const y = e.clientY - el.getBoundingClientRect().top
      if (!p.interactive || !p.onSelect || y > geom.hitY) return
      const beat = yToBeat(y)
      p.onSelect(snapSelection(p.grid, beat, beat, e.altKey))
    }
    const onCancel = () => {
      drag = null
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('keydown', onKey)
    el.addEventListener('dblclick', onDouble)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)

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
      const real = p.getNow()
      if (!p.interactive || p.resetKey !== lastReset) {
        offset = 0
        lastReset = p.resetKey
        if (!p.interactive) drag = null
      }
      const now = real + offset
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const keys = p.lanes.kind === 'keys'
      const kbH = keys ? Math.max(80, Math.min(150, h * 0.24)) : 78
      const hitY = h - kbH - 6
      const ppb = (hitY / 8) * p.zoom // pixels per beat: ~8 beats visible at zoom 1
      Object.assign(geom, { hitY, ppb, view: now, real })
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

      // Events.
      const evs = p.events
      const browsing = Math.abs(offset) > 1e-3
      const sounding = new Set<number>() // what sounds at the play position (or, browsing, on the hit line)
      ctx.font = '700 12px var(--sans, system-ui)'
      for (const e of evs) {
        const at = browsing ? now : real
        if (e.start <= at + 0.02 && e.start + e.dur > at - 0.02) sounding.add(e.lane)
        if (e.start > visTo) continue
        if (e.start + e.dur < visFrom) continue
        const kg = geo[e.lane]
        if (!kg) continue
        const yBottom = yOf(e.start)
        const hh = Math.max(e.drum ? 10 : 8, e.dur * ppb - 2)
        const x = kg.x + (keys ? 2 : 6)
        const ww = kg.w - (keys ? 4 : 12)
        const done = st.done.has(e.i)
        const grade = st.grades.get(e.i)
        ctx.globalAlpha = done ? 0.25 : 1
        ctx.fillStyle = grade === 'miss' ? '#5b2a2a' : e.color
        roundRect(ctx, x, yBottom - hh, ww, hh, 5)
        ctx.fill()
        // A held long note glows from its start up to where the key is (or was) let go; the
        // part released too early stays dark.
        const heldTo = st.held.get(e.i)
        if (heldTo !== undefined) {
          const until = Math.min(e.start + e.dur, heldTo ?? real)
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
          const text = e.finger ? `${e.label}·${e.finger}` : e.label
          ctx.fillText(ww >= 28 || !e.finger ? text : String(e.finger), x + ww / 2, yBottom - 6)
          ctx.textAlign = 'left'
        }
        ctx.globalAlpha = 1
      }

      // Scrolled away from the play position: mark where it is.
      if (Math.abs(offset) > 1e-3) {
        const y = yOf(real)
        if (y >= 0 && y <= hitY) {
          ctx.strokeStyle = 'rgba(111,168,255,0.85)'
          ctx.setLineDash([6, 5])
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(111,168,255,0.95)'
          ctx.font = '700 12px var(--sans, system-ui)'
          ctx.fillText('здесь остановились', 30, y - 5)
        }
      }

      // The stretch being picked.
      if (drag) {
        const r = snapSelection(g, drag.a, drag.moved ? drag.b : drag.a, drag.fine)
        const y0 = Math.max(0, yOf(r.end))
        const y1 = Math.min(hitY, yOf(r.start))
        if (y1 > y0) {
          ctx.fillStyle = 'rgba(111,168,255,0.16)'
          ctx.fillRect(0, y0, w, y1 - y0)
          ctx.strokeStyle = 'rgba(111,168,255,0.9)'
          ctx.lineWidth = 2
          ctx.strokeRect(1, y0 + 1, w - 2, y1 - y0 - 2)
          ctx.font = '700 14px var(--sans, system-ui)'
          const text = `Учить: ${rangeLabel(g, r)}`
          const tw = ctx.measureText(text).width
          ctx.fillStyle = 'rgba(111,168,255,0.95)'
          roundRect(ctx, w / 2 - tw / 2 - 10, Math.max(4, y0 + 6), tw + 20, 24, 6)
          ctx.fill()
          ctx.fillStyle = '#0b0d11'
          ctx.textAlign = 'center'
          ctx.fillText(text, w / 2, Math.max(4, y0 + 6) + 17)
          ctx.textAlign = 'left'
        }
      }

      // Hit line.
      ctx.fillStyle = 'rgba(111,168,255,0.9)'
      ctx.fillRect(0, hitY, w, 2)

      // Keyboard / pads. Browsing, the keys show the notes on the hit line: scrub to see a shape.
      const expected = browsing ? sounding : st.expected ?? sounding
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
        // C labels on the keyboard, for orientation at the track's OCT setting.
        ctx.font = '600 11px var(--sans, system-ui)'
        ctx.textAlign = 'center'
        for (const kg of geo) {
          const pitch = p.lanes.lowNote + 12 * p.octave + kg.index
          if (!kg.black && pitch % 12 === 0) {
            ctx.fillStyle = '#5a6472'
            ctx.fillText(noteName(pitch, p.names), kg.x + kg.w / 2, kg.y + kg.h - 8)
          }
        }
        ctx.textAlign = 'left'
      }

      // The way back after scrolling (how to scroll and pick is explained under the view).
      backPill = null
      if (p.interactive) {
        if (Math.abs(offset) > 1e-3) {
          const text = '↩ к месту остановки'
          ctx.font = '700 12px var(--sans, system-ui)'
          const tw = ctx.measureText(text).width
          backPill = { x: w - tw - 30, y: 10, w: tw + 20, h: 24 }
          ctx.fillStyle = 'rgba(111,168,255,0.95)'
          roundRect(ctx, backPill.x, backPill.y, backPill.w, backPill.h, 6)
          ctx.fill()
          ctx.fillStyle = '#0b0d11'
          ctx.fillText(text, backPill.x + 10, backPill.y + 16)
        }
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
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('dblclick', onDouble)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
    }
  }, [])

  return (
    <canvas
      ref={canvas}
      className={`waterfall ${props.interactive ? 'interactive' : ''}`}
      tabIndex={0}
      aria-label="Лента нот: колёсико или стрелки — листать, двойной щелчок или протяжка — выбрать такты"
    />
  )
}
