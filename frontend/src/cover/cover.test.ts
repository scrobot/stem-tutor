import { describe, expect, it } from 'vitest'
import { profileById } from '../instruments/profiles'
import { exportCoverMidi } from '../music/exportMidi'
import { beatTime } from '../music/grid'
import { layerBlocks } from '../music/model'
import { analyzeBlocks, blockMarkText, blockMarks, mainUnit } from '../music/patterns'
import { blockMarkTitle, freeSpot, groupFlashes } from '../components/Waterfall'
import type { Grid, Lesson, Part, ProducerAnswer, Role } from '../types'
import { appBars, buildCoverPlan, dawBars, placement, type CoverPlan } from './plan'
import { applyProducer, audioWindow, buildDigest, fingerprint, loopAlias, playerLine, trackAlias } from './producer'
import {
  addLearned,
  goodPass,
  learnedFor,
  loopLearned,
  planProgress,
  readCoverPrefs,
  readLearned,
  setLearned,
  splitLoops,
  stepId,
  type CoverPrefs,
  type LearnedMark,
} from './progress'

const MPK = profileById('akai-mpk-mini-mk3')
const NO_PADS = profileById('generic-25')
const PLAYER = playerLine(MPK)
const EMPTY: CoverPrefs = { done: {}, include: {}, unticked: {} }

const grid = (offset = 0, firstDownbeat = 0): Grid => ({
  beats: Array.from({ length: 120 }, (_, i) => offset + i * 0.5),
  barLength: 4,
  timeSig: [4, 4],
  firstDownbeat,
  bpm: 120,
  origin: 'midi',
})

type N = [pitch: number, beat: number, dur: number]

const lessonOf = (g: Grid, parts: Part[], extra: Partial<Lesson> = {}): Lesson => ({
  id: 'test-song-abc123', title: 'Test Song', artist: 'Band', createdAt: '', updatedAt: '', source: { kind: 'midi', stemFiles: [] },
  status: 'ready', progress: 1, warnings: [], durationSec: 60, grid: g, media: {}, prefs: {}, parts, ...extra,
})

function partOf(g: Grid, id: string, role: Role, list: N[], more: Partial<Part> = {}): Part {
  return {
    id, name: id.toUpperCase(), role, isDrum: role === 'drums', origin: 'midi', media: {}, silent: false,
    notes: list.map(([p, b, d]) => ({ p, s: beatTime(g, b), e: beatTime(g, b + d), v: 100 })), ...more,
  }
}

function song(g: Grid = grid(), extra: Partial<Lesson> = {}): Lesson {
  const fd = g.firstDownbeat
  const at = (bar: number, beat: number) => fd + bar * 4 + beat
  const drums: N[] = []
  const bass: N[] = []
  const tune: N[] = []
  const piano: N[] = []
  const voice: N[] = []
  const roots = [33, 29, 36, 31]
  for (let bar = 0; bar < 16; bar++) {
    drums.push([36, at(bar, 0), 0.25], [36, at(bar, 2), 0.25], [38, at(bar, 1), 0.25], [38, at(bar, 3), 0.25])
    for (let h = 0; h < 8; h++) drums.push([42, at(bar, h / 2), 0.2])
    bass.push([roots[bar % 4], at(bar, 0), 1.5], [roots[bar % 4], at(bar, 2), 1.5])
    // A A B A: a 4-bar phrase (every bar different), twice, another one, the first again.
    const k = bar % 4
    const base = bar >= 8 && bar < 12 ? 67 : 60
    for (let b = 0; b < 4; b++) tune.push([base + k + [0, 2, 4, 5][b], at(bar, b), 1])
    // Two hands: bass notes, a chord with the tune on top.
    piano.push([36, at(bar, 0), 2], [43, at(bar, 2), 2])
    piano.push([60, at(bar, 0), 1], [64, at(bar, 0), 1], [72, at(bar, 0), 1], [74, at(bar, 1), 1])
    piano.push([60, at(bar, 2), 1], [65, at(bar, 2), 1], [76, at(bar, 2), 1], [74, at(bar, 3), 1])
  }
  for (let i = 0; i < 10; i++) voice.push([64 + (i % 3), at(4 + i, 0), 2])
  return lessonOf(g, [
    partOf(g, 'drm', 'drums', drums),
    partOf(g, 'bs', 'bass', bass),
    partOf(g, 'mel', 'melody', tune),
    partOf(g, 'pn', 'chords', piano),
    partOf(g, 'vx', 'vocal', voice),
  ], extra)
}

