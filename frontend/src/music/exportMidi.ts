import type { InstrumentProfile } from '../instruments/profiles'
import type { Grid, Lesson } from '../types'
import { exportOrigin, inStretch } from './grid'
import { writeMidiFile, type MidiTrackSpec } from './midifile'
import type { PartModel } from './model'

const PPQ = 480

/**
 * MIDI of a part exactly as the controller will send it (keys: real pitches; pads: the
 * calibrated pad notes) or with General MIDI drum notes. Ticks count from the export
 * origin, so the file starts on DAW bar 1 together with the aligned audio exports.
 */
export function exportPartMidi(
  lesson: Lesson,
  model: PartModel,
  profile: InstrumentProfile,
  variant: 'controller' | 'gm' = 'controller',
): Uint8Array<ArrayBuffer> {
  const grid = lesson.grid!
  const origin = exportOrigin(grid).beat
  const tick = (beat: number) => Math.round((beat - origin) * PPQ)
  const tracks: MidiTrackSpec[] = []
  const a = model.arrangement
  if (a.kind === 'pads') {
    const channel = variant === 'gm' ? 9 : profile.pads?.channel ?? 9
    tracks.push({
      name: model.part.name,
      channel,
      notes: a.events.map((e) => ({
        tick: tick(e.start),
        dur: Math.max(1, Math.round(e.dur * PPQ)),
        note: variant === 'gm' ? e.gm : e.note,
        vel: e.vel,
      })),
    })
  } else {
    // One MIDI track per one-hand layer (each is recorded as its own DAW track), at the real
    // pitches: every stretch is played at its own OCT setting, so nothing is folded here.
    const channel = model.part.isDrum ? 9 : profile.keys.channel ?? 0
    for (const layer of a.layers) {
      tracks.push({
        name: a.layers.length > 1 ? `${model.part.name} · ${layer.label}` : model.part.name,
        channel,
        notes: layer.notes.map((n) => ({
          tick: tick(n.start),
          dur: Math.max(1, Math.round(n.dur * PPQ)),
          note: variant === 'gm' ? n.src : n.pitch,
          vel: n.vel,
        })),
      })
    }
  }
  return writeMidiFile(tracks, { ppq: PPQ, bpm: fileTempo(grid), timeSig: grid.timeSig, title: `${lesson.title} — ${model.part.name}` })
}

/**
 * One practised stretch (a layer at its OCT setting, or the pad hits) as a loop for the DAW:
 * tick 0 is the start of the stretch, so it lands on bar 1; notes are cut at its end.
 */
export function exportStretchMidi(
  lesson: Lesson,
  name: string,
  events: { start: number; dur: number; target: number; vel: number }[],
  range: { start: number; end: number },
  channel: number,
): Uint8Array<ArrayBuffer> {
  const grid = lesson.grid!
  const notes = events
    .filter((e) => inStretch(e.start, range)) // a downbeat played a hair early belongs to the stretch
    .map((e) => {
      const on = Math.max(e.start, range.start)
      return {
        tick: Math.round((on - range.start) * PPQ),
        dur: Math.max(1, Math.round((Math.min(e.start + e.dur, range.end) - on) * PPQ)),
        note: e.target,
        vel: e.vel,
      }
    })
  return writeMidiFile([{ name, channel, notes }], { ppq: PPQ, bpm: fileTempo(grid), timeSig: grid.timeSig, title: name })
}

/**
 * The cover plan's tracks in one type-1 file: one MIDI track per DAW track, named like it,
 * keys at their real pitches and pads as the controller sends them. Dropped into Ableton's
 * Arrangement, a type-1 file becomes one MIDI track per file track — the reference to check
 * takes against, or to keep for a track not played by hand. Ticks count from the export
 * origin, like every other export.
 */
export function exportCoverMidi(
  lesson: Lesson,
  tracks: { name: string; model: PartModel; layerIndex: number }[],
  profile: InstrumentProfile,
): Uint8Array<ArrayBuffer> {
  const grid = lesson.grid!
  const origin = exportOrigin(grid).beat
  const tick = (beat: number) => Math.round((beat - origin) * PPQ)
  const specs: MidiTrackSpec[] = []
  for (const t of tracks) {
    const a = t.model.arrangement
    if (a.kind === 'pads') {
      specs.push({
        name: t.name,
        channel: profile.pads?.channel ?? 9,
        notes: a.events.map((e) => ({ tick: tick(e.start), dur: Math.max(1, Math.round(e.dur * PPQ)), note: e.note, vel: e.vel })),
      })
      continue
    }
    const layer = a.layers[t.layerIndex]
    if (!layer) continue
    specs.push({
      name: t.name,
      channel: t.model.part.isDrum ? 9 : profile.keys.channel ?? 0,
      notes: layer.notes.map((n) => ({ tick: tick(n.start), dur: Math.max(1, Math.round(n.dur * PPQ)), note: n.pitch, vel: n.vel })),
    })
  }
  return writeMidiFile(specs, { ppq: PPQ, bpm: fileTempo(grid), timeSig: grid.timeSig, title: lesson.title })
}

/**
 * The tempo written into the file. A tracked grid's real period (its shown BPM is rounded
 * to 2 decimals), so the MIDI does not drift against the aligned audio on long tracks.
 */
function fileTempo(grid: Grid): number {
  const b = grid.beats
  if (grid.origin === 'tracked' && b.length > 1 && b[b.length - 1] > b[0]) return (60 * (b.length - 1)) / (b[b.length - 1] - b[0])
  return grid.bpm
}
