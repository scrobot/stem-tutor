/**
 * Web MIDI input manager. React components read connection state from the zustand store;
 * note events go through a plain listener set (no re-render per message) plus a small
 * `active` map for highlighting held keys/pads.
 */
import { create } from 'zustand'

export type MidiMsg =
  | { type: 'noteon'; ch: number; note: number; vel: number; t: number }
  | { type: 'noteoff'; ch: number; note: number; t: number }
  | { type: 'cc'; ch: number; cc: number; value: number; t: number }
  | { type: 'pitchbend'; ch: number; value: number; t: number }
  | { type: 'clock' | 'start' | 'stop' | 'continue'; t: number }
  | { type: 'spp'; value: number; t: number }

export interface MidiPortInfo {
  id: string
  name: string
  manufacturer: string
  state: string
}

type Status = 'unsupported' | 'idle' | 'requesting' | 'ready' | 'denied' | 'error'

interface MidiState {
  status: Status
  error: string | null
  inputs: MidiPortInfo[]
  selectedId: string | null
  portError: string | null
  active: Record<string, number>
  log: MidiMsg[]
  init: (preferred?: (ports: MidiPortInfo[]) => string | null) => Promise<void>
  select: (id: string | null) => Promise<void>
}

const listeners = new Set<(m: MidiMsg) => void>()
export function onMidi(fn: (m: MidiMsg) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Inject a message as if it came from the device (on-screen keyboard, tests). */
export function emitMidi(m: MidiMsg): void {
  dispatch(m)
}

let access: MIDIAccess | null = null
let current: MIDIInput | null = null

const IGNORED = /microsoft gs wavetable|midi through|loopback/i

function parse(data: Uint8Array, t: number): MidiMsg | null {
  const status = data[0]
  if (status >= 0xf0) {
    switch (status) {
      case 0xf8:
        return { type: 'clock', t }
      case 0xfa:
        return { type: 'start', t }
      case 0xfb:
        return { type: 'continue', t }
      case 0xfc:
        return { type: 'stop', t }
      case 0xf2:
        return { type: 'spp', value: (data[1] ?? 0) | ((data[2] ?? 0) << 7), t }
      default:
        return null
    }
  }
  const kind = status & 0xf0
  const ch = status & 0x0f
  if (kind === 0x90 && (data[2] ?? 0) > 0) return { type: 'noteon', ch, note: data[1], vel: data[2], t }
  if (kind === 0x80 || kind === 0x90) return { type: 'noteoff', ch, note: data[1], t }
  if (kind === 0xb0) return { type: 'cc', ch, cc: data[1], value: data[2], t }
  if (kind === 0xe0) return { type: 'pitchbend', ch, value: ((data[2] << 7) | data[1]) - 8192, t }
  return null
}

function dispatch(m: MidiMsg) {
  if (m.type === 'noteon' || m.type === 'noteoff') {
    const key = `${m.ch}:${m.note}`
    useMidi.setState((s) => {
      const active = { ...s.active }
      if (m.type === 'noteon') active[key] = m.vel
      else delete active[key]
      return { active, log: [m, ...s.log].slice(0, 40) }
    })
  } else if (m.type === 'cc' || m.type === 'pitchbend') {
    useMidi.setState((s) => ({ log: [m, ...s.log].slice(0, 40) }))
  }
  for (const fn of listeners) fn(m)
}

/**
 * The event's own time stamp if it is on the page clock (performance.now()), else "now".
 * Some MIDI stacks stamp messages on another clock (seconds off), which would score every
 * hit as a miss; messages arrive within a few ms (a busy page can delay them a little), so
 * "now" is a safe stand-in for anything outside that.
 */
export function eventTime(stamp: number | undefined, now: number): number {
  return stamp && stamp <= now + 2 && stamp >= now - 500 ? stamp : now
}

function handler(e: MIDIMessageEvent) {
  if (!e.data) return
  const m = parse(e.data, eventTime(e.timeStamp, performance.now()))
  if (m) dispatch(m)
}

function listInputs(): MidiPortInfo[] {
  if (!access) return []
  const out: MidiPortInfo[] = []
  access.inputs.forEach((i) => {
    if (IGNORED.test(i.name ?? '')) return
    out.push({ id: i.id, name: i.name ?? 'MIDI', manufacturer: i.manufacturer ?? '', state: i.state })
  })
  return out
}

export const useMidi = create<MidiState>((set, get) => ({
  status: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator ? 'idle' : 'unsupported',
  error: null,
  inputs: [],
  selectedId: null,
  portError: null,
  active: {},
  log: [],

  async init(preferred) {
    const st = get().status
    if (st === 'unsupported' || st === 'requesting' || st === 'ready') return
    set({ status: 'requesting', error: null })
    try {
      access = await navigator.requestMIDIAccess({ sysex: false })
    } catch (err) {
      const name = (err as DOMException)?.name
      set({
        status: name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'error',
        error: String((err as Error)?.message ?? err),
      })
      return
    }
    const refresh = () => {
      const inputs = listInputs()
      set({ inputs })
      const sel = get().selectedId
      if (sel && !inputs.some((i) => i.id === sel)) {
        current = null
        set({ selectedId: null, active: {} })
      }
      if (!get().selectedId && inputs.length) {
        const want = preferred?.(inputs) ?? inputs[0].id
        void get().select(want)
      }
    }
    access.onstatechange = refresh
    set({ status: 'ready' })
    refresh()
  },

  async select(id) {
    if (current) {
      current.onmidimessage = null
      current = null
    }
    set({ selectedId: id, portError: null, active: {} })
    if (!id || !access) return
    const input = access.inputs.get(id)
    if (!input) return
    try {
      await input.open()
      input.onmidimessage = handler
      current = input
    } catch (err) {
      set({
        portError:
          'Порт занят другой программой или недоступен. ' + String((err as Error)?.message ?? ''),
      })
    }
  },
}))

/** Channel numbers are shown 1-based. */
export const chLabel = (ch: number | null) => (ch === null ? 'любой' : String(ch + 1))
