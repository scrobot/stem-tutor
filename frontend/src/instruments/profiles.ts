import type { Calibration } from '../types'
import type { KeyboardSpec, PadSpec } from '../music/arrange'

export type ButtonId =
  | 'octDown'
  | 'octUp'
  | 'bank'
  | 'arp'
  | 'tap'
  | 'noteRepeat'
  | 'fullLevel'
  | 'cc'
  | 'prog'
  | 'shift'
  | 'sustain'

export interface InstrumentProfile {
  id: string
  name: string
  vendor: string
  short: string
  keys: {
    count: number
    lowNote: number // leftmost key at OCT 0
    channel: number | null // 0-based; null = any channel
    octaveRange: [number, number]
  }
  pads?: {
    count: number
    grid: number[][] // rows top→bottom, each a list of pad indices left→right
    channel: number | null
    banks: { id: string; notes: number[] }[]
    ergonomic: boolean
  }
  knobs?: { count: number; rows: number; cols: number; ccs: number[] }
  buttons: { id: ButtonId; label: string }[]
  stick: 'joystick' | 'wheels' | 'strips' | null
  display: boolean
  portMatch: string[] // lowercase substrings of the MIDI port name
  verified: boolean
  hint?: string
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)

const MPK_BUTTONS: InstrumentProfile['buttons'] = [
  { id: 'arp', label: 'ARP' },
  { id: 'tap', label: 'TAP' },
  { id: 'octDown', label: 'OCT −' },
  { id: 'octUp', label: 'OCT +' },
  { id: 'noteRepeat', label: 'NOTE RPT' },
  { id: 'fullLevel', label: 'FULL LVL' },
  { id: 'bank', label: 'BANK A/B' },
  { id: 'cc', label: 'CC' },
]

const MPK_PADS = (): NonNullable<InstrumentProfile['pads']> => ({
  count: 8,
  grid: [
    [4, 5, 6, 7],
    [0, 1, 2, 3],
  ],
  channel: 9,
  banks: [
    { id: 'A', notes: range(36, 8) },
    { id: 'B', notes: range(44, 8) },
  ],
  ergonomic: true,
})

const generic = (count: number, lowNote: number, id: string, extra: Partial<InstrumentProfile> = {}): InstrumentProfile => ({
  id,
  name: `Универсальная клавиатура · ${count} клавиш`,
  vendor: 'Generic',
  short: `${count} клавиш`,
  keys: { count, lowNote, channel: null, octaveRange: count >= 88 ? [0, 0] : [-3, 3] },
  buttons: count >= 88 ? [] : [
    { id: 'octDown', label: 'OCT −' },
    { id: 'octUp', label: 'OCT +' },
  ],
  stick: count >= 49 ? 'wheels' : null,
  display: false,
  portMatch: [],
  verified: false,
  hint: 'Нажмите самую левую клавишу в калибровке — приложение запомнит, какую ноту она отправляет.',
  ...extra,
})

