// Mirrors backend/stemtutor/schemas.py

export type Role = 'drums' | 'bass' | 'chords' | 'melody' | 'vocal' | 'other'
export type Status = 'queued' | 'processing' | 'ready' | 'failed'
export type SourceKind = 'audio' | 'stems' | 'midi'

/** p: MIDI pitch (GM note for drums), s/e: seconds, v: velocity */
export interface Note {
  p: number
  s: number
  e: number
  v: number
}

/** Quarter-note grid: beats[i] = time (s) of quarter note i. */
export interface Grid {
  beats: number[]
  barLength: number
  timeSig: [number, number]
  firstDownbeat: number
  bpm: number
  origin: 'midi' | 'tracked' | 'manual' | 'default'
}

export interface PartMedia {
  stem?: string | null
  backing?: string | null
  stemWav?: string | null
}

export interface Part {
  id: string
  name: string
  role: Role
  isDrum: boolean
  program?: number | null
  origin: 'midi' | 'transcribed'
  notes: Note[]
  media: PartMedia
  silent: boolean
}

export interface SourceInfo {
  kind: SourceKind
  url?: string | null
  audioFile?: string | null
  midiFile?: string | null
  stemFiles: string[]
  engine?: string | null
}

export interface LessonPrefs {
  audioOffset?: number
  quantize?: number
  padOverrides?: Record<string, Record<string, { bank: number; pad: number }>>
  [key: string]: unknown
}

export interface Lesson {
  id: string
  title: string
  artist?: string | null
  createdAt: string
  updatedAt: string
  source: SourceInfo
  status: Status
  stage?: string | null
  stageLabel?: string | null
  progress: number
  error?: string | null
  cancelRequested?: boolean
  warnings: string[]
  durationSec: number
  grid?: Grid | null
  media: Record<string, string>
  parts: Part[]
  thumbnail?: string | null
  prefs: LessonPrefs
}

export interface LessonSummary {
  id: string
  title: string
  artist?: string | null
  createdAt: string
  status: Status
  stage?: string | null
  stageLabel?: string | null
  progress: number
  error?: string | null
  cancelRequested?: boolean
  sourceKind: SourceKind
  durationSec: number
  bpm?: number | null
  roles: Role[]
  partCount: number
  thumbnail?: string | null
}

export interface Calibration {
  keysLowNote?: number
  keysChannel?: number | null
  padsChannel?: number | null
  padBanks?: number[][]
  calibratedAt?: string
}

export interface Settings {
  instrumentId: string
  midiInputName?: string | null
  calibrations: Record<string, Calibration>
  ui: {
    octaveNames?: 'ableton' | 'scientific'
    monitor?: boolean
    [key: string]: unknown
  }
}

export interface Health {
  ok: boolean
  version: string
  ffmpeg: boolean
  engines: Record<
    string,
    {
      available: boolean
      state?: 'pending' | 'ok' | 'error' | 'absent'
      device?: 'cuda' | 'cpu' | null
      hint?: string | null
      models?: { id: string; label: string }[]
      default?: string
    }
  >
  dataDir: string
  processing?: string | null
}
