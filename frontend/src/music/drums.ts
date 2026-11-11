export type DrumClass =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'rim'
  | 'closedHat'
  | 'openHat'
  | 'lowTom'
  | 'midTom'
  | 'highTom'
  | 'crash'
  | 'ride'
  | 'perc'

export const DRUM_CLASSES: DrumClass[] = [
  'kick', 'snare', 'clap', 'rim', 'closedHat', 'openHat', 'lowTom', 'midTom', 'highTom', 'crash', 'ride', 'perc',
]

export const DRUM_LABEL: Record<DrumClass, string> = {
  kick: 'Kick',
  snare: 'Snare',
  clap: 'Clap',
  rim: 'Rim',
  closedHat: 'Hat',
  openHat: 'Open Hat',
  lowTom: 'Low Tom',
  midTom: 'Mid Tom',
  highTom: 'High Tom',
  crash: 'Crash',
  ride: 'Ride',
  perc: 'Perc',
}

export const DRUM_LABEL_RU: Record<DrumClass, string> = {
  kick: 'бочка',
  snare: 'малый',
  clap: 'хлопок',
  rim: 'римшот',
  closedHat: 'закрытый хэт',
  openHat: 'открытый хэт',
  lowTom: 'низкий том',
  midTom: 'средний том',
  highTom: 'высокий том',
  crash: 'крэш',
  ride: 'райд',
  perc: 'перкуссия',
}

/** Canonical GM note per class (used to re-voice transcribed drums and in GM exports). */
export const CLASS_GM_NOTE: Record<DrumClass, number> = {
  kick: 36, snare: 38, clap: 39, rim: 37, closedHat: 42, openHat: 46,
  lowTom: 45, midTom: 47, highTom: 50, crash: 49, ride: 51, perc: 56,
}

export function gmToClass(note: number): DrumClass {
  switch (note) {
    case 35:
    case 36:
      return 'kick'
    case 38:
    case 40:
      return 'snare'
    case 39:
      return 'clap'
    case 37:
      return 'rim'
    case 42:
    case 44:
      return 'closedHat'
    case 46:
      return 'openHat'
    case 41:
    case 43:
    case 45:
      return 'lowTom'
    case 47:
    case 48:
      return 'midTom'
    case 50:
      return 'highTom'
    case 49:
    case 52:
    case 55:
    case 57:
      return 'crash'
    case 51:
    case 53:
    case 59:
      return 'ride'
    default:
      return 'perc'
  }
}

/**
 * Ergonomic pad preferences for a 2×4 grid where pads 1–4 are the bottom row:
 * bottom row Kick · Snare · Hat · Open Hat, top row Clap · Tom · Perc · Cymbal.
 */
export const PAD_PREFERENCE: Record<DrumClass, number[]> = {
  kick: [0, 4],
  snare: [1, 5],
  closedHat: [2, 6],
  openHat: [3, 7],
  clap: [5, 1, 4],
  rim: [6, 5],
  lowTom: [4, 5],
  midTom: [5, 6],
  highTom: [6, 7],
  crash: [7, 3],
  ride: [7, 3, 6],
  perc: [6, 7, 5, 4],
}

export const DRUM_COLOR: Record<DrumClass, string> = {
  kick: '#ff6b6b',
  snare: '#ffb547',
  clap: '#ffd36b',
  rim: '#f7a072',
  closedHat: '#5bd6a7',
  openHat: '#3fc1c9',
  lowTom: '#c792ea',
  midTom: '#b39ddb',
  highTom: '#9fa8ff',
  crash: '#6fa8ff',
  ride: '#82b1ff',
  perc: '#9aa5b1',
}
