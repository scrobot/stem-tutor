export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

/** 'ableton': middle C (60) = C3 (Ableton, Cubase, Logic); 'scientific': 60 = C4. */
export type OctaveNames = 'ableton' | 'scientific'

export const pc = (p: number) => ((p % 12) + 12) % 12

export function pcName(pitchClass: number, flats = false): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[pc(pitchClass)]
}

export function noteName(p: number, names: OctaveNames = 'ableton', flats = false): string {
  const octave = Math.floor(p / 12) - (names === 'ableton' ? 2 : 1)
  return `${pcName(p, flats)}${octave}`
}

export const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(pc(p))

export const midiHz = (p: number) => 440 * Math.pow(2, (p - 69) / 12)

/** Keys whose signatures use flats (major tonics and minor tonics separately). */
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6])
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3])
export function prefersFlats(tonic: number, mode: 'major' | 'minor'): boolean {
  return mode === 'major' ? FLAT_MAJOR.has(pc(tonic)) : FLAT_MINOR.has(pc(tonic))
}