const planOf = (l: Lesson = song(), profile = MPK) => buildCoverPlan(l, profile, null)!
const ORDER: Record<Role, number> = { drums: 0, bass: 1, chords: 2, other: 3, melody: 4, vocal: 5 }

/** A melody of one 4-bar phrase (each bar different), 4 times, starting at bar index `from`. */
function lateMelody(from: number, pickup = false): Lesson {
  const g = grid()
  const tune: N[] = []
  for (let i = 0; i < 16; i++) {
    const bar = from + i
    const k = i % 4
    for (let b = 0; b < 4; b++) tune.push([60 + k + [0, 2, 4, 5][b], bar * 4 + b, 1])
  }
  if (pickup) tune.push([59, from * 4 - 1, 1]) // one note on beat 4 before the first bar
  const drums: N[] = []
  for (let bar = 0; bar < from + 16; bar++) drums.push([36, bar * 4, 0.25], [38, bar * 4 + 2, 0.25])
  return lessonOf(g, [partOf(g, 'drm', 'drums', drums), partOf(g, 'mel', 'melody', tune)])
}

describe('cover plan by rules', () => {
  it('one track per one-hand layer, recorded rhythm first and the voice last', () => {
    const plan = planOf()
    const ids = plan.tracks.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['drm:pads', 'bs:all', 'mel:all', 'pn:melody', 'pn:chords', 'pn:bass', 'vx:all']))
    const roles = plan.tracks.map((t) => ORDER[t.role])
    expect(roles).toEqual([...roles].sort((a, b) => a - b))
    expect(plan.tracks[0].device).toBe('pads')
    expect(plan.tracks.find((t) => t.id === 'pn:bass')!.name).toBe('PN · Бас')
    for (const id of [...ids, ...plan.tracks.flatMap((t) => t.loops.map((l) => l.id))]) expect(id).toMatch(/^[A-Za-z0-9:_.-]{1,80}$/)
  })

  it('leaves the voice and near-empty parts out, and says why — also a voice split into layers', () => {
    const plan = planOf()
    const vx = plan.tracks.find((t) => t.id === 'vx:all')!
    expect(vx.include).toBe(false)
    expect(vx.skipReason).toMatch(/Голос/)
    expect(plan.tracks.filter((t) => t.id !== 'vx:all').every((t) => t.include)).toBe(true)
    // A voice with a harmony under half of its notes is split for one hand: every layer stays a voice.
    const g = grid()
    const sung: N[] = []
    for (let i = 0; i < 24; i++) {
      sung.push([67 + (i % 3), i * 2, 1.5])
      if (i % 2 === 0) sung.push([64 + (i % 3), i * 2, 1.5])
    }
    const p2 = buildCoverPlan(lessonOf(g, [partOf(g, 'bs', 'bass', [[33, 0, 4], [33, 8, 4], [36, 16, 4], [31, 24, 4], [33, 32, 4], [29, 40, 4], [33, 48, 4], [31, 56, 4]]), partOf(g, 'vx', 'vocal', sung)]), MPK, null)!
    const voice = p2.tracks.filter((t) => t.partId === 'vx')
    expect(voice.length).toBeGreaterThan(1)
    for (const t of voice) {
      expect(t.role).toBe('vocal')
      expect(t.include).toBe(false)
    }
    expect(p2.tracks[p2.tracks.length - 1].partId).toBe('vx')
  })

  it('learns each loop once and says where its copies go, in DAW bars', () => {
    const plan = planOf()
    const mel = plan.tracks.find((t) => t.id === 'mel:all')!
    expect(mel.unitBars).toBe(4)
    expect(mel.loops.map((l) => [l.label, l.at])).toEqual([['A', [0, 4, 12]], ['B', [8]]])
    expect(plan.dawOffset).toBe(1)
    expect(dawBars(plan, 0, 4)).toBe('такты 1–4')
    expect(appBars(0, 4)).toBe('такты 1–4')
    expect(placement(plan, mel).map((p) => `${p.label}: ${p.text}`)).toEqual(['A: 1–8 (2 раза подряд), 13', 'B: 9'])
    const drums = plan.tracks[0]
    expect(drums.loops).toHaveLength(1)
    expect(placement(plan, drums)[0].text).toBe('1–16 (16 раз подряд)')
  })

  it('its loops are exactly the trainer’s blocks, also for a part that comes in late', () => {
    for (const from of [1, 2, 3]) {
      const lesson = lateMelody(from)
      const plan = planOf(lesson)
      const mel = plan.tracks.find((t) => t.id === 'mel:all')!
      const blocks = layerBlocks(plan.models.get('mel')!, lesson.grid!, mel.layerIndex)
      expect(mel.unitBars, `from ${from}`).toBe(4)
      expect(mel.loops.map((l) => [l.label, l.range.start, l.range.end])).toEqual(
        blocks.patterns.map((p) => [p.label, blocks.units[p.units[0]].startBeat, blocks.units[p.units[0]].endBeat]),
      )
      expect(mel.loops).toHaveLength(1)
      expect(mel.loops[0].at).toEqual([from, from + 4, from + 8, from + 12])
    }
  })

  it('a pickup note before the first bar is its own block and keeps the loops whole', () => {
    const lesson = lateMelody(1, true)
    const plan = planOf(lesson)
    const mel = plan.tracks.find((t) => t.id === 'mel:all')!
    expect(mel.unitBars).toBe(4)
    const main = mel.loops.find((l) => l.label === 'A')!
    expect(main.at).toEqual([1, 5, 9, 13])
    const lead = mel.loops.find((l) => l.label === 'B')!
    expect(lead.at).toEqual([0])
    expect(lead.bars).toBe(1)
    // and the plain analysis still wins when there is nothing to split off
    const blocks = analyzeBlocks([{ start: 0, target: 1 }, { start: 4, target: 1 }, { start: 8, target: 1 }], lesson.grid!, 0, 2)
    expect(blocks.patterns).toHaveLength(1)
    expect(blocks.leadIn).toBeUndefined()
  })

  it('marks every block on the note view: its letter, and new or the n-th time', () => {
    const plan = planOf()
    const lesson = song()
    const mel = plan.tracks.find((t) => t.id === 'mel:all')!
    const blocks = layerBlocks(plan.models.get('mel')!, lesson.grid!, mel.layerIndex)
    const marks = blockMarks(blocks)
    expect(marks.map((m) => `${m.label}${m.nth}/${m.total}`)).toEqual(['A1/3', 'A2/3', 'B1/1', 'A3/3'])
    expect(marks.map(blockMarkText)).toEqual(['A · новая', 'A · 2-й раз', 'B · новая', 'A · 3-й раз'])
    expect(blockMarkTitle(lesson.grid!, marks[1])).toBe('такты 5–8 — петля A, 2-й раз из 3. Одинаковые буквы — одинаковая музыка.')
    expect(blockMarkTitle(lesson.grid!, marks[2])).toMatch(/^такты 9–12 — петля B, звучит один раз\./)
    expect(blockMarkText({ label: 'A′', nth: 1, variantOf: 'A' })).toBe('A′ · почти как A')
  })

  it('puts a loop letter in the first free spot of its row, clear of the notes', () => {
    expect(freeSpot([], 30, 80, 900)).toBe(30)
    expect(freeSpot([[2, 58]], 30, 80, 900)).toBe(61) // a low note at the start: right after it
    expect(freeSpot([[200, 260], [2, 58], [62, 118]], 30, 70, 900)).toBe(121) // between notes
    expect(freeSpot([[200, 260], [2, 58], [62, 118]], 30, 80, 900)).toBe(263) // too narrow there: after the next
    expect(freeSpot([[2, 58], [62, 118], [122, 178]], 30, 40, 900)).toBe(181)
    expect(freeSpot([[0, 880]], 30, 80, 900)).toBeNull() // a full row
  })

  it('a chord’s grade words are drawn once, over the middle of its keys', () => {
    const at = (x: number, text: string, t: number) => ({ x, text, color: '#fff', t })
    const lines = (g: ReturnType<typeof groupFlashes>) => g.map((s) => `${s.x}: ${s.lines.map((l) => l.text).join(' / ')}`)
    // same word on a triad pressed within a few ms: once, in the middle
    expect(lines(groupFlashes([at(100, 'Точно!', 0), at(130, 'Точно!', 15), at(160, 'Точно!', 30)]))).toEqual(['130: Точно!'])
    // mixed words: one line each
    expect(lines(groupFlashes([at(100, 'Точно!', 0), at(130, 'Хорошо · поздно', 20), at(160, 'Точно!', 30)]))).toEqual([
      '130: Точно! / Хорошо · поздно',
    ])
    // fast notes one after another stay apart; one-glyph marks stay over their own keys
    expect(lines(groupFlashes([at(100, 'Точно!', 0), at(200, 'Точно!', 150), at(130, '×', 150), at(260, '×', 155)]))).toEqual([
      '100: Точно!',
      '200: Точно!',
      '130: ×',
      '260: ×',
    ])
  })

  it('a lead-in bar is never the main loop (★), even when nothing repeats', () => {
    const g = grid()
    const events = [{ start: 3, target: 99 }]
    for (let bar = 1; bar <= 8; bar++) for (let b = 0; b < 4; b++) events.push({ start: bar * 4 + b, target: bar * 10 + b })
    const blocks = analyzeBlocks(events, g, 0, 8)
    expect(blocks.unitBars).toBe(4)
    expect(blocks.leadIn).toBeDefined()
    expect(blocks.units.map((u) => u.label)).toEqual(['C', 'A', 'B'])
    expect(mainUnit(blocks)?.label).toBe('A')
  })

  it('every loop gets its own OCT setting and plays where the trainer plays it', () => {
    const plan = planOf()
    const bass = plan.tracks.find((t) => t.id === 'bs:all')!
    expect(bass.octave).toBeLessThan(0)
    for (const l of bass.loops) expect(l.octave).toBe(bass.octave)
    const a = bass.loops[0]
    expect(a.range).toEqual({ start: 0, end: 16 })
    expect(a.notes).toBe(8)
  })

  it('counts DAW bars from where the exported files start (the first downbeat after 0 s)', () => {
    const plan = planOf(song(grid(0.3, 1)))
    expect(plan.dawOffset).toBe(2)
    expect(dawBars(plan, 0, 1)).toBe('такт 2')
    expect(appBars(0, 1)).toBe('такт 1')
  })

  it('pads: which note each sound is on; drums on a keyboard without pads are played on the keys', () => {
    const plan = planOf()
    const drums = plan.tracks[0]
    expect(drums.padMap!.map((p) => p.label)).toEqual(['Kick', 'Snare', 'Hat'])
    expect(new Set(drums.padMap!.map((p) => p.note)).size).toBe(3)
    expect(drums.tip).toMatch(/Overdub/)
    expect(drums.tip).toMatch(/выключите/)
    const keys = planOf(song(), NO_PADS).tracks.find((t) => t.partId === 'drm')!
    expect(keys.device).toBe('keys')
    expect(keys.what).toMatch(/клавишах/)
    expect(keys.tip).toMatch(/Overdub/)
    expect(keys.padMap).toBeNull()
  })

  it('the slow-tempo tip names a real tempo', () => {
    const bass = planOf().tracks.find((t) => t.tip && !t.isDrum)
    expect(bass?.tip).toMatch(/96 BPM вместо 120 BPM/)
  })
})

