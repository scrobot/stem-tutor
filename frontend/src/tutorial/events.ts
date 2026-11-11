import type { InstrumentProfile } from '../instruments/profiles'
import type { OctaveChange, OctaveSegment, PadSlot } from '../music/arrange'
import { DRUM_COLOR, DRUM_LABEL } from '../music/drums'
import type { PartModel } from '../music/model'
import { noteName, type OctaveNames } from '../music/notes'
import type { Role } from '../types'

export const ROLE_HEX: Record<Role, string> = {
  drums: '#ff6b6b',
  bass: '#ffb547',
  chords: '#5bd6a7',
  melody: '#6fa8ff',
  vocal: '#c792ea',
  other: '#9aa5b1',
}

export interface TutorEvent {
  i: number
  start: number // beats
  dur: number
  lane: number // key index or pad-slot index
  target: number // note the controller must send
  pitch: number // sound for the built-in synth (pitch or GM drum note)
  vel: number
  color: string
  label: string
  octave: number
  drum: boolean
  folded: boolean
}

export interface TutorLanes {
  kind: 'keys' | 'pads'
  count: number
  lowNote: number
  labels: string[]
  colors: string[]
  slots: PadSlot[]
}

export interface TutorTrack {
  events: TutorEvent[]
  lanes: TutorLanes
  segments: OctaveSegment[]
  changes: OctaveChange[]
  startOctave: number
  passCount: number
  passLabel: string
}

export function tutorTrack(model: PartModel, passIdx: number, profile: InstrumentProfile, names: OctaveNames): TutorTrack {
  const a = model.arrangement
  if (a.kind === 'pads') {
    const slots = a.slots
    const laneOf = new Map(slots.map((s, i) => [`${s.bank}:${s.pad}`, i]))
    const bankName = (b: number) => profile.pads?.banks[b]?.id ?? String(b + 1)
    const events = a.events.map<TutorEvent>((e, i) => ({
      i,
      start: e.start,
      dur: Math.min(e.dur, 0.25),
      lane: laneOf.get(`${e.bank}:${e.pad}`) ?? 0,
      target: e.note,
      pitch: e.gm,
      vel: e.vel,
      color: DRUM_COLOR[e.cls],
      label: DRUM_LABEL[e.cls],
      octave: 0,
      drum: true,
      folded: false,
    }))
    return {
      events,
      lanes: {
        kind: 'pads',
        count: slots.length,
        lowNote: 0,
        labels: slots.map((s) => `${bankName(s.bank)}${s.pad + 1} ${DRUM_LABEL[s.cls]}`),
        colors: slots.map((s) => DRUM_COLOR[s.cls]),
        slots,
      },
      segments: [],
      changes: [],
      startOctave: 0,
      passCount: 1,
      passLabel: 'Вся партия',
    }
  }
  const pass = a.passes[Math.min(passIdx, a.passes.length - 1)]
  const color = ROLE_HEX[model.part.role]
  const events = (pass?.events ?? []).map<TutorEvent>((e, i) => ({
    i,
    start: e.start,
    dur: e.dur,
    lane: e.key,
    target: e.pitch,
    pitch: e.pitch,
    vel: e.vel,
    color,
    label: noteName(e.pitch, names).replace(/-?\d+$/, ''),
    octave: e.octave,
    drum: model.part.isDrum,
    folded: e.folded,
  }))
  return {
    events,
    lanes: { kind: 'keys', count: profile.keys.count, lowNote: profile.keys.lowNote, labels: [], colors: [], slots: [] },
    segments: pass?.segments ?? [],
    changes: pass?.changes ?? [],
    startOctave: pass?.startOctave ?? 0,
    passCount: a.passes.length,
    passLabel: pass?.label ?? '',
  }
}

/** Octave in effect at a beat (keys parts). */
export function octaveAt(track: TutorTrack, beat: number): number {
  let o = track.startOctave
  for (const s of track.segments) if (s.start <= beat + 1e-6) o = s.octave
  return o
}

/** Onset groups for the step-by-step mode: notes that start together form one chord. */
export interface StepGroup {
  start: number
  events: TutorEvent[]
  targets: Set<number>
}

export function stepGroups(events: TutorEvent[], from: number, to: number): StepGroup[] {
  const list = events.filter((e) => e.start >= from - 1e-6 && e.start < to - 1e-6).sort((a, b) => a.start - b.start)
  const out: StepGroup[] = []
  for (const e of list) {
    const g = out[out.length - 1]
    if (g && Math.abs(g.start - e.start) < 1 / 24) {
      g.events.push(e)
      g.targets.add(e.target)
    } else out.push({ start: e.start, events: [e], targets: new Set([e.target]) })
  }
  return out
}