export const PROFILES: InstrumentProfile[] = [
  {
    id: 'akai-mpk-mini-mk3',
    name: 'AKAI MPK mini MK3',
    vendor: 'AKAI Professional',
    short: 'MPK mini MK3',
    keys: { count: 25, lowNote: 48, channel: 0, octaveRange: [-4, 4] },
    pads: MPK_PADS(),
    knobs: { count: 8, rows: 2, cols: 4, ccs: range(70, 8) },
    buttons: MPK_BUTTONS,
    stick: 'joystick',
    display: true,
    portMatch: ['mpk mini 3', 'mpkmini3', 'mpk mini mk3', 'mpk mini iii'],
    verified: true,
    hint: 'Заводской пресет: клавиши — канал 1, пэды — канал 10, банк A = ноты 36–43. Если вы меняли пресет в MPK Editor — пройдите калибровку.',
  },
  {
    id: 'akai-mpk-mini-mk2',
    name: 'AKAI MPK mini MK2',
    vendor: 'AKAI Professional',
    short: 'MPK mini MK2',
    keys: { count: 25, lowNote: 48, channel: 0, octaveRange: [-4, 4] },
    pads: MPK_PADS(),
    knobs: { count: 8, rows: 2, cols: 4, ccs: range(1, 8) },
    buttons: MPK_BUTTONS,
    stick: 'joystick',
    display: false,
    portMatch: ['mpkmini2', 'mpk mini mkii', 'mpk mini mk2', 'mpk mini 2', 'mpk mini ii'],
    verified: false,
    hint: 'Ноты пэдов зависят от выбранной программы (PROG 1–4). Пройдите калибровку пэдов.',
  },
  {
    id: 'akai-mpk-mini-plus',
    name: 'AKAI MPK mini Plus',
    vendor: 'AKAI Professional',
    short: 'MPK mini Plus',
    keys: { count: 37, lowNote: 48, channel: 0, octaveRange: [-4, 4] },
    pads: MPK_PADS(),
    knobs: { count: 8, rows: 2, cols: 4, ccs: range(70, 8) },
    buttons: MPK_BUTTONS,
    stick: 'wheels',
    display: true,
    portMatch: ['mpk mini plus', 'mpkminiplus'],
    verified: false,
    hint: 'Профиль собран по аналогии с MK3 — проверьте калибровкой.',
  },
  {
    id: 'arturia-minilab-3',
    name: 'Arturia MiniLab 3',
    vendor: 'Arturia',
    short: 'MiniLab 3',
    keys: { count: 25, lowNote: 48, channel: 0, octaveRange: [-4, 4] },
    pads: {
      count: 8,
      grid: [[0, 1, 2, 3, 4, 5, 6, 7]],
      channel: 9,
      banks: [
        { id: 'A', notes: range(36, 8) },
        { id: 'B', notes: range(44, 8) },
      ],
      ergonomic: false,
    },
    knobs: { count: 8, rows: 2, cols: 4, ccs: [74, 71, 76, 77, 93, 18, 19, 16] },
    buttons: [
      { id: 'octDown', label: 'OCT −' },
      { id: 'octUp', label: 'OCT +' },
      { id: 'shift', label: 'SHIFT' },
      { id: 'bank', label: 'PAD BANK' },
    ],
    stick: 'strips',
    display: true,
    portMatch: ['minilab3', 'minilab 3'],
    verified: false,
    hint: 'Проверьте калибровкой — MiniLab 3 меняет ноты пэдов в режимах Arturia/DAW.',
  },
  {
    id: 'novation-launchkey-mini-mk3',
    name: 'Novation Launchkey Mini MK3',
    vendor: 'Novation',
    short: 'Launchkey Mini',
    keys: { count: 25, lowNote: 48, channel: 0, octaveRange: [-3, 3] },
    pads: {
      count: 16,
      grid: [
        [8, 9, 10, 11, 12, 13, 14, 15],
        [0, 1, 2, 3, 4, 5, 6, 7],
      ],
      channel: 9,
      // Drum mode: two 2×4 blocks (bottom-left 36–39, top-left 40–43, bottom-right 44–47…).
      banks: [{ id: 'Drum', notes: [36, 37, 38, 39, 44, 45, 46, 47, 40, 41, 42, 43, 48, 49, 50, 51] }],
      ergonomic: false,
    },
    knobs: { count: 8, rows: 1, cols: 8, ccs: range(21, 8) },
    buttons: [
      { id: 'octDown', label: 'OCT −' },
      { id: 'octUp', label: 'OCT +' },
      { id: 'shift', label: 'SHIFT' },
    ],
    stick: 'strips',
    display: false,
    portMatch: ['launchkey mini'],
    verified: false,
    hint: 'Переключите пэды в Drum mode (Shift + Drum).',
  },
  generic(25, 48, 'generic-25'),
  generic(32, 53, 'generic-32', { hint: '32 клавиши обычно начинаются с F. Проверьте калибровкой.' }),
  generic(37, 48, 'generic-37'),
  generic(49, 36, 'generic-49'),
  generic(61, 36, 'generic-61'),
  generic(88, 21, 'generic-88'),
]

export function profileById(id: string): InstrumentProfile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0]
}

/** Best profile for a MIDI port name, if any. */
export function matchProfile(portName: string): InstrumentProfile | null {
  const n = portName.toLowerCase()
  for (const p of PROFILES) if (p.portMatch.some((m) => n.includes(m))) return p
  if (n.includes('mpk') && n.includes('mini')) return PROFILES[0]
  return null
}

/** Profile with the user's calibration applied. */
export function effectiveProfile(p: InstrumentProfile, c?: Calibration | null): InstrumentProfile {
  if (!c) return p
  const out: InstrumentProfile = { ...p, keys: { ...p.keys } }
  if (typeof c.keysLowNote === 'number') out.keys.lowNote = c.keysLowNote
  if (c.keysChannel !== undefined) out.keys.channel = c.keysChannel
  if (p.pads) {
    out.pads = { ...p.pads, banks: p.pads.banks.map((b) => ({ ...b, notes: b.notes.slice() })) }
    if (c.padsChannel !== undefined) out.pads.channel = c.padsChannel
    c.padBanks?.forEach((notes, bi) => {
      if (out.pads!.banks[bi] && notes.length === out.pads!.count) out.pads!.banks[bi].notes = notes.slice()
    })
  }
  return out
}

export function keyboardSpec(p: InstrumentProfile): KeyboardSpec {
  return { count: p.keys.count, lowNote: p.keys.lowNote, octaveRange: p.keys.octaveRange }
}

export function padSpec(p: InstrumentProfile): PadSpec | null {
  if (!p.pads) return null
  return {
    count: p.pads.count,
    banks: p.pads.banks.map((b) => b.notes),
    ergonomic: p.pads.ergonomic,
    bankNames: p.pads.banks.map((b) => b.id),
  }
}

/** Is a note-on from (channel, note) a pad hit? Returns pad/bank or null for keys. */
export function classifyNote(p: InstrumentProfile, channel: number, note: number): { pad: number; bank: number } | null {
  if (!p.pads) return null
  const padCh = p.pads.channel
  const keyCh = p.keys.channel
  const onPadChannel = padCh === null || padCh === channel
  if (!onPadChannel) return null
  // When pads and keys share a channel, a note in the keys window is ambiguous; treat it as a pad
  // only if the channels differ or the profile explicitly maps it.
  if (padCh !== null && keyCh !== null && padCh === keyCh) return null
  for (let b = 0; b < p.pads.banks.length; b++) {
    const i = p.pads.banks[b].notes.indexOf(note)
    if (i >= 0) return { pad: i, bank: b }
  }
  return null
}
