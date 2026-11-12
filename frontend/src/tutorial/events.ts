import type { InstrumentProfile } from '../instruments/profiles'
import { fitLayer, type BeatRange, type LayerKind, type PadSlot } from '../music/arrange'
import { DRUM_COLOR, DRUM_LABEL } from '../music/drums'
import { inStretch } from '../music/grid'
import type { PartModel } from '../music/model'
import { noteName, type OctaveNames } from '../music/notes'
import { keyboardSpec } from '../instruments/profiles'
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
  drum: boolean
  folded: boolean
  /** Built-in lessons: which finger plays it (1 = thumb … 5 = little finger). */
  finger?: number
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
  /** The one OCT setting for the whole stretch (keys; 0 for pads). */
  octave: number
  /** Notes inside the stretch moved by an octave so they fit the keys. */
  folded: number
  layerCount: number
  layerIndex: number
  layerLabel: string
  layerHint: string
  layerKind: LayerKind | 'pads'
}

/**
 * What the practice session plays and grades: one layer of a part, laid on the controller for
 * one stretch (`range`, or the whole part) with a single OCT setting.
 */
export function tutorTrack(
  model: PartModel,
  layerIdx: number,
  profile: InstrumentProfile,
  names: OctaveNames,
  range?: BeatRange | null,
  opts: {
    /** Built-in lessons: the finger for each note of the part (by its index). */
    fingers?: Map<number, number>
    /** Spell black keys as flats (Eb) rather than sharps (D#) around this beat. */
    flatsAt?: (beat: number) => boolean
  } = {},
): TutorTrack {
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
      octave: 0,
      folded: 0,
      layerCount: 1,
      layerIndex: 0,
      layerLabel: 'Вся партия',
      layerHint: '',
      layerKind: 'pads',
    }
  }
  const index = Math.max(0, Math.min(layerIdx, a.layers.length - 1))
  const layer = a.layers[index]
  const fit = layer ? fitLayer(layer, keyboardSpec(profile), range) : { octave: 0, events: [], folded: 0 }
  const color = ROLE_HEX[layer?.kind === 'bass' ? 'bass' : layer?.kind === 'melody' ? 'melody' : layer?.kind === 'chords' ? 'chords' : model.part.role]
  const events = fit.events.map<TutorEvent>((e, i) => ({
    i,
    start: e.start,
    dur: e.dur,
    lane: e.key,
    target: e.pitch,
    pitch: e.pitch,
    vel: e.vel,
    color,
    label: noteName(e.pitch, names, opts.flatsAt?.(e.start) ?? false).replace(/-?\d+$/, ''),
    drum: model.part.isDrum,
    folded: e.folded,
    finger: opts.fingers?.get(e.idx),
  }))
  return {
    events,
    lanes: { kind: 'keys', count: profile.keys.count, lowNote: profile.keys.lowNote, labels: [], colors: [], slots: [] },
    octave: fit.octave,
    folded: fit.folded,
    layerCount: a.layers.length,
    layerIndex: index,
    layerLabel: layer?.label ?? '',
    layerHint: layer?.hint ?? '',
    layerKind: layer?.kind ?? 'all',
  }
}

/** Onset groups for the step-by-step mode: notes that start together form one chord. */
export interface StepGroup {
  start: number
  events: TutorEvent[]
  targets: Set<number>
}

export function stepGroups(events: TutorEvent[], from: number, to: number): StepGroup[] {
  const list = events.filter((e) => inStretch(e.start, { start: from, end: to })).sort((a, b) => a.start - b.start)
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
