/** Geometry of a controller drawing, computed from its profile (no per-device artwork). */
import { isBlack } from '../music/notes'
import type { ButtonId, InstrumentProfile } from './profiles'

export interface KeyGeom {
  index: number
  black: boolean
  x: number
  y: number
  w: number
  h: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface DeviceGeom {
  width: number
  height: number
  keysArea: Rect
  keys: KeyGeom[]
  pads: (Rect & { index: number })[]
  knobs: { index: number; cx: number; cy: number; r: number }[]
  buttons: (Rect & { id: ButtonId; label: string })[]
  stick: { kind: 'joystick' | 'wheels' | 'strips'; x: number; y: number; w: number; h: number } | null
  display: Rect | null
}

/** Piano keys of `count` keys starting at `lowNote`, spread over a rectangle. */
export function keyboardGeometry(lowNote: number, count: number, x0: number, y0: number, width: number, height: number): KeyGeom[] {
  let whites = 0
  for (let i = 0; i < count; i++) if (!isBlack(lowNote + i)) whites++
  const ww = width / Math.max(1, whites)
  const bw = ww * 0.62
  const out: KeyGeom[] = []
  let wi = 0
  for (let i = 0; i < count; i++) {
    if (!isBlack(lowNote + i)) {
      out.push({ index: i, black: false, x: x0 + wi * ww, y: y0, w: ww, h: height })
      wi++
    } else {
      out.push({ index: i, black: true, x: x0 + wi * ww - bw / 2, y: y0, w: bw, h: height * 0.62 })
    }
  }
  return out
}

function gridIn(area: Rect, rows: number, cols: number, gap: number, square = true): Rect[][] {
  let cw = (area.w - gap * (cols - 1)) / cols
  let ch = (area.h - gap * (rows - 1)) / rows
  if (square) {
    const s = Math.min(cw, ch)
    cw = s
    ch = s
  }
  const totalW = cw * cols + gap * (cols - 1)
  const totalH = ch * rows + gap * (rows - 1)
  const ox = area.x + (area.w - totalW) / 2
  const oy = area.y + (area.h - totalH) / 2
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({ x: ox + c * (cw + gap), y: oy + r * (ch + gap), w: cw, h: ch })),
  )
}

export function deviceGeometry(p: InstrumentProfile): DeviceGeom {
  const W = 1000
  const mini = p.keys.count <= 37 && (!!p.pads || !!p.knobs)
  const topH = mini ? 230 : 96
  const keysH = mini ? 250 : 230
  const pad = 22
  const keysArea: Rect = { x: pad, y: pad + topH + 14, w: W - pad * 2, h: keysH }
  const H = keysArea.y + keysArea.h + pad
  const keys = keyboardGeometry(p.keys.lowNote, p.keys.count, keysArea.x, keysArea.y, keysArea.w, keysArea.h)

  const buttons: DeviceGeom['buttons'] = []
  const pads: DeviceGeom['pads'] = []
  const knobs: DeviceGeom['knobs'] = []
  let stick: DeviceGeom['stick'] = null
  let display: Rect | null = null

  if (mini) {
    // Left column: stick + buttons.
    const left: Rect = { x: pad, y: pad, w: 220, h: topH }
    if (p.stick) stick = { kind: p.stick, x: left.x + 8, y: left.y + 4, w: 96, h: 96 }
    const cols = 2
    const rows = Math.ceil(p.buttons.length / cols)
    const bw = (left.w - 12) / cols
    const by0 = left.y + (p.stick ? 112 : 6)
    const bh = Math.min(26, (left.h - (by0 - left.y) - 4 * (rows - 1)) / Math.max(1, rows))
    p.buttons.forEach((b, i) => {
      const r = Math.floor(i / cols)
      const c = i % cols
      buttons.push({ id: b.id, label: b.label, x: left.x + c * (bw + 12), y: by0 + r * (bh + 5), w: bw, h: bh })
    })
    const knobW = p.knobs ? (p.knobs.cols >= 8 ? 330 : 250) : 0
    const dispW = p.display ? 96 : 0
    const padsArea: Rect = {
      x: left.x + left.w + 22,
      y: pad + 6,
      w: W - pad - (left.x + left.w + 22) - knobW - dispW - (knobW ? 22 : 0) - (dispW ? 18 : 0),
      h: topH - 12,
    }
    if (p.pads) {
      const rows = p.pads.grid.length
      const cols = Math.max(...p.pads.grid.map((r) => r.length))
      const cells = gridIn(padsArea, rows, cols, 12)
      p.pads.grid.forEach((row, r) => row.forEach((idx, c) => pads.push({ index: idx, ...cells[r][c] })))
    }
    let x = padsArea.x + padsArea.w + 18
    if (p.display) {
      display = { x, y: pad + 24, w: dispW, h: 64 }
      x += dispW + 22
    }
    if (p.knobs) {
      const area: Rect = { x, y: pad + 10, w: W - pad - x, h: topH - 20 }
      const cells = gridIn(area, p.knobs.rows, p.knobs.cols, 14)
      let i = 0
      for (const row of cells)
        for (const cell of row) {
          if (i >= p.knobs.count) break
          knobs.push({ index: i++, cx: cell.x + cell.w / 2, cy: cell.y + cell.h / 2, r: cell.w * 0.36 })
        }
    }
  } else {
    // Big keyboards: a slim top strip with octave buttons and wheels.
    if (p.stick) stick = { kind: p.stick, x: pad, y: pad + 8, w: 120, h: topH - 16 }
    p.buttons.forEach((b, i) => buttons.push({ id: b.id, label: b.label, x: pad + 140 + i * 92, y: pad + topH / 2 - 15, w: 84, h: 30 }))
  }
  return { width: W, height: H, keysArea, keys, pads, knobs, buttons, stick, display }
}
