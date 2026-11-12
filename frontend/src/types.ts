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

/** The AI producer connection (the key itself never leaves the backend). */
export interface AiStatus {
  configured: boolean
  keyHint: string | null
  model: string | null
}

/** A model OpenRouter can call with a JSON schema. Prices: USD per 1M tokens. */
export interface AiModel {
  id: string
  name: string
  contextLength: number | null
  promptPrice: number | null
  completionPrice: number | null
  audioPrice: number | null
  audioInput: boolean
}

export interface AiCheck {
  ok: boolean
  label: string | null
  limitRemaining: number | null
  usage: number | null
  isFreeTier: boolean | null
}

export interface ProducerTrack {
  id: string
  include: boolean
  name: string
  what: string
  instrument: string
  sound: string
  simplify: string
}

export interface ProducerResult {
  summary: string
  tracks: ProducerTrack[]
  order: string[]
  loopTips: { id: string; tip: string }[]
  tips: string[]
}

/** The saved answer of the AI producer for a lesson (backend: lessons/<id>/cover/producer.json). */
export interface ProducerAnswer {
  model: string
  createdAt: string
  digestKey: string
  audio: boolean
  usage: { cost: number | null; promptTokens: number | null; completionTokens: number | null }
  result: ProducerResult
}

export interface ProducerRequest {
  digest: Record<string, unknown>
  digestKey: string
  trackIds: string[]
  loopIds: string[]
  audio: { start: number; duration: number } | null
  model?: string
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
