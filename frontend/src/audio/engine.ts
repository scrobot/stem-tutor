/**
 * Transport: one master clock on the AudioContext. Song time advances at `rate`
 * (tempo %). Synth notes are scheduled sample-accurately with a lookahead window;
 * <audio> elements (stems, backing, mix) follow the clock with drift correction and
 * `preservesPitch`, so slowing down never changes the pitch.
 *
 * The time line is a list of anchors (song time ↔ AudioContext time at a rate). A loop
 * seam is scheduled ahead as a new anchor at the exact moment the loop end is reached, so
 * a loop plays without a gap, and "heard" time — what the player hears, `latency` seconds
 * after scheduling — is mapped through the anchor that was in force at that moment.
 */

let ctx: AudioContext | null = null
let master: GainNode | null = null

export function audioCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' })
    master = ctx.createGain()
    master.gain.value = 0.9
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.ratio.value = 4
    master.connect(comp).connect(ctx.destination)
  }
  return ctx
}

export function masterOut(): GainNode {
  audioCtx()
  return master!
}

export async function resumeAudio(): Promise<void> {
  const c = audioCtx()
  if (c.state !== 'running') await c.resume()
}

/** Seconds between handing audio to the browser and it leaving the speakers (0 if unknown). */
export function outputLatency(): number {
  const c = audioCtx()
  return Math.max(0, (c.outputLatency || 0) + (c.baseLatency || 0))
}

export type ScheduleFn = (fromSong: number, toSong: number, transport: Transport) => void

export interface FollowedMedia {
  el: HTMLAudioElement
  offset: number // media time = song time + offset
}

interface Anchor {
  song: number
  ctx: number
  rate: number
  pass: number // loop passes before this piece of the time line
}

const LOOKAHEAD = 0.15 // seconds of real time scheduled ahead
const TICK_MS = 25

export class Transport {
  playing = false
  rate = 1
  loop: { start: number; end: number } | null = null
  /** Called when the player *hears* a loop seam (the start of the next pass). */
  onLoop: (() => void) | null = null
  onStop: (() => void) | null = null
  endTime = Infinity
  /** Real seconds between scheduling a sound and the player hearing it (output latency plus
   * the player's own correction; may be negative). Waterfall and scoring use heard time. */
  latency = 0

  private parked = 0 // song time while stopped
  private parkedPass = 0 // loop passes played before the pause (resume keeps counting)
  private anchors: Anchor[] = [{ song: 0, ctx: 0, rate: 1, pass: 0 }]
  private seams: number[] = [] // ctx times of loop seams the player has not heard yet
  private scheduled = 0
  private timer: number | null = null
  private sources = new Set<ScheduleFn>()
  private media = new Set<FollowedMedia>()
  private mediaAnchor: Anchor | null = null

  // -- time line -------------------------------------------------------------------------
  private anchorAt(ctxT: number): Anchor {
    const a = this.anchors
    for (let i = a.length - 1; i > 0; i--) if (a[i].ctx <= ctxT) return a[i]
    return a[0]
  }

  private songAt(ctxT: number): number {
    const a = this.anchorAt(ctxT)
    return a.song + (ctxT - a.ctx) * a.rate
  }

  private loopLen(): number {
    return this.loop ? this.loop.end - this.loop.start : 0
  }

  private ctxAtPerf(perfMs: number): number {
    return audioCtx().currentTime - (performance.now() - perfMs) / 1000
  }

  now(): number {
    return this.playing ? this.songAt(audioCtx().currentTime) : this.parked
  }

  /** AudioContext time at which a song time of the pass being scheduled sounds. */
  ctxTime(songTime: number): number {
    const a = this.anchors[this.anchors.length - 1]
    return a.ctx + (songTime - a.song) / a.rate
  }

  /** Song time corresponding to a performance.now() timestamp (e.g. a MIDI event). */
  songTimeAt(perfMs: number): number {
    return this.playing ? this.songAt(this.ctxAtPerf(perfMs)) : this.parked
  }

  /** Song time the player hears right now. */
  heardNow(): number {
    return this.playing ? this.songAt(audioCtx().currentTime - this.latency) : this.parked
  }

  /** Song time the player was hearing at a performance.now() timestamp. */
  heardSongTimeAt(perfMs: number): number {
    return this.playing ? this.songAt(this.ctxAtPerf(perfMs) - this.latency) : this.parked
  }

  /** Heard time on an unrolled time line: each loop pass adds the loop length. */
  heardUnrolledAt(perfMs: number): number {
    return this.unrolledAt(this.ctxAtPerf(perfMs) - this.latency)
  }

  heardUnrolledNow(): number {
    return this.unrolledAt(audioCtx().currentTime - this.latency)
  }

  private unrolledAt(ctxT: number): number {
    if (!this.playing) return this.parked + this.parkedPass * this.loopLen()
    const a = this.anchorAt(ctxT)
    return a.song + (ctxT - a.ctx) * a.rate + a.pass * this.loopLen()
  }

