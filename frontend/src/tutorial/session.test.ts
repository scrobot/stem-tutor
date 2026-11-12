/**
 * Play-mode scoring with a fake audio clock: hits, other-octave hits, holding long notes,
 * output-latency compensation and the end-of-run result.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Grid, Part } from '../types'
import type { TutorEvent, TutorTrack } from './events'

const clock = { t: 10, latency: 0 }

class FakeParam {
  value = 0
}
class FakeNode {
  gain = new FakeParam()
  threshold = new FakeParam()
  ratio = new FakeParam()
  connect<T>(n: T): T {
    return n
  }
}
class FakeAudioContext {
  state = 'running'
  destination = {}
  baseLatency = 0
  get outputLatency() {
    return clock.latency
  }
  get currentTime() {
    return clock.t
  }
  createGain() {
    return new FakeNode()
  }
  createDynamicsCompressor() {
    return new FakeNode()
  }
  resume() {
    return Promise.resolve()
  }
}

type SessionMod = typeof import('./session')
type MidiMod = typeof import('../midi/midi')
let S: SessionMod
let M: MidiMod
let PROFILE: (typeof import('../instruments/profiles'))['PROFILES'][number]

beforeAll(async () => {
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  S = await import('./session')
  M = await import('../midi/midi')
  PROFILE = (await import('../instruments/profiles')).PROFILES[0]
})

const grid: Grid = {
  beats: Array.from({ length: 64 }, (_, i) => i * 0.5),
  barLength: 4,
  timeSig: [4, 4],
  firstDownbeat: 0,
  bpm: 120,
  origin: 'tracked',
}

const ev = (i: number, start: number, dur: number, pitch: number): TutorEvent => ({
  i,
  start,
  dur,
  lane: pitch - 48,
  target: pitch,
  pitch,
  vel: 100,
  color: '#fff',
  label: '',
  drum: false,
  folded: false,
})

// 120 BPM: beat b is at b/2 seconds. Notes: C4 at 0 s, D4 at 0.5 s, E4 held 1–2 s, F4 at 2.5 s.
const track: TutorTrack = {
  events: [ev(0, 0, 0.5, 60), ev(1, 1, 0.5, 62), ev(2, 2, 2, 64), ev(3, 5, 0.5, 65)],
  lanes: { kind: 'keys', count: 25, lowNote: 48, labels: [], colors: [], slots: [] },
  octave: 0,
  folded: 0,
  layerCount: 1,
  layerIndex: 0,
  layerLabel: 'Вся партия',
  layerHint: '',
  layerKind: 'all',
}
const part = { id: 'p', name: 'Lead', role: 'melody', isDrum: false, origin: 'midi', notes: [], media: {} } as unknown as Part
const sound = { part: 'off', backing: false, mix: false, metronome: false, countIn: false, monitor: false, autoTempo: false, repeat: false } as const

let session: InstanceType<SessionMod['TutorSession']>
let songZero = 0 // clock time of song time 0

async function startPlay(latency = 0, opts: { t?: TutorTrack; repeat?: boolean; loop?: { start: number; end: number } } = {}) {
  clock.latency = latency
  session = new S.TutorSession(grid, opts.t ?? track, part, PROFILE, { offset: 0 }, { ...sound, repeat: !!opts.repeat }, 1)
  session.setMode('play')
  if (opts.loop) session.setLoop(opts.loop)
  const t0 = clock.t
  await session.toggle()
  songZero = t0 + 0.05 // Transport.play starts 50 ms ahead
}

// A one-bar riff for loop tests (beats 0–4 = 0–2 s): C4, D4, E4 held 1.5 beats, F4 a 16th
// before the bar line.
const riff: TutorTrack = {
  ...track,
  events: [ev(0, 0, 0.5, 60), ev(1, 1, 0.5, 62), ev(2, 2, 1.5, 64), ev(3, 3.75, 0.25, 65)],
}
const riffTimes: [number, number, number][] = [
  [0, 0.25, 60],
  [0.5, 0.25, 62],
  [1.0, 0.75, 64],
  [1.875, 0.1, 65],
] // [start s, hold s, note]

/** A flawless player who plays by ear: each press `latency` after the note is scheduled. */
function playPass(p: number, latency: number) {
  for (const [s, hold, note] of riffTimes) {
    at(p * 2 + s + latency)
    press(note)
    at(p * 2 + s + hold + latency)
    release(note)
  }
}

/** Move the audio clock (and the timers that poll it) to a song time. */
function at(songSec: number) {
  const target = songZero + songSec
  const dt = target - clock.t
  clock.t = target
  if (dt > 0) vi.advanceTimersByTime(Math.round(dt * 1000))
}

const press = (note: number) => M.emitMidi({ type: 'noteon', ch: 0, note, vel: 100, t: performance.now() })
const release = (note: number) => M.emitMidi({ type: 'noteoff', ch: 0, note, t: performance.now() })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  session?.dispose()
  vi.useRealTimers()
})

