import type { InstrumentProfile } from '../instruments/profiles'
import type { Grid, Lesson } from '../types'
import { exportOrigin } from './grid'
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
    const channel = model.part.isDrum ? 9 : profile.keys.channel ?? 0
    for (const pass of a.passes) {
      tracks.push({
        name: a.passes.length > 1 ? `${model.part.name} · ${pass.label}` : model.part.name,
        channel,
        notes: pass.events.map((e) => ({
          tick: tick(e.start),
          dur: Math.max(1, Math.round(e.dur * PPQ)),
          note: variant === 'gm' ? e.srcPitch : e.pitch,
          vel: e.vel,
        })),
      })
    }
  }
  return writeMidiFile(tracks, { ppq: PPQ, bpm: fileTempo(grid), timeSig: grid.timeSig, title: `${lesson.title} — ${model.part.name}` })
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
