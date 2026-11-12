/**
 * Tutorial session: owns the transport, media, synth guide and the MIDI input logic of
 * the three practice modes. Lives outside React; the page subscribes to a throttled
 * snapshot for UI and the waterfall reads refs every frame.
 *
 * Play mode scores on an unrolled, *heard* time line: pass p of a repeated stretch lies
 * p × its length later. A press near a loop seam is credited to whichever pass it is closer
 * to (a late last note, an early downbeat), and a pass is closed only once it has been
 * heard to its end.
 */
import { Transport, audioCtx, outputLatency, resumeAudio, type FollowedMedia } from '../audio/engine'
import { metronomeSource, notesSource, type TimedNote } from '../audio/sources'
import { playDrum, playNote, presetForRole, startNote } from '../audio/synth'
import { newWaterfallState, type Grade, type HoldGrade, type WaterfallState } from '../components/Waterfall'
import { classifyNote, type InstrumentProfile } from '../instruments/profiles'
import { onMidi, type MidiMsg } from '../midi/midi'
import { beatTime, inStretch, localBeatSec, timeToBeat } from '../music/grid'
import type { Grid, Part } from '../types'
import { stepGroups, type StepGroup, type TutorEvent, type TutorTrack } from './events'

export type Mode = 'prepare' | 'watch' | 'learn' | 'play' | 'daw'

export interface SoundSettings {
  part: 'stem' | 'synth' | 'off'
  backing: boolean
  mix: boolean
  metronome: boolean
  countIn: boolean
  monitor: boolean
  autoTempo: boolean
  /** Play mode: repeat the selected stretch (true) or play it once and show the result. */
  repeat: boolean
}

export interface PlayStats {
  perfect: number
  good: number
  ok: number
  miss: number
  extra: number
  offsets: number[] // real seconds, + = late
  held: number // long notes held to their end
  short: number // … let go too early
  long: number // … held well past their end
  octave: number // right note, other octave (the keybed's OCT differs from the hint)
  points: number // sum of per-note scores (timing × hold), for the accuracy
  score: number // game score (whole run): points × 100 × combo multiplier
  combo: number
  maxCombo: number
}

export interface RunResult {
  accuracy: number
  score: number
  maxCombo: number
  stats: PlayStats
  tempo: number
  meanOffsetMs: number
}

export interface SessionSnapshot {
  mode: Mode
  playing: boolean
  paused: boolean
  beat: number
  octaveNow: number
  expectedLanes: number[]
  stepIndex: number
  stepTotal: number
  loopsDone: number
  cleanLoops: number
  mistakes: number
  hint: string | null
  octaveHint: 'up' | 'down' | null
  stats: PlayStats
  history: { accuracy: number; tempo: number; meanOffsetMs: number }[]
  tempo: number
  /** Play mode: the finished run (shown until the next start). */
  result: RunResult | null
  /** Audio output latency the scoring compensates for, plus the player's correction (ms). */
  latencyMs: number
  /** A steady timing offset found in the last pass or run (ms, + = late): offer a correction. */
  calibrateMs: number | null
}

const emptyStats = (): PlayStats => ({
  perfect: 0,
  good: 0,
  ok: 0,
  miss: 0,
  extra: 0,
  offsets: [],
  held: 0,
  short: 0,
  long: 0,
  octave: 0,
  points: 0,
  score: 0,
  combo: 0,
  maxCombo: 0,
})

const GRADE_SCORE: Record<Exclude<Grade, 'miss'>, number> = { perfect: 1, good: 0.85, ok: 0.5 }

export function accuracyOf(s: PlayStats): number {
  const total = s.perfect + s.good + s.ok + s.miss
  if (!total) return 0
  return Math.max(0, Math.min(1, (s.points - s.extra * 0.25) / total))
}

/** Score multiplier for a combo: ×1, then +1 every 10 notes in a row, up to ×4. */
export const multiplierOf = (combo: number) => Math.min(4, 1 + Math.floor(combo / 10))

/** Notes at least this long (real seconds at the current tempo) must also be held. */
export const HOLD_MIN_SEC = 0.3

/** How a release compares with the note's end (all in real seconds). */
export function holdGrade(heldSec: number, durSec: number): { grade: HoldGrade; factor: number } {
  const early = durSec - heldSec
  if (early > Math.max(0.12, 0.2 * durSec)) return { grade: 'short', factor: 0.5 + 0.5 * Math.max(0, Math.min(1, heldSec / durSec)) }
  if (-early > Math.max(0.25, 0.25 * durSec)) return { grade: 'long', factor: 0.9 }
  return { grade: 'held', factor: 1 }
}