describe('cover progress', () => {
  const mark = (over: Partial<LearnedMark>): LearnedMark => ({ part: 'bs', layer: 'all', start: 0, end: 16, acc: 0.9, tempo: 1, at: 1000, ...over })

  it('reads only what it understands from prefs', () => {
    expect(readCoverPrefs({ done: { a: true, b: 'x' }, include: [1], unticked: { c: 5, d: 'y' } })).toEqual({ done: { a: true }, include: {}, unticked: { c: 5 } })
    expect(readCoverPrefs(null)).toEqual(EMPTY)
    expect(readLearned([{ part: 'p', layer: 'all', start: 0, end: 4, acc: 0.9, tempo: 1 }, { part: 1 }, 'x'])).toEqual([
      { part: 'p', layer: 'all', start: 0, end: 4, acc: 0.9, tempo: 1, at: 0 },
    ])
  })

  it('a good pass at tempo counts; a longer stretch covers its loops; the best pass is kept', () => {
    expect(goodPass({ accuracy: 0.85, tempo: 0.9 })).toBe(true)
    expect(goodPass({ accuracy: 0.84, tempo: 1 })).toBe(false)
    expect(goodPass({ accuracy: 1, tempo: 0.85 })).toBe(false)
    let marks = addLearned([], mark({ end: 32, acc: 0.9, tempo: 0.9 }))
    marks = addLearned(marks, mark({ end: 32, acc: 0.88, tempo: 0.9, at: 2000 }))
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ acc: 0.9, at: 2000 }) // the best numbers, the last time played well
    const t = { partId: 'bs', layerKind: 'all' as const }
    expect(learnedFor(marks, t, { range: { start: 16, end: 32 } })).not.toBeNull()
    expect(learnedFor(marks, t, { range: { start: 16, end: 48 } })).toBeNull()
    expect(learnedFor(marks, { partId: 'bs', layerKind: 'chords' }, { range: { start: 0, end: 16 } })).toBeNull()
  })

  it('an untick on the plan holds until a good pass is played after it', () => {
    const t = { partId: 'bs', layerKind: 'all' as const }
    const loop = { id: 'bs:all.p0', range: { start: 0, end: 16 } }
    const early = [mark({ at: 1000 })]
    expect(loopLearned(EMPTY, early, t, loop).learned).toBe(true)
    const unticked = setLearned(EMPTY, loop, false, 5000)
    expect(loopLearned(unticked, early, t, loop)).toMatchObject({ learned: false })
    expect(loopLearned(unticked, [...early, mark({ start: 0, end: 32, at: 6000 })], t, loop).learned).toBe(true)
    const ticked = setLearned(unticked, loop, true, 7000)
    expect(ticked.unticked).toEqual({})
    expect(loopLearned(ticked, [], t, loop).learned).toBe(true)
    // a good pass after the untick counts even when it is no new best
    const best = addLearned([], mark({ acc: 0.97, at: 1000 }))
    const again = addLearned(best, mark({ acc: 0.88, tempo: 0.95, at: 6000 })) // after the untick at 5000
    expect(loopLearned(unticked, best, t, loop).learned).toBe(false)
    expect(loopLearned(unticked, again, t, loop)).toMatchObject({ learned: true, mark: { acc: 0.97 } })
  })

  it('ticks stay on their loop when «длина куска» changes (loops are named by where they first play)', () => {
    const lesson = song()
    const four = buildCoverPlan(lesson, MPK, null, { unitBars: 4 })!.tracks.find((t) => t.id === 'mel:all')!
    const two = buildCoverPlan(lesson, MPK, null, { unitBars: 2 })!.tracks.find((t) => t.id === 'mel:all')!
    expect(four.loops[0].id).toBe('mel:all.b0_16')
    expect(two.loops.map((l) => l.id)).not.toContain(four.loops[0].id)
    for (const l of two.loops) expect(l.range.end - l.range.start).toBe(8)
  })

  it('counts every loop of the tracks being recorded', () => {
    const plan = planOf()
    const tracks = plan.tracks.map((t) => ({ ...t }))
    const steps = (ts: typeof tracks) => ts.filter((t) => t.include).reduce((s, t) => s + 2 + 2 * t.loops.length, 2)
    expect(planProgress(tracks, EMPTY, [])).toEqual({ done: 0, total: steps(tracks) })
    const marks = [mark({ start: 0, end: 64, acc: 0.95 })]
    expect(planProgress(tracks, EMPTY, marks).done).toBe(1)
    tracks.forEach((t) => (t.include = t.id === 'bs:all'))
    expect(planProgress(tracks, { ...EMPTY, done: { [stepId.setup]: true } }, []).total).toBe(steps(tracks))
  })

  it('a card shows the most played loops first and keeps the rest in song order', () => {
    const loops = Array.from({ length: 11 }, (_, i) => ({ firstBar: i, at: i === 10 ? [10, 20, 30] : [i] }))
    const { main, rest } = splitLoops(loops)
    expect(main).toHaveLength(8)
    expect(main.some((l) => l.firstBar === 10)).toBe(true)
    expect(main.map((l) => l.firstBar)).toEqual([...main.map((l) => l.firstBar)].sort((a, b) => a - b))
    expect(rest.map((l) => l.firstBar)).toEqual([7, 8, 9])
  })
})

