/** Minimal Standard MIDI File (type 1) writer. */

export interface MidiNoteEvent {
  tick: number
  dur: number // ticks
  note: number
  vel: number
}

export interface MidiTrackSpec {
  name: string
  channel: number // 0-based
  notes: MidiNoteEvent[]
}

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n))
  const bytes = [v & 0x7f]
  v >>= 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes
}

function text(s: string): number[] {
  return Array.from(new TextEncoder().encode(s))
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length
  return [...text(type), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...data]
}

export function writeMidiFile(
  tracks: MidiTrackSpec[],
  opts: { ppq?: number; bpm: number; timeSig?: [number, number]; title?: string },
): Uint8Array<ArrayBuffer> {
  const ppq = opts.ppq ?? 480
  const [num, den] = opts.timeSig ?? [4, 4]
  const usPerQuarter = Math.round(60_000_000 / opts.bpm)

  const conductor: number[] = []
  if (opts.title) conductor.push(0, 0xff, 0x03, ...vlq(text(opts.title).length), ...text(opts.title))
  conductor.push(0, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff)
  conductor.push(0, 0xff, 0x58, 0x04, num, Math.round(Math.log2(den)), 24, 8)
  conductor.push(0, 0xff, 0x2f, 0x00)

  const chunks = [chunk('MThd', [0, 1, 0, tracks.length + 1, (ppq >> 8) & 0xff, ppq & 0xff]), chunk('MTrk', conductor)]

  for (const t of tracks) {
    const ch = t.channel & 0x0f
    type Ev = { tick: number; order: number; bytes: number[] }
    const evs: Ev[] = []
    for (const n of t.notes) {
      const on = Math.max(0, Math.round(n.tick))
      const off = Math.max(on + 1, Math.round(n.tick + n.dur))
      const note = Math.max(0, Math.min(127, n.note))
      const vel = Math.max(1, Math.min(127, Math.round(n.vel)))
      evs.push({ tick: on, order: 1, bytes: [0x90 | ch, note, vel] })
      evs.push({ tick: off, order: 0, bytes: [0x80 | ch, note, 0] })
    }
    // Note-offs before note-ons on the same tick so repeated notes retrigger cleanly.
    evs.sort((a, b) => a.tick - b.tick || a.order - b.order)
    const data: number[] = [0, 0xff, 0x03, ...vlq(text(t.name).length), ...text(t.name)]
    let last = 0
    for (const e of evs) {
      data.push(...vlq(e.tick - last), ...e.bytes)
      last = e.tick
    }
    data.push(0, 0xff, 0x2f, 0x00)
    chunks.push(chunk('MTrk', data))
  }
  return new Uint8Array(chunks.flat())
}