/** A steady offset worth correcting: enough presses, consistently early or late. */
export function steadyOffset(offsets: number[]): number | null {
  if (offsets.length < 8) return null
  const s = [...offsets].sort((a, b) => a - b)
  const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]
  const median = q(0.5)
  if (Math.abs(median) < 0.03 || q(0.75) - q(0.25) > 0.12) return null
  return median
}

export interface MediaSources {
  stem?: string
  backing?: string
  mix?: string
  offset: number
}

interface Hold {
  pass: number
  i: number
  start: number // unrolled song seconds
  end: number // … clipped to the end of its pass
  score: number // the note's timing score, scaled by how well it is held
  lane: number
}

/** One pass over the played stretch (the whole run when it does not repeat). */
interface PassState {
  stats: PlayStats // combo and score live on the run
  grades: Map<number, Grade>
  held: Map<number, number | null>
  holdGrades: Map<number, HoldGrade>
  matched: Set<number>
  nearOffsets: number[]
  closed: boolean
}

const newPass = (): PassState => ({
  stats: emptyStats(),
  grades: new Map(),
  held: new Map(),
  holdGrades: new Map(),
  matched: new Set(),
  nearOffsets: [],
  closed: false,
})

const WINDOW = 0.15 // ±150 ms of real time for a hit

export class TutorSession {
  readonly transport = new Transport()
  readonly wf: { current: WaterfallState } = { current: newWaterfallState() }
  private snap: SessionSnapshot
  private subs = new Set<() => void>()
  private unsubs: (() => void)[] = []
  private media: { stem?: HTMLAudioElement; backing?: HTMLAudioElement; mix?: HTMLAudioElement } = {}
  private loopBeats: { start: number; end: number } | null = null
  private groups: StepGroup[] = []
  private pending = new Set<number>()
  private display = 0 // animated beat for learn mode
  private loopMistakes = 0
  private uiTimer: number
  private sound: SoundSettings
  private offsetMs = 0
  // play mode
  private spanSec = { start: 0, end: 2 }
  private passLen = Infinity // song seconds per pass; Infinity: one pass (play-through)
  private spanEvents: TutorEvent[] = []
  private passes = new Map<number, PassState>()
  private shownPass = 0
  private holds = new Map<number, Hold>() // by the MIDI note that is held down
  private run = { combo: 0, maxCombo: 0, score: 0 }
  private lastShift = 0 // octave shift of the previous unmatched press
  // input
  private pressedBy = new Map<number, number>() // MIDI note → lane lit while it is down
  private voices = new Map<number, () => void>() // monitor voices by MIDI note
  private held = new Set<number>() // MIDI notes that are down right now
  private chordsTogether = false // step mode: a chord counts only with all its keys held at once
  private guideOff: (() => void) | null = null

  constructor(
    private grid: Grid,
    private track: TutorTrack,
    private part: Part,
    private profile: InstrumentProfile,
    sources: MediaSources,
    sound: SoundSettings,
    tempo: number,
    inputOffsetMs = 0,
  ) {
    this.sound = { ...sound }
    this.offsetMs = inputOffsetMs
    this.transport.rate = tempo
    this.snap = {
      mode: 'prepare',
      playing: false,
      paused: false,
      beat: 0,
      octaveNow: track.octave,
      expectedLanes: [],
      stepIndex: 0,
      stepTotal: 0,
      loopsDone: 0,
      cleanLoops: 0,
      mistakes: 0,
      hint: null,
      octaveHint: null,
      stats: emptyStats(),
      history: [],
      tempo,
      result: null,
      latencyMs: inputOffsetMs,
      calibrateMs: null,
    }
    const mk = (src?: string) => {
      if (!src) return undefined
      const el = new Audio(src)
      el.preload = 'auto'
      el.volume = 0
      return el
    }
    this.media = { stem: mk(sources.stem), backing: mk(sources.backing), mix: mk(sources.mix) }
    for (const el of Object.values(this.media)) {
      if (el) this.unsubs.push(this.transport.follow({ el, offset: sources.offset } as FollowedMedia))
    }
    this.addGuide()
    this.unsubs.push(
      this.transport.addSource(
        metronomeSource(grid, {
          enabled: (t) =>
            this.sound.metronome ||
            (this.sound.countIn && this.countInRange !== null && t < beatTime(grid, this.countInRange.start) - 0.01),
        }),
      ),
    )
    this.transport.onLoop = () => {
      if (this.snap.mode !== 'play') this.update({ loopsDone: this.snap.loopsDone + 1 })
    }
    this.transport.onStop = () => {
      this.finishRun()
      this.update({ playing: false, paused: false })
    }
    this.unsubs.push(onMidi((m) => this.onMidi(m)))
    this.applyVolumes()
    this.uiTimer = window.setInterval(() => this.refreshUi(), 90)
  }