describe('AI producer harness', () => {
  it('sends aliases, a few notes per loop, and names only when allowed', () => {
    const lesson = song()
    const plan = planOf(lesson)
    const named = buildDigest(plan, lesson, { names: true, player: PLAYER })
    const plain = buildDigest(plan, lesson, { names: false, player: PLAYER })
    expect(named.trackIds).toEqual(plan.tracks.map((t) => trackAlias(t)))
    expect(new Set(named.loopIds).size).toBe(named.loopIds.length)
    const known = new Set(plan.tracks.flatMap((t) => t.loops.map((l) => loopAlias(t, l))))
    for (const id of named.loopIds) expect(known.has(id)).toBe(true)
    const songOf = (d: typeof named) => (d.digest as { song: Record<string, unknown> }).song
    expect(songOf(named).title).toBe('Test Song')
    expect(songOf(plain).title).toBeUndefined()
    expect(named.key).toBe(plain.key) // names are not music
    const text = JSON.stringify(plain.digest)
    for (const p of lesson.parts) expect(text).not.toContain(p.name)
    expect(text).not.toContain('Test Song')
    expect(JSON.stringify(named.digest)).toContain('"MIDI track \\"MEL\\""')
    const tracks = (named.digest as { tracks: { id: string; loops: { notes: string }[] }[] }).tracks
    expect(tracks.find((t) => t.id === 't2:all')!.loops[0].notes).toMatch(/^0:C3 1:D3 2:E3 3:F3 4:/)
    expect(tracks.find((t) => t.id === 't0:pads')!.loops[0].notes).toContain('Kick')
    expect((named.digest as { player: string }).player).toMatch(/25-key.*8 drum pads/)
    expect(playerLine(NO_PADS)).toMatch(/no drum pads/)
  })

  it('never lists more loop ids than the backend accepts', () => {
    // 13 different bars, then the same bars in another order: 13 one-bar loops per part.
    const g = grid()
    const order = [...Array.from({ length: 13 }, (_, i) => i), 0, 2, 4, 6, 8, 10, 12, 1, 3, 5, 7, 9, 11]
    const parts: Part[] = []
    for (let p = 0; p < 40; p++) {
      const notes: N[] = []
      order.forEach((k, bar) => notes.push([48 + ((k * 7 + p) % 24), bar * 4, 1], [50 + ((k * 5 + p) % 20), bar * 4 + 2, 1]))
      parts.push(partOf(g, `p${p}`, 'melody', notes))
    }
    const lesson = lessonOf(g, parts)
    const plan = planOf(lesson)
    const d = buildDigest(plan, lesson, { names: false, player: PLAYER })
    expect(plan.tracks.reduce((s, t) => s + Math.min(12, t.loops.length), 0)).toBeGreaterThan(400)
    expect(d.loopIds.length).toBeLessThanOrEqual(400)
    expect(d.trackIds.length).toBeLessThanOrEqual(40)
  })

  it('applies a producer answer: known ids only, its order and names, tips while the analysis is the same', () => {
    const lesson = song()
    const plan = planOf(lesson)
    const d = buildDigest(plan, lesson, { names: false, player: PLAYER })
    const melTrack = plan.tracks.find((t) => t.id === 'mel:all')!
    const melA = melTrack.loops[0]
    const vx = trackAlias(plan.tracks.find((t) => t.id === 'vx:all')!)
    const drm = trackAlias(plan.tracks.find((t) => t.id === 'drm:pads')!)
    const pnBass = trackAlias(plan.tracks.find((t) => t.id === 'pn:bass')!)
    const answer: ProducerAnswer = {
      model: 'vendor/model',
      createdAt: '2026-11-12T10:00:00+00:00',
      digestKey: d.key,
      audio: false,
      usage: { cost: 0.0012, promptTokens: 4000, completionTokens: 900 },
      result: {
        summary: 'Спокойный трек.',
        order: [vx, 'nope', drm, vx],
        tracks: [
          { id: vx, include: true, name: '  Голос   синтом ', what: 'Мелодия голоса.', instrument: 'Drift → Lead', sound: '', simplify: '' },
          { id: 'nope', include: true, name: 'x', what: '', instrument: '', sound: '', simplify: '' },
          { id: vx, include: false, name: 'второй раз', what: '', instrument: '', sound: '', simplify: '' },
          { id: pnBass, include: false, name: 'x'.repeat(100), what: '', instrument: '', sound: '', simplify: '' },
        ],
        loopTips: [{ id: loopAlias(melTrack, melA), tip: 'Последняя нота — длиннее.' }, { id: 'bad.p0', tip: 'x' }],
        tips: ['Сначала медленно.', '', 'Потом в темпе.'],
      },
    }
    const p = applyProducer(plan, answer, d.key)
    expect(p.tracks.map((t) => t.id).slice(0, 2)).toEqual(['vx:all', 'drm:pads'])
    expect(p.tracks).toHaveLength(plan.tracks.length)
    const voice = p.tracks[0]
    expect(voice.include).toBe(true)
    expect(voice.name).toBe('Голос синтом')
    expect(voice.ai?.instrument).toBe('Drift → Lead')
    expect(p.tracks.find((t) => t.id === 'pn:bass')!.include).toBe(false)
    expect(p.tracks.find((t) => t.id === 'pn:bass')!.name).toHaveLength(40)
    expect(p.tracks.find((t) => t.id === 'mel:all')!.tips[melA.id]).toBe('Последняя нота — длиннее.')
    expect(p.ai?.tips).toEqual(['Сначала медленно.', 'Потом в темпе.'])
    expect(p.ai?.stale).toBe(false)

    const stale = applyProducer(plan, answer, 'something-else')
    expect(stale.ai?.stale).toBe(true)
    expect(stale.tracks.find((t) => t.id === 'mel:all')!.tips).toEqual({})
    expect(stale.tracks[0].name).toBe('Голос синтом')
  })

  it('ignores a producer that would leave nothing to record, even naming only some tracks', () => {
    const lesson = song()
    const plan = planOf(lesson)
    const d = buildDigest(plan, lesson, { names: false, player: PLAYER })
    const off = (ids: string[]): ProducerAnswer => ({
      model: 'm', createdAt: '', digestKey: d.key, audio: false, usage: { cost: null, promptTokens: null, completionTokens: null },
      result: { summary: '', order: [], loopTips: [], tips: [], tracks: ids.map((id) => ({ id, include: false, name: '', what: '', instrument: '', sound: '', simplify: '' })) },
    })
    const all = applyProducer(plan, off(plan.tracks.map((t) => trackAlias(t))), d.key)
    expect(all.tracks.map((t) => t.include)).toEqual(plan.tracks.map((t) => t.include))
    // every track the rules record, named as excluded; the voice (already out) not named
    const some = applyProducer(plan, off(plan.tracks.filter((t) => t.include).map((t) => trackAlias(t))), d.key)
    expect(some.tracks.some((t) => t.include)).toBe(true)
  })

  it('lets the model listen where most tracks play, only when there is audio, never past the song', () => {
    const plan: CoverPlan = planOf()
    const fake = [{ include: true, blocks: [10, 11, 12, 13, 14, 15].map((b) => ({ startBar: b, bars: 1, label: 'A', loopId: 'x' })) }]
    expect(audioWindow(plan, song(), fake)).toBeNull()
    const w = audioWindow(plan, song(undefined, { media: { mix: 'media/mix.ogg' } }), fake)!
    expect(w).toMatchObject({ start: 2, duration: 30, bar: 1, bars: 15 })
    expect(w.bar + w.bars - 1).toBeLessThanOrEqual(plan.lastBar)
  })

  it('fingerprints are short and stable', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'))
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'))
    expect(fingerprint('')).toMatch(/^[0-9a-f]{8}$/)
  })
})

