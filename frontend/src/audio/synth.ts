/** Built-in sound: a small polyphonic synth with role presets, drum synth and click. */
import type { Role } from '../types'
import { gmToClass, type DrumClass } from '../music/drums'
import { midiHz } from '../music/notes'
import { audioCtx, masterOut } from './engine'

export type SynthPreset = 'bass' | 'keys' | 'pad' | 'lead' | 'pluck'

export function presetForRole(role: Role): SynthPreset {
  switch (role) {
    case 'bass':
      return 'bass'
    case 'chords':
      return 'keys'
    case 'melody':
    case 'vocal':
      return 'lead'
    default:
      return 'pluck'
  }
}

interface PresetDef {
  waves: { type: OscillatorType; detune: number; gain: number; octave: number }[]
  cutoff: number
  envCutoff: number
  q: number
  a: number
  d: number
  s: number
  r: number
  level: number
}

const PRESETS: Record<SynthPreset, PresetDef> = {
  bass: {
    waves: [
      { type: 'sawtooth', detune: 0, gain: 0.6, octave: 0 },
      { type: 'square', detune: 0, gain: 0.35, octave: -1 },
    ],
    cutoff: 500, envCutoff: 1400, q: 3, a: 0.004, d: 0.18, s: 0.65, r: 0.08, level: 0.32,
  },
  keys: {
    waves: [
      { type: 'triangle', detune: 0, gain: 0.7, octave: 0 },
      { type: 'sine', detune: 0, gain: 0.25, octave: 1 },
    ],
    cutoff: 2600, envCutoff: 2000, q: 0.8, a: 0.004, d: 0.5, s: 0.35, r: 0.25, level: 0.2,
  },
  pad: {
    waves: [
      { type: 'sawtooth', detune: -8, gain: 0.45, octave: 0 },
      { type: 'sawtooth', detune: 8, gain: 0.45, octave: 0 },
    ],
    cutoff: 1500, envCutoff: 600, q: 0.7, a: 0.12, d: 0.3, s: 0.75, r: 0.45, level: 0.14,
  },
  lead: {
    waves: [
      { type: 'square', detune: 0, gain: 0.45, octave: 0 },
      { type: 'sawtooth', detune: 6, gain: 0.4, octave: 0 },
    ],
    cutoff: 2400, envCutoff: 2200, q: 1.5, a: 0.006, d: 0.12, s: 0.7, r: 0.12, level: 0.2,
  },
  pluck: {
    waves: [{ type: 'sawtooth', detune: 0, gain: 0.8, octave: 0 }],
    cutoff: 900, envCutoff: 3000, q: 2, a: 0.002, d: 0.25, s: 0.0, r: 0.12, level: 0.22,
  },
}

let noise: AudioBuffer | null = null
function noiseBuffer(): AudioBuffer {
  const c = audioCtx()
  if (!noise) {
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return noise
}

export interface PlayOptions {
  dest?: AudioNode
  gain?: number
}

/** Play one note at AudioContext time `when` for `dur` seconds. */
export function playNote(pitch: number, when: number, dur: number, vel: number, preset: SynthPreset, opts: PlayOptions = {}) {
  const c = audioCtx()
  const p = PRESETS[preset]
  const dest = opts.dest ?? masterOut()
  const t0 = Math.max(when, c.currentTime)
  const end = t0 + Math.max(0.03, dur)
  const amp = p.level * (0.35 + 0.65 * (vel / 127)) * (opts.gain ?? 1)

  const vca = c.createGain()
  vca.gain.setValueAtTime(0, t0)
  vca.gain.linearRampToValueAtTime(amp, t0 + p.a)
  vca.gain.setTargetAtTime(amp * p.s, t0 + p.a, p.d / 3)
  vca.gain.setValueAtTime(amp * p.s, end)
  vca.gain.setTargetAtTime(0, end, p.r / 3)

  const vcf = c.createBiquadFilter()
  vcf.type = 'lowpass'
  vcf.Q.value = p.q
  vcf.frequency.setValueAtTime(p.cutoff + p.envCutoff, t0)
  vcf.frequency.setTargetAtTime(p.cutoff, t0 + 0.005, p.d / 2)
  vcf.connect(vca).connect(dest)

  const f = midiHz(pitch)
  const stopAt = end + p.r * 2 + 0.05
  for (const w of p.waves) {
    const o = c.createOscillator()
    o.type = w.type
    o.frequency.value = f * Math.pow(2, w.octave)
    o.detune.value = w.detune
    const g = c.createGain()
    g.gain.value = w.gain
    o.connect(g).connect(vcf)
    o.start(t0)
    o.stop(stopAt)
  }
}

/**
 * A note that sounds while a key is held: returns `stop`, which releases it. A lost note-off
 * cannot drone forever — the voice fades out by itself after `maxSec`.
 */
export function startNote(pitch: number, vel: number, preset: SynthPreset, maxSec = 8): () => void {
  const c = audioCtx()
  const p = PRESETS[preset]
  const t0 = c.currentTime
  const amp = p.level * (0.35 + 0.65 * (vel / 127))
  const tail = p.r * 2 + 0.05
  const vca = c.createGain()
  vca.gain.setValueAtTime(0, t0)
  vca.gain.linearRampToValueAtTime(amp, t0 + p.a)
  vca.gain.setTargetAtTime(amp * p.s, t0 + p.a, p.d / 3)
  vca.gain.setTargetAtTime(0, t0 + maxSec, p.r / 3)
  const vcf = c.createBiquadFilter()
  vcf.type = 'lowpass'
  vcf.Q.value = p.q
  vcf.frequency.setValueAtTime(p.cutoff + p.envCutoff, t0)
  vcf.frequency.setTargetAtTime(p.cutoff, t0 + 0.005, p.d / 2)
  vcf.connect(vca).connect(masterOut())
  const f = midiHz(pitch)
  const oscs = p.waves.map((w) => {
    const o = c.createOscillator()
    o.type = w.type
    o.frequency.value = f * Math.pow(2, w.octave)
    o.detune.value = w.detune
    const g = c.createGain()
    g.gain.value = w.gain
    o.connect(g).connect(vcf)
    o.start(t0)
    o.stop(t0 + maxSec + tail)
    return o
  })
  let done = false
  return () => {
    if (done) return
    done = true
    const t = Math.max(c.currentTime, t0 + p.a)
    if (t >= t0 + maxSec) return
    vca.gain.cancelScheduledValues(t)
    vca.gain.setValueAtTime(vca.gain.value, t)
    vca.gain.setTargetAtTime(0, t, p.r / 3)
    for (const o of oscs) o.stop(t + tail)
  }
}

function env(g: GainNode, t: number, peak: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.002)
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
}