  // -- control ---------------------------------------------------------------------------
  addSource(fn: ScheduleFn): () => void {
    this.sources.add(fn)
    return () => this.sources.delete(fn)
  }

  follow(m: FollowedMedia): () => void {
    this.media.add(m)
    m.el.preservesPitch = true
    m.el.playbackRate = this.rate
    if (this.playing) this.syncMedia(m, true)
    return () => {
      m.el.pause()
      this.media.delete(m)
    }
  }

  /** Start from a song time, or resume from where it was paused. */
  play(from?: number): void {
    const c = audioCtx()
    const song = from ?? this.parked
    const pass = from === undefined ? this.parkedPass : 0
    this.anchors = [{ song, ctx: c.currentTime + 0.05, rate: this.rate, pass }]
    this.seams = []
    this.scheduled = song
    this.mediaAnchor = null
    this.playing = true
    for (const m of this.media) {
      m.el.playbackRate = this.rate
      this.syncMedia(m, true)
    }
    if (this.timer === null) this.timer = window.setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  pause(): void {
    if (!this.playing) return
    const t = audioCtx().currentTime
    this.parked = this.songAt(t)
    this.parkedPass = this.anchorAt(t).pass
    this.playing = false
    this.seams = []
    for (const m of this.media) m.el.pause()
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  seek(t: number): void {
    if (this.playing) this.play(t)
    else {
      this.parked = t
      this.parkedPass = 0
      for (const m of this.media) {
        const mt = t + m.offset
        if (mt >= 0 && isFinite(mt)) m.el.currentTime = mt
      }
    }
  }

  setRate(rate: number): void {
    if (this.playing) {
      const t = audioCtx().currentTime
      // Keep the past (heard time still maps through it), drop the part scheduled ahead at
      // the old rate, and continue from here at the new one.
      const droppedSeam = this.anchors.some((a, i) => i > 0 && a.ctx > t)
      this.anchors = this.anchors.filter((a, i) => i === 0 || a.ctx <= t)
      this.seams = this.seams.filter((s) => s <= t)
      const cur = this.anchorAt(t)
      const song = cur.song + (t - cur.ctx) * cur.rate
      this.anchors.push({ song, ctx: t, rate, pass: cur.pass })
      if (droppedSeam || this.scheduled < song) this.scheduled = song
    }
    this.rate = rate
    for (const m of this.media) m.el.playbackRate = rate
  }

  dispose(): void {
    this.pause()
    this.sources.clear()
    this.media.clear()
  }

  // -- internals -------------------------------------------------------------------------
  private syncMedia(m: FollowedMedia, force: boolean) {
    const want = this.now() + m.offset
    if (!this.playing) {
      m.el.pause()
      return
    }
    if (want < 0 || (isFinite(m.el.duration) && want >= m.el.duration)) {
      if (!m.el.paused) m.el.pause()
      return
    }
    if (force || m.el.paused || Math.abs(m.el.currentTime - want) > 0.06) {
      m.el.currentTime = want
    }
    if (m.el.paused) void m.el.play().catch(() => undefined)
  }

  private tick() {
    if (!this.playing) return
    const t = audioCtx().currentTime
    // The player hears a loop seam.
    while (this.seams.length && t - this.latency >= this.seams[0]) {
      this.seams.shift()
      this.onLoop?.()
      if (!this.playing) return
    }
    // Forget pieces of the time line nobody can hear any more.
    while (this.anchors.length > 1 && this.anchors[1].ctx < t - Math.abs(this.latency) - 1) this.anchors.shift()
    const now = this.songAt(t)
    if (!this.loop && now >= this.endTime) {
      this.pause()
      this.onStop?.()
      return
    }
    const cur = this.anchorAt(t)
    const jumped = cur !== this.mediaAnchor
    this.mediaAnchor = cur
    for (const m of this.media) this.syncMedia(m, jumped)
    // Schedule up to the lookahead horizon, crossing loop seams exactly.
    const horizon = t + LOOKAHEAD
    for (let guard = 0; guard < 64; guard++) {
      const a = this.anchors[this.anchors.length - 1]
      const toSong = a.song + (horizon - a.ctx) * a.rate
      const loop = this.loop
      if (loop && loop.end > loop.start && toSong >= loop.end && this.scheduled <= loop.end) {
        if (loop.end > this.scheduled) for (const fn of this.sources) fn(this.scheduled, loop.end, this)
        const seamCtx = a.ctx + (loop.end - a.song) / a.rate
        this.anchors.push({ song: loop.start, ctx: seamCtx, rate: a.rate, pass: a.pass + 1 })
        this.seams.push(seamCtx)
        this.scheduled = loop.start
        continue
      }
      if (toSong > this.scheduled) {
        for (const fn of this.sources) fn(this.scheduled, toSong, this)
        this.scheduled = toSong
      }
      break
    }
  }
}