/** Name and note-on count of every track of a MIDI file (no running status: our writer never uses it). */
function midiTracks(bytes: Uint8Array): { name: string; ons: number }[] {
  const out: { name: string; ons: number }[] = []
  let i = 14
  while (i + 8 <= bytes.length) {
    const len = (bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7]
    let j = i + 8
    const end = j + len
    const t = { name: '', ons: 0 }
    const vlq = () => {
      let v = 0
      while (bytes[j] & 0x80) v = (v << 7) | (bytes[j++] & 0x7f)
      return (v << 7) | bytes[j++]
    }
    while (j < end) {
      vlq()
      const status = bytes[j++]
      if (status === 0xff) {
        const type = bytes[j++]
        const l = vlq()
        if (type === 0x03) t.name = new TextDecoder().decode(bytes.slice(j, j + l))
        j += l
      } else {
        if ((status & 0xf0) === 0x90) t.ons++
        j += 2
      }
    }
    out.push(t)
    i = end
  }
  return out
}

describe('reference MIDI of the plan', () => {
  it('one named track per plan track — also the ones not recorded by hand — with every note of its layer', () => {
    const lesson = song()
    const plan = planOf(lesson)
    const all = plan.tracks
    expect(all.some((t) => !t.include)).toBe(true)
    const bytes = exportCoverMidi(lesson, all.map((t) => ({ name: t.name, model: plan.models.get(t.partId)!, layerIndex: t.layerIndex })), MPK)
    const tracks = midiTracks(bytes).slice(1) // after the tempo track
    expect(tracks.map((t) => t.name)).toEqual(all.map((t) => t.name))
    all.forEach((t, k) => {
      const a = plan.models.get(t.partId)!.arrangement
      expect(tracks[k].ons, t.id).toBe(a.kind === 'pads' ? a.events.length : a.layers[t.layerIndex].notes.length)
    })
  })
})