function noiseHit(t: number, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number, dest: AudioNode) {
  const c = audioCtx()
  const src = c.createBufferSource()
  src.buffer = noiseBuffer()
  const f = c.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  const g = c.createGain()
  env(g, t, peak, decay)
  src.connect(f).connect(g).connect(dest)
  src.start(t)
  src.stop(t + decay + 0.05)
}

function toneHit(t: number, f0: number, f1: number, glide: number, peak: number, decay: number, dest: AudioNode, type: OscillatorType = 'sine') {
  const c = audioCtx()
  const o = c.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + glide)
  const g = c.createGain()
  env(g, t, peak, decay)
  o.connect(g).connect(dest)
  o.start(t)
  o.stop(t + decay + 0.05)
}

/** Synthesised drum hit for a GM note or drum class. */
export function playDrum(what: number | DrumClass, when: number, vel: number, opts: PlayOptions = {}) {
  const c = audioCtx()
  const t = Math.max(when, c.currentTime)
  const dest = opts.dest ?? masterOut()
  const v = (0.4 + 0.6 * (vel / 127)) * (opts.gain ?? 1)
  const cls = typeof what === 'number' ? gmToClass(what) : what
  switch (cls) {
    case 'kick':
      toneHit(t, 160, 45, 0.07, 0.9 * v, 0.38, dest)
      noiseHit(t, 'highpass', 3000, 0.7, 0.08 * v, 0.015, dest)
      break
    case 'snare':
      toneHit(t, 200, 170, 0.05, 0.35 * v, 0.1, dest, 'triangle')
      noiseHit(t, 'bandpass', 3500, 0.6, 0.5 * v, 0.2, dest)
      break
    case 'clap':
      for (const dt of [0, 0.011, 0.022]) noiseHit(t + dt, 'bandpass', 1800, 1.2, 0.35 * v, 0.03, dest)
      noiseHit(t + 0.03, 'bandpass', 1800, 1, 0.4 * v, 0.16, dest)
      break
    case 'rim':
      toneHit(t, 900, 800, 0.02, 0.3 * v, 0.04, dest, 'triangle')
      noiseHit(t, 'highpass', 5000, 1, 0.12 * v, 0.02, dest)
      break
    case 'closedHat':
      noiseHit(t, 'highpass', 8000, 0.8, 0.28 * v, 0.05, dest)
      break
    case 'openHat':
      noiseHit(t, 'highpass', 7500, 0.8, 0.25 * v, 0.32, dest)
      break
    case 'lowTom':
      toneHit(t, 110, 80, 0.15, 0.6 * v, 0.35, dest)
      break
    case 'midTom':
      toneHit(t, 150, 110, 0.15, 0.55 * v, 0.3, dest)
      break
    case 'highTom':
      toneHit(t, 200, 150, 0.12, 0.5 * v, 0.26, dest)
      break
    case 'crash':
      noiseHit(t, 'highpass', 4500, 0.5, 0.25 * v, 1.3, dest)
      break
    case 'ride':
      noiseHit(t, 'highpass', 6500, 0.5, 0.14 * v, 0.8, dest)
      toneHit(t, 3200, 3100, 0.1, 0.05 * v, 0.6, dest)
      break
    default:
      toneHit(t, 820, 800, 0.02, 0.18 * v, 0.09, dest, 'square')
      toneHit(t, 545, 540, 0.02, 0.12 * v, 0.09, dest, 'square')
  }
}

export function playClick(when: number, accent: boolean, opts: PlayOptions = {}) {
  const c = audioCtx()
  const t = Math.max(when, c.currentTime)
  toneHit(t, accent ? 1760 : 1180, accent ? 1760 : 1180, 0.01, (accent ? 0.35 : 0.22) * (opts.gain ?? 1), 0.035, opts.dest ?? masterOut(), 'square')
}