describe('play mode', () => {
  it('scores on-time presses and builds a combo', async () => {
    await startPlay()
    at(0.01)
    press(60)
    release(60)
    at(0.53)
    press(62)
    release(62)
    const s = session.getSnapshot().stats
    expect(s.perfect).toBe(2)
    expect(s.combo).toBe(2)
    expect(s.extra).toBe(0)
    expect(s.score).toBeGreaterThan(0)
  })

  it('counts the right note in another octave and says which OCT to press', async () => {
    await startPlay()
    at(0.0)
    press(48) // C3 instead of C4: the keybed sits one octave lower than the hint
    release(48)
    expect(session.getSnapshot().hint).toContain('OCT +')
    at(0.5)
    press(50) // D3 for D4: the same shift twice in a row is an OCT setting, not a wrong key
    release(50)
    const snap = session.getSnapshot()
    expect(snap.stats.perfect).toBe(1)
    expect(snap.stats.octave).toBe(1)
    expect(snap.hint).toContain('OCT +')
  })

  it('clears the OCT hint once the octave is fixed', async () => {
    await startPlay()
    at(0.0)
    press(48)
    release(48)
    at(0.5)
    press(62) // the player pressed OCT +: D4 is right now
    release(62)
    expect(session.getSnapshot().hint).toBeNull()
    expect(session.getSnapshot().octaveHint).toBeNull()
  })

  it('grades how long a long note is held', async () => {
    await startPlay()
    at(1.0)
    press(64)
    at(1.98)
    release(64)
    expect(session.getSnapshot().stats.held).toBe(1)

    await startPlay()
    at(1.0)
    press(64)
    at(1.3)
    release(64)
    const s = session.getSnapshot().stats
    expect(s.short).toBe(1)
    expect(s.points).toBeLessThan(1) // the hit is worth less when let go early
  })

  it('compensates the audio output latency', async () => {
    await startPlay(0.2)
    // The player hears song time 0.5 s only 200 ms after it is scheduled.
    at(0.5 + 0.2)
    press(62)
    expect(session.getSnapshot().stats.perfect).toBe(1)
  })

  it('plays through to the end and shows the result', async () => {
    await startPlay()
    at(0.0)
    press(60)
    release(60)
    at(3.6) // past the end of the part (3.0 s) plus the 0.5 s tail
    const snap = session.getSnapshot()
    expect(snap.playing).toBe(false)
    expect(snap.result).not.toBeNull()
    expect(snap.result!.stats.perfect).toBe(1)
    expect(snap.result!.stats.miss).toBe(3)
  })
})

describe('repeat mode', () => {
  it('scores every pass of a loop fully with 200 ms of output latency', async () => {
    await startPlay(0.2, { t: riff, repeat: true, loop: { start: 0, end: 4 } })
    for (let p = 0; p < 3; p++) playPass(p, 0.2)
    at(6 + 0.2 + 0.3) // hear the end of the third pass and its hit window
    const snap = session.getSnapshot()
    expect(snap.history.map((h) => Math.round(h.accuracy * 100))).toEqual([100, 100, 100])
    expect(snap.stats.extra).toBe(0)
  })

  it('credits an early downbeat to the next pass, not as an extra in the old one', async () => {
    await startPlay(0, { t: riff, repeat: true, loop: { start: 0, end: 4 } })
    playPass(0, 0)
    at(2 - 0.03) // the next pass's C4, 30 ms early: before the seam is heard
    press(60)
    release(60)
    at(2 + 0.5)
    press(62)
    release(62)
    at(2 + 1)
    const snap = session.getSnapshot()
    expect(snap.history[0].accuracy).toBe(1) // pass 1 was clean
    expect(snap.stats.perfect).toBe(2) // pass 2: the early C4 counted, and D4
    expect(snap.stats.extra).toBe(0)
  })

  it('a long note tied over the end of the block counts as held up to the loop end', async () => {
    const tied: TutorTrack = { ...track, events: [ev(0, 0, 0.5, 60), ev(1, 3, 2, 67)] } // G4 from beat 3 for 2 beats
    await startPlay(0, { t: tied, repeat: true, loop: { start: 0, end: 4 } })
    at(0)
    press(60)
    release(60)
    at(1.5)
    press(67)
    at(2.0)
    release(67)
    at(2.4)
    const h = session.getSnapshot().history
    expect(h[0].accuracy).toBe(1)
  })

  it('loops without a gap', async () => {
    await startPlay(0, { t: riff, repeat: true, loop: { start: 0, end: 4 } })
    at(2.01)
    expect(session.transport.now()).toBeCloseTo(0.01, 3)
  })
})