  // -- external API ----------------------------------------------------------------------
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }
  getSnapshot = () => this.snap

  /** Beat position shown by the waterfall: what the player hears right now. */
  getNow = (): number => {
    if (this.snap.mode === 'learn') {
      const target = this.groups[this.snap.stepIndex]?.start ?? this.loopBeats?.start ?? 0
      this.display += (target - this.display) * 0.18
      return this.display
    }
    if (this.snap.mode === 'watch' || this.snap.mode === 'play') return timeToBeat(this.grid, this.transport.heardNow())
    return (this.loopBeats?.start ?? this.track.events[0]?.start ?? 0) - 1
  }

  setLoop(range: { start: number; end: number } | null) {
    const changed = (range?.start ?? null) !== (this.loopBeats?.start ?? null) || (range?.end ?? null) !== (this.loopBeats?.end ?? null)
    this.loopBeats = range
    this.stop()
    this.resetLoopState()
    if (changed) this.update({ result: null, history: [] })
    this.park()
    if (this.snap.mode === 'learn') this.startLearn()
  }

  /**
   * Another layer or another stretch (its own OCT setting) without rebuilding the session:
   * the media, tempo, mode and sound settings stay; the run starts over.
   */
  setTrack(track: TutorTrack) {
    if (track === this.track) return
    this.stop()
    this.track = track
    this.addGuide()
    this.resetLoopState()
    this.update({ octaveNow: track.octave, expectedLanes: [], result: null, history: [] })
    this.park()
    if (this.snap.mode === 'learn') this.startLearn()
  }

  setMode(mode: Mode) {
    this.stop()
    this.update({ mode, hint: null, octaveHint: null, result: null })
    this.resetLoopState()
    this.park()
    if (mode === 'learn') this.startLearn()
    this.applyVolumes()
  }

  setTempo(rate: number) {
    this.transport.setRate(rate)
    this.update({ tempo: rate })
  }

  setSound(s: Partial<SoundSettings>) {
    const repeatChanged = s.repeat !== undefined && s.repeat !== this.sound.repeat
    this.sound = { ...this.sound, ...s }
    this.applyVolumes()
    if (!this.sound.monitor) this.releaseVoices()
    if (repeatChanged && this.snap.mode === 'play') {
      this.stop()
      this.resetLoopState()
      this.park()
    }
  }

  /** Step mode: take a chord only when all its keys are held together (chord lessons). */
  setChordsTogether(on: boolean) {
    if (on === this.chordsTogether) return
    this.chordsTogether = on
    if (this.snap.mode === 'learn') this.startLearn()
  }

  /** The player's own timing correction on top of the measured output latency (ms). */
  setInputOffset(ms: number) {
    this.offsetMs = ms
    this.transport.latency = this.latencySec()
    this.update({ latencyMs: Math.round(this.transport.latency * 1000), calibrateMs: null })
  }

  /** Start/Pause. A pause keeps the run: Start then resumes where it stopped. */
  async toggle() {
    await resumeAudio()
    if (this.transport.playing) this.stop()
    else if (this.snap.paused) this.resume()
    else this.start()
  }

  restart() {
    this.stop()
    this.resetLoopState()
    if (this.snap.mode === 'learn') this.startLearn()
    else this.start()
  }

  dispose() {
    this.stop()
    this.releaseVoices()
    window.clearInterval(this.uiTimer)
    this.guideOff?.()
    this.guideOff = null
    for (const u of this.unsubs) u()
    this.transport.dispose()
    for (const el of Object.values(this.media)) el?.removeAttribute('src')
    this.subs.clear()
  }

  // -- internals -------------------------------------------------------------------------
  /** The synth guide for the current track (watch mode, play mode with the hint on). */
  private addGuide() {
    this.guideOff?.()
    const guide: TimedNote[] = this.track.events.map((e) => ({
      s: beatTime(this.grid, e.start),
      e: beatTime(this.grid, e.start + e.dur),
      pitch: e.pitch,
      vel: e.vel,
      drum: e.drum,
    }))
    this.guideOff = this.transport.addSource(
      notesSource(guide, {
        preset: presetForRole(this.part.role),
        enabled: () => (this.snap.mode === 'watch' || this.snap.mode === 'play') && this.sound.part === 'synth',
      }),
    )
  }

  private update(p: Partial<SessionSnapshot>) {
    this.snap = { ...this.snap, ...p }
    for (const fn of this.subs) fn()
  }

  private latencySec(): number {
    return outputLatency() + this.offsetMs / 1000
  }

  private wholeRange(): { start: number; end: number } {
    const ev = this.track.events
    if (!ev.length) return { start: 0, end: 4 }
    const end = Math.max(...ev.map((e) => e.start + e.dur))
    return { start: Math.floor(ev[0].start), end: Math.ceil(end) }
  }

  /** The selected stretch (a block or a range of blocks), or the whole part. */
  private range(): { start: number; end: number } {
    return this.loopBeats ?? this.wholeRange()
  }

  /** Show the start of the selection while stopped. */
  private park() {
    if (this.snap.mode === 'watch' || this.snap.mode === 'play') this.transport.seek(beatTime(this.grid, this.range().start))
  }

  private applyVolumes() {
    const playing = this.snap.mode === 'watch' || this.snap.mode === 'play'
    const { stem, backing, mix } = this.media
    if (stem) stem.volume = playing && this.sound.part === 'stem' ? 1 : 0
    if (backing) backing.volume = playing && this.sound.backing ? 0.9 : 0
    if (mix) mix.volume = playing && this.sound.mix ? 0.8 : 0
  }

  private start() {
    if (this.snap.mode !== 'watch' && this.snap.mode !== 'play') return
    const play = this.snap.mode === 'play'
    // Play mode repeats the selection (the whole part with nothing selected) or plays it once;
    // watch mode loops a selected stretch.
    const looping = play ? this.sound.repeat : this.loopBeats !== null
    const r = this.range()
    const startSec = beatTime(this.grid, r.start)
    const endSec = beatTime(this.grid, r.end)
    this.spanSec = { start: startSec, end: endSec }
    this.passLen = looping && endSec > startSec ? endSec - startSec : Infinity
    this.spanEvents = this.track.events.filter((e) => inStretch(e.start, r))
    this.transport.loop = looping ? { start: startSec, end: endSec } : null
    this.transport.endTime = endSec + 0.5
    this.transport.latency = this.latencySec()
    let from = startSec
    if (this.sound.countIn) from -= this.grid.barLength * localBeatSec(this.grid, r.start)
    this.countInRange = r
    this.resetLoopState()
    this.transport.play(from)
    this.applyVolumes()
    this.update({ playing: true, paused: false, result: null, latencyMs: Math.round(this.transport.latency * 1000) })
  }

  private resume() {
    this.countInRange = null
    this.transport.latency = this.latencySec()
    this.transport.play()
    this.update({ playing: true, paused: false })
  }

  private countInRange: { start: number; end: number } | null = null

  private stop() {
    const wasPlaying = this.transport.playing
    if (wasPlaying && this.snap.mode === 'play') this.settleHolds(this.transport.heardUnrolledNow(), true)
    this.transport.pause()
    this.update({ playing: false, paused: wasPlaying && (this.snap.mode === 'watch' || this.snap.mode === 'play') })
  }

  private resetLoopState() {
    const st = this.wf.current
    st.done.clear()
    st.grades.clear()
    st.held.clear()
    st.holdGrades.clear()
    st.flashes = []
    st.expected = null
    this.passes.clear()
    this.shownPass = 0
    this.holds.clear()
    this.run = { combo: 0, maxCombo: 0, score: 0 }
    this.lastShift = 0
    this.loopMistakes = 0
    this.update({ stats: emptyStats(), hint: null, octaveHint: null, paused: false })
  }

  private releaseVoices() {
    for (const off of this.voices.values()) off()
    this.voices.clear()
  }

  // -- passes ----------------------------------------------------------------------------
  private looping(): boolean {
    return this.passLen !== Infinity
  }

  private passOf(u: number): number {
    if (!this.looping()) return 0
    return Math.max(0, Math.floor((u - this.spanSec.start) / this.passLen))
  }

  private pass(p: number): PassState {
    let s = this.passes.get(p)
    if (!s) {
      s = newPass()
      this.passes.set(p, s)
    }
    return s
  }

  private evStart(e: TutorEvent, p: number): number {
    return beatTime(this.grid, e.start) + (this.looping() ? p * this.passLen : 0)
  }

  private passEnd(p: number): number {
    return this.spanSec.end + (this.looping() ? p * this.passLen : 0)
  }

  /** The stats the page shows: the pass being heard, with the run's combo and score. */
  private shownStats(): PlayStats {
    const s = this.passes.get(this.shownPass)?.stats ?? emptyStats()
    return { ...s, combo: this.run.combo, maxCombo: this.run.maxCombo, score: this.run.score }
  }

  private publish(extra: Partial<SessionSnapshot> = {}) {
    this.update({ stats: this.shownStats(), ...extra })
  }

  /** Mirror one pass into the waterfall (it shows the pass being heard). */
  private showPass(p: number) {
    this.shownPass = p
    const st = this.wf.current
    const s = this.pass(p)
    st.grades = new Map(s.grades)
    st.held = new Map(s.held)
    st.holdGrades = new Map(s.holdGrades)
  }

  /** The unplayed event nearest to `u` (within `win`), over the given passes. */
  private nearest(u: number, win: number, passes: number[], ok: (e: TutorEvent) => boolean): { e: TutorEvent; p: number; d: number } | null {
    let best: { e: TutorEvent; p: number; d: number } | null = null
    for (const p of passes) {
      const s = this.passes.get(p)
      if (s?.closed) continue
      for (const e of this.spanEvents) {
        if (s?.matched.has(e.i) || !ok(e)) continue
        const d = u - this.evStart(e, p)
        if (Math.abs(d) <= win && (!best || Math.abs(d) < Math.abs(best.d))) best = { e, p, d }
      }
    }
    return best
  }

  private candidatePasses(u: number): number[] {
    if (!this.looping()) return [0]
    const p = this.passOf(u)
    return [p - 1, p, p + 1].filter((x) => x >= 0)
  }

  /** Book notes whose hit window has passed unplayed. */
  private sweepMisses(u: number) {
    const rate = this.transport.rate
    const st = this.wf.current
    const last = this.passOf(u)
    let changed = false
    for (let p = this.looping() ? Math.max(0, last - 1) : 0; p <= last; p++) {
      const s = this.pass(p)
      if (s.closed) continue
      for (const e of this.spanEvents) {
        if (s.matched.has(e.i) || s.grades.has(e.i)) continue
        if (this.evStart(e, p) + WINDOW * rate < u) {
          s.grades.set(e.i, 'miss')
          s.stats.miss++
          this.run.combo = 0
          if (p === this.shownPass) st.grades.set(e.i, 'miss')
          changed = true
        }
      }
    }
    if (changed) this.publish()
  }

  /** Close the passes that have been heard to their end (plus the hit window). */
  private closePasses(u: number) {
    if (!this.looping()) return
    const rate = this.transport.rate
    for (const [p, s] of [...this.passes].sort((a, b) => a[0] - b[0])) {
      if (s.closed || this.passEnd(p) + WINDOW * rate >= u) continue
      this.sweepMisses(this.passEnd(p) + WINDOW * rate + 1e-6)
      for (const [note, h] of [...this.holds]) {
        if (h.pass === p) {
          this.holds.delete(note)
          this.gradeHold(h, h.end)
        }
      }
      s.closed = true
      this.summarize(s, false)
      if (p < this.shownPass - 1) this.passes.delete(p)
    }
  }

  /** History, calibration and (repeat mode) auto-tempo after a pass or a run. */
  private summarize(s: PassState, end: boolean) {
    const stats = s.stats
    const total = stats.perfect + stats.good + stats.ok + stats.miss
    if (!total) return
    const acc = accuracyOf(stats)
    const mean = stats.offsets.length ? (stats.offsets.reduce((a, b) => a + b, 0) / stats.offsets.length) * 1000 : 0
    const history = [...this.snap.history, { accuracy: acc, tempo: this.transport.rate, meanOffsetMs: mean }].slice(-12)
    const steady = steadyOffset([...stats.offsets, ...s.nearOffsets])
    const calibrateMs = steady === null ? this.snap.calibrateMs : Math.round(steady * 1000)
    const result: RunResult | null = end
      ? { accuracy: acc, score: Math.round(this.run.score), maxCombo: this.run.maxCombo, stats: { ...stats, combo: this.run.combo, maxCombo: this.run.maxCombo, score: this.run.score }, tempo: this.transport.rate, meanOffsetMs: mean }
      : this.snap.result
    this.update({ history, calibrateMs, result, loopsDone: this.snap.loopsDone + (end ? 0 : 1) })
    if (!end && this.sound.autoTempo && acc >= 0.9 && this.transport.rate < 1) {
      this.setTempo(Math.min(1, Math.round((this.transport.rate + 0.05) * 100) / 100))
    }
  }

  /** End of a play-through: grade what is left and keep the result. */
  private finishRun() {
    if (this.snap.mode !== 'play') return
    const u = this.transport.heardUnrolledNow()
    this.sweepMisses(Math.max(u, this.passEnd(this.passOf(u)) + 10))
    this.settleHolds(Infinity, true)
    const s = this.pass(0)
    this.summarize(s, true)
    this.publish()
  }

  // -- learn mode ------------------------------------------------------------------------
  private startLearn() {
    const r = this.range()
    this.groups = stepGroups(this.track.events, r.start, r.end)
    this.display = this.groups[0]?.start ?? r.start
    this.setStep(0)
    this.update({ stepTotal: this.groups.length, loopsDone: 0, cleanLoops: 0, mistakes: 0 })
  }

  private setStep(i: number) {
    const g = this.groups[i]
    this.pending = new Set(g?.targets ?? [])
    const st = this.wf.current
    st.expected = new Set(g?.events.map((e) => e.lane) ?? [])
    this.update({ stepIndex: i })
  }

  // -- input -----------------------------------------------------------------------------
  private laneOf(m: { ch: number; note: number }): { lane: number | null; target: number; pad: boolean; bank?: number } {
    const pad = classifyNote(this.profile, m.ch, m.note)
    if (this.track.lanes.kind === 'pads') {
      if (!pad) return { lane: null, target: m.note, pad: false }
      const lane = this.track.lanes.slots.findIndex((s) => s.bank === pad.bank && s.pad === pad.pad)
      return { lane: lane >= 0 ? lane : null, target: m.note, pad: true, bank: pad.bank }
    }
    if (pad && !this.part.isDrum) return { lane: null, target: -1, pad: true }
    const lane = m.note - (this.track.lanes.lowNote + 12 * this.track.octave)
    return { lane: lane >= 0 && lane < this.track.lanes.count ? lane : null, target: m.note, pad: false }
  }

  private getNowCoarse(): number {
    if (this.snap.mode === 'learn') return this.groups[this.snap.stepIndex]?.start ?? 0
    return timeToBeat(this.grid, this.transport.heardNow())
  }

  private onMidi(m: MidiMsg) {
    if (m.type !== 'noteon' && m.type !== 'noteoff') return
    const info = this.laneOf(m)
    const st = this.wf.current
    if (m.type === 'noteon') this.held.add(m.note)
    else this.held.delete(m.note)
    if (m.type === 'noteoff') {
      const lit = this.pressedBy.get(m.note) ?? info.lane
      if (lit !== null) st.pressed.delete(lit)
      this.pressedBy.delete(m.note)
      this.voices.get(m.note)?.()
      this.voices.delete(m.note)
      if (this.snap.mode === 'play' && this.transport.playing) this.release(m.note, m.t)
      return
    }
    if (info.lane !== null) {
      st.pressed.add(info.lane)
      this.pressedBy.set(m.note, info.lane)
    }
    if (this.sound.monitor) {
      const c = audioCtx()
      if (this.track.lanes.kind === 'pads' && info.lane !== null) playDrum(this.track.lanes.slots[info.lane].gmNotes[0] ?? 36, c.currentTime, m.vel)
      else if (!info.pad) {
        // the voice lasts as long as the key is down
        this.voices.get(m.note)?.()
        this.voices.set(m.note, startNote(m.note, m.vel, presetForRole(this.part.role)))
      }
    }
    if (this.snap.mode === 'learn') this.learnInput(info, m.note)
    else if (this.snap.mode === 'play' && this.transport.playing) this.playInput(info, m.note, m.t)
  }

  private octaveHintFor(d: number): Partial<SessionSnapshot> {
    return {
      hint: `Нота верная, но октава другая — нажми ${d > 0 ? 'OCT +' : 'OCT −'} ${Math.abs(d)} раз${Math.abs(d) > 1 ? 'а' : ''}.`,
      octaveHint: d > 0 ? 'up' : 'down',
    }
  }

  /** The current step is done: play it back and move on (or start the loop over). */
  private completeStep(g: StepGroup) {
    const st = this.wf.current
    for (const e of g.events) st.done.add(e.i)
    this.guide(g)
    const next = this.snap.stepIndex + 1
    if (next >= this.groups.length) {
      const clean = this.loopMistakes === 0
      this.loopMistakes = 0
      st.done.clear()
      this.update({
        loopsDone: this.snap.loopsDone + 1,
        cleanLoops: this.snap.cleanLoops + (clean ? 1 : 0),
        hint: clean ? 'Круг без ошибок! ✓' : 'Круг пройден — ещё раз, без ошибок.',
        octaveHint: null,
      })
      this.display = this.groups[0]?.start ?? 0
      this.setStep(0)
    } else {
      this.update({ hint: null, octaveHint: null })
      this.setStep(next)
    }
  }

  private learnInput(info: ReturnType<TutorSession['laneOf']>, note: number) {
    const st = this.wf.current
    const g = this.groups[this.snap.stepIndex]
    if (!g) return
    if (this.chordsTogether && this.track.lanes.kind === 'keys' && g.targets.size > 1 && g.targets.has(info.target)) {
      // A chord: it counts once all its keys are down together.
      if (info.lane !== null) st.flashes.push({ lane: info.lane, text: '✓', color: '#5bd6a7', t: performance.now() })
      if ([...g.targets].every((t) => this.held.has(t))) this.completeStep(g)
      else this.update({ hint: 'Зажмите все клавиши аккорда вместе: держите нажатые и добавьте остальные.', octaveHint: null })
      return
    }
    if (this.pending.has(info.target)) {
      this.pending.delete(info.target)
      if (info.lane !== null) st.flashes.push({ lane: info.lane, text: '✓', color: '#5bd6a7', t: performance.now() })
      if (this.pending.size === 0) this.completeStep(g)
      return
    }
    // Wrong input.
    this.loopMistakes++
    this.update({ mistakes: this.snap.mistakes + 1 })
    if (info.lane !== null) st.wrong.set(info.lane, performance.now())
    const targets = [...this.pending]
    if (this.track.lanes.kind === 'keys') {
      const same = targets.find((t) => ((t - note) % 12 + 12) % 12 === 0)
      if (same !== undefined && same !== note) {
        this.update(this.octaveHintFor(Math.round((same - note) / 12)))
        return
      }
      this.update({ hint: null, octaveHint: null })
    } else {
      const slot = this.track.lanes.slots.find((s) => this.pending.has(s.note))
      const otherBank = this.profile.pads?.banks.findIndex((b) => b.notes.includes(note)) ?? -1
      if (slot && otherBank >= 0 && otherBank !== slot.bank) {
        this.update({ hint: `Проверь банк пэдов: нужен банк ${this.profile.pads!.banks[slot.bank].id}.`, octaveHint: null })
      } else if (slot) {
        this.update({ hint: `Нужен пэд ${this.profile.pads!.banks[slot.bank].id}${slot.pad + 1} — ${slot.label}.`, octaveHint: null })
      }
    }
  }

  /** Step mode: after a correct chord, play it back (unless the player monitors their own notes). */
  private guide(g: StepGroup) {
    if (this.sound.part === 'off' || this.sound.monitor) return
    const c = audioCtx()
    for (const e of g.events) {
      if (e.drum) playDrum(e.pitch, c.currentTime + 0.01, e.vel)
      else playNote(e.pitch, c.currentTime + 0.01, Math.min(0.8, e.dur * localBeatSec(this.grid, e.start)), e.vel, presetForRole(this.part.role))
    }
  }

  private playInput(info: ReturnType<TutorSession['laneOf']>, note: number, tMs: number) {
    const st = this.wf.current
    const u = this.transport.heardUnrolledAt(tMs)
    this.sweepMisses(u) // misses due before this press are booked first (combo order)
    const rate = this.transport.rate
    const win = WINDOW * rate
    const keys = this.track.lanes.kind === 'keys'
    const passes = this.candidatePasses(u)
    let best = this.nearest(u, win, passes, (e) => e.target === info.target)
    // The keybed does not report its OCT setting: the right note an octave or two away counts
    // — but only when the shift is consistent (two presses in a row), so a single wrong key an
    // octave off is not taken for an OCT problem.
    let octaveShift = 0
    if (best) this.lastShift = 0
    else if (keys && !info.pad) {
      const shifted = this.nearest(u, win, passes, (e) => e.target !== note && (((e.target - note) % 12) + 12) % 12 === 0)
      if (shifted) {
        const k = Math.round((shifted.e.target - note) / 12)
        if (this.lastShift === k) {
          best = shifted
          octaveShift = k
        }
        this.lastShift = k
      }
    }
    if (!best) {
      const s = this.pass(this.passOf(u))
      const near = this.nearest(u, 0.6 * rate, passes, (e) => e.target === info.target)
      if (near) s.nearOffsets.push(near.d / rate)
      s.stats.extra++
      this.run.combo = 0
      if (info.lane !== null) {
        st.wrong.set(info.lane, performance.now())
        st.flashes.push({ lane: info.lane, text: '×', color: '#ff6b6b', t: performance.now() })
      }
      this.publish(octaveShift === 0 && this.lastShift !== 0 ? this.octaveHintFor(this.lastShift) : {})
      return
    }
    const { e: ev, p } = best
    const s = this.pass(p)
    const real = Math.abs(best.d) / rate
    const grade: Exclude<Grade, 'miss'> = real <= 0.045 ? 'perfect' : real <= 0.09 ? 'good' : 'ok'
    if (s.grades.get(ev.i) === 'miss') s.stats.miss = Math.max(0, s.stats.miss - 1) // handled late, played in time
    s.matched.add(ev.i)
    s.grades.set(ev.i, grade)
    if (p === this.shownPass) st.grades.set(ev.i, grade)
    if (octaveShift) {
      // light the key the note belongs to, not the (off-screen) one the keybed sent
      const lit = this.pressedBy.get(note)
      if (lit !== undefined) st.pressed.delete(lit)
      st.pressed.add(ev.lane)
      this.pressedBy.set(note, ev.lane)
    }
    const value = GRADE_SCORE[grade]
    s.stats[grade]++
    s.stats.offsets = [...s.stats.offsets, best.d / rate]
    s.stats.points += value
    this.run.combo += 1
    this.run.maxCombo = Math.max(this.run.maxCombo, this.run.combo)
    this.run.score += value * 100 * multiplierOf(this.run.combo)
    const startU = this.evStart(ev, p)
    const endU = Math.min(startU + beatTime(this.grid, ev.start + ev.dur) - beatTime(this.grid, ev.start), this.passEnd(p))
    if (!ev.drum && (endU - startU) / rate >= HOLD_MIN_SEC) {
      this.holds.set(note, { pass: p, i: ev.i, start: startU, end: endU, score: value, lane: ev.lane })
      s.held.set(ev.i, null)
      if (p === this.shownPass) st.held.set(ev.i, null)
    }
    let text = grade === 'perfect' ? 'Точно!' : best.d < 0 ? (grade === 'good' ? 'Хорошо · рано' : 'Рано') : grade === 'good' ? 'Хорошо · поздно' : 'Поздно'
    if (octaveShift) {
      s.stats.octave++
      text += ' · октава'
    }
    st.flashes.push({ lane: ev.lane, text, color: grade === 'perfect' ? '#5bd6a7' : grade === 'good' ? '#9be37a' : '#ffd36b', t: performance.now() })
    this.publish(octaveShift ? this.octaveHintFor(octaveShift) : this.snap.octaveHint ? { hint: null, octaveHint: null } : {})
  }

  /** A held long note was let go: grade how long it was held. */
  private release(note: number, tMs: number) {
    const h = this.holds.get(note)
    if (!h) return
    this.holds.delete(note)
    this.gradeHold(h, this.transport.heardUnrolledAt(tMs))
  }

  private gradeHold(h: Hold, releaseU: number) {
    const st = this.wf.current
    const rate = this.transport.rate
    const { grade, factor } = holdGrade(Math.max(0, releaseU - h.start) / rate, (h.end - h.start) / rate)
    const s = this.pass(h.pass)
    s.stats[grade]++
    s.stats.points += h.score * (factor - 1)
    this.run.score += h.score * 100 * (factor - 1)
    if (grade === 'held') this.run.score += 50 * multiplierOf(this.run.combo) // a sustain bonus
    const offset = this.looping() ? h.pass * this.passLen : 0
    const until = timeToBeat(this.grid, Math.min(releaseU, h.end) - offset)
    s.held.set(h.i, until)
    s.holdGrades.set(h.i, grade)
    if (h.pass === this.shownPass) {
      st.held.set(h.i, until)
      st.holdGrades.set(h.i, grade)
    }
    const text = grade === 'held' ? 'Выдержал ✓' : grade === 'short' ? 'Отпустил рано' : 'Держал дольше'
    st.flashes.push({ lane: h.lane, text, color: grade === 'held' ? '#5bd6a7' : '#ffd36b', t: performance.now() })
    this.publish()
  }

  /** Holds still down well past their end are graded 'long'. With `final` (a pause, the end
   * of a run) the keys still down count as held up to `u`, or to their end if that came first. */
  private settleHolds(u: number, final = false) {
    const rate = this.transport.rate
    for (const [note, h] of [...this.holds]) {
      const dur = (h.end - h.start) / rate
      const lateLimit = h.end + Math.max(0.25, 0.25 * dur) * rate
      if (final) {
        this.holds.delete(note)
        this.gradeHold(h, Math.min(u, h.end))
      } else if (u > lateLimit) {
        this.holds.delete(note)
        this.gradeHold(h, u)
      }
    }
  }

  private refreshUi() {
    const mode = this.snap.mode
    const beat = this.getNowCoarse()
    if (mode === 'play' && this.transport.playing) {
      const u = this.transport.heardUnrolledNow()
      const p = this.passOf(u)
      if (p !== this.shownPass) {
        this.showPass(p)
        this.publish()
      }
      this.sweepMisses(u)
      this.settleHolds(u)
      this.closePasses(u)
    }
    let expected: number[]
    if (mode === 'learn') expected = [...(this.wf.current.expected ?? [])]
    else {
      const set = new Set<number>()
      for (const e of this.track.events) {
        if (e.start > beat + 0.25) break
        if (e.start + Math.max(e.dur, 0.2) > beat - 0.02 && e.start <= beat + 0.25) set.add(e.lane)
      }
      expected = [...set]
    }
    const octaveNow = this.track.octave
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])
    expected.sort((a, b) => a - b)
    if (
      !same(expected, this.snap.expectedLanes) ||
      octaveNow !== this.snap.octaveNow ||
      Math.floor(beat) !== Math.floor(this.snap.beat) ||
      this.transport.playing !== this.snap.playing
    ) {
      this.update({ expectedLanes: expected, octaveNow, beat, playing: this.transport.playing })
    }
  }
}