describe('one stretch, once or by layer', () => {
  it('with "по кругу" off a selected stretch plays once and ends with a result', async () => {
    await startPlay(0, { loop: { start: 0, end: 2 } }) // beats 0–2 = C4 and D4 only
    at(0)
    press(60)
    release(60)
    at(0.5)
    press(62)
    release(62)
    at(1.6) // the stretch ends at 1.0 s; nothing plays on to the end of the part
    const snap = session.getSnapshot()
    expect(snap.playing).toBe(false)
    expect(snap.result?.accuracy).toBe(1)
    expect(snap.result?.stats.miss).toBe(0)
  })

  it('a new track (another layer or OCT) keeps the session and starts the run over', async () => {
    const created: unknown[] = []
    const RealAudio = (globalThis as { Audio?: unknown }).Audio
    ;(globalThis as unknown as { Audio: unknown }).Audio = class {
      preload = ''
      volume = 0
      constructor() {
        created.push(this)
      }
      removeAttribute() {}
      pause() {}
    }
    try {
      clock.latency = 0
      session = new S.TutorSession(grid, track, part, PROFILE, { offset: 0, stem: '/x.ogg' }, { ...sound }, 1)
      expect(created).toHaveLength(1)
      session.setMode('play')
      const t1 = clock.t
      await session.toggle()
      songZero = t1 + 0.05
      at(0)
      press(60)
      release(60)
      expect(session.getSnapshot().stats.perfect).toBe(1)
      // The same notes an octave up — e.g. another stretch fitted to OCT +1.
      const up: TutorTrack = { ...track, octave: 1, events: track.events.map((e) => ({ ...e, target: e.target + 12, pitch: e.pitch + 12 })) }
      session.setTrack(up)
      expect(created).toHaveLength(1) // no new media
      const s0 = session.getSnapshot()
      expect(s0.stats.perfect).toBe(0)
      expect(s0.result).toBeNull()
      expect(s0.octaveNow).toBe(1)
      const t0 = clock.t
      await session.toggle()
      songZero = t0 + 0.05
      at(0)
      press(72)
      release(72)
      expect(session.getSnapshot().stats.perfect).toBe(1)
    } finally {
      ;(globalThis as unknown as { Audio: unknown }).Audio = RealAudio
    }
  })
})

describe('step mode', () => {
  const chordTrack: TutorTrack = { ...track, events: [ev(0, 0, 4, 60), ev(1, 0, 4, 64), ev(2, 0, 4, 67), ev(3, 4, 1, 62)] }
  const learn = (together: boolean) => {
    session = new S.TutorSession(grid, chordTrack, part, PROFILE, { offset: 0 }, { ...sound }, 1)
    session.setChordsTogether(together)
    session.setMode('learn')
  }

  it('takes a chord one key at a time by default', () => {
    learn(false)
    for (const p of [60, 64, 67]) {
      press(p)
      release(p)
    }
    expect(session.getSnapshot().stepIndex).toBe(1)
  })

  it('in chord lessons waits until all keys of the chord are held together', () => {
    learn(true)
    for (const p of [60, 64, 67]) {
      press(p)
      release(p)
    }
    expect(session.getSnapshot().stepIndex).toBe(0)
    expect(session.getSnapshot().hint).toContain('вместе')
    press(60)
    press(64)
    press(67)
    expect(session.getSnapshot().stepIndex).toBe(1)
    for (const p of [60, 64, 67]) release(p)
  })
})

describe('pause and corrections', () => {
  it('Start after Pause resumes the run instead of restarting it', async () => {
    await startPlay()
    at(0)
    press(60)
    release(60)
    at(0.3)
    await session.toggle() // pause
    expect(session.getSnapshot().paused).toBe(true)
    const t0 = clock.t
    await session.toggle() // resume
    songZero = t0 + 0.05 - 0.3 // the time line continues at song time 0.3
    expect(session.getSnapshot().stats.perfect).toBe(1)
    at(0.5)
    press(62)
    release(62)
    expect(session.getSnapshot().stats.perfect).toBe(2)
  })

  it('a negative correction below the measured latency still applies', async () => {
    await startPlay(0.03)
    session.setInputOffset(-80) // the player is steadily 80 ms ahead of what they hear
    at(0.5 + 0.03 - 0.08)
    press(62)
    expect(session.getSnapshot().stats.perfect).toBe(1)
  })
})

describe('helpers', () => {
  it('ignores MIDI time stamps from another clock', () => {
    expect(M.eventTime(995, 1000)).toBe(995)
    expect(M.eventTime(700, 1000)).toBe(700) // a page busy for 300 ms keeps the real time
    expect(M.eventTime(1000 - 5000, 1000)).toBe(1000)
    expect(M.eventTime(1000 + 3000, 1000)).toBe(1000)
    expect(M.eventTime(0, 1000)).toBe(1000)
  })
  it('grades holds and finds a steady offset', () => {
    expect(S.holdGrade(0.98, 1).grade).toBe('held')
    expect(S.holdGrade(0.4, 1).grade).toBe('short')
    expect(S.holdGrade(1.6, 1).grade).toBe('long')
    expect(S.steadyOffset(Array.from({ length: 10 }, (_, i) => 0.2 + (i % 3) * 0.01))).toBeCloseTo(0.21, 2)
    expect(S.steadyOffset([0.01, -0.02, 0.03, 0, 0.02, -0.01, 0.01, 0])).toBeNull()
  })
})
