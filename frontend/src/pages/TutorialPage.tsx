import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link, useParams } from 'react-router-dom'
import { exportAudioUrl, mediaUrl } from '../api'
import { DeviceView, type PadLabel } from '../components/DeviceView'
import { RoleChip, downloadBlob, fmtBpm, safeName } from '../components/common'
import { Waterfall, newWaterfallState } from '../components/Waterfall'
import type { InstrumentProfile } from '../instruments/profiles'
import { useLiveControls } from '../midi/live'
import { useMidi } from '../midi/midi'
import type { PadsArrangement } from '../music/arrange'
import { DRUM_COLOR, DRUM_LABEL, DRUM_LABEL_RU } from '../music/drums'
import { exportPartMidi } from '../music/exportMidi'
import { buildLessonModel, buildPartModel, withUnitBars, type PartModel } from '../music/model'
import { noteName } from '../music/notes'
import { useLesson } from '../state/lesson'
import { useOctaveNames, useProfile, useSettings } from '../state/settings'
import { octaveAt, tutorTrack, type TutorTrack } from '../tutorial/events'
import { TutorSession, accuracyOf, multiplierOf, type Mode, type SessionSnapshot, type SoundSettings } from '../tutorial/session'
import type { Lesson, Role } from '../types'

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'prepare', label: '1 · Подготовка', hint: 'настройка контроллера и DAW' },
  { id: 'watch', label: '2 · Смотреть', hint: 'демонстрация' },
  { id: 'learn', label: '3 · Учить по шагам', hint: 'ждёт правильные ноты' },
  { id: 'play', label: '4 · Играть в темпе', hint: 'с оценкой' },
  { id: 'daw', label: '5 · Записать в DAW', hint: 'экспорт и гайд' },
]

const DAW_INSTRUMENT: Record<Role, string> = {
  drums: 'Drum Rack (Ableton) / FPC (FL Studio) / любой драм-сэмплер',
  bass: 'моно-синт с пилой и фильтром (Ableton: Operator или Analog → басовый пресет)',
  chords: 'клавишные или пэд (Ableton: Wavetable → Pad / Electric Piano)',
  melody: 'лид-синт (Ableton: Wavetable → Lead) или похожий тембр',
  vocal: 'лид-синт или вокальный сэмплер — сыграйте мелодию вокала',
  other: 'инструмент, похожий по звучанию на стем',
}

const octLabel = (o: number) => `OCT ${o > 0 ? '+' : o < 0 ? '−' : ''}${Math.abs(o)}`

function pressesText(o: number) {
  if (o === 0) return 'оставьте октаву по умолчанию (0)'
  const n = Math.abs(o)
  return `от нуля нажмите ${o > 0 ? 'OCT +' : 'OCT −'} ${n} раз${n >= 2 && n <= 4 ? 'а' : ''}`
}

function PadMapEditor({ lesson, model, profile, onChange }: { lesson: Lesson; model: PartModel; profile: InstrumentProfile; onChange: (ov: Record<string, { bank: number; pad: number }>) => void }) {
  const a = model.arrangement as PadsArrangement
  const pads = profile.pads!
  const options: { bank: number; pad: number; label: string }[] = []
  pads.banks.forEach((b, bi) => {
    for (let p = 0; p < pads.count; p++) options.push({ bank: bi, pad: p, label: `${b.id}${p + 1}` })
  })
  const names = useOctaveNames()
  const current = (lesson.prefs.padOverrides?.[model.part.id] ?? {}) as Record<string, { bank: number; pad: number }>
  const move = (cls: string, bank: number, pad: number) => {
    const next: Record<string, { bank: number; pad: number }> = {}
    for (const s of a.slots) next[s.cls] = current[s.cls] ?? { bank: s.bank, pad: s.pad }
    const occupant = a.slots.find((s) => (next[s.cls].bank === bank && next[s.cls].pad === pad))
    const old = next[cls]
    if (occupant && occupant.cls !== cls) next[occupant.cls] = old
    next[cls] = { bank, pad }
    onChange(next)
  }
  return (
    <table className="padmap">
      <thead>
        <tr>
          <th>Звук</th>
          <th>Ударов</th>
          <th>Пэд</th>
          <th>Нота (для Drum Rack)</th>
        </tr>
      </thead>
      <tbody>
        {a.slots.map((s) => (
          <tr key={s.cls}>
            <td>
              <span className="swatch" style={{ background: DRUM_COLOR[s.cls] }} />
              {DRUM_LABEL[s.cls]} <span className="muted">({DRUM_LABEL_RU[s.cls]})</span>
              {s.merged.length > 0 && <span className="muted"> + {s.merged.map((m) => DRUM_LABEL[m]).join(', ')}</span>}
            </td>
            <td>{s.count}</td>
            <td>
              <select value={`${s.bank}:${s.pad}`} onChange={(e) => {
                const [b, p] = e.target.value.split(':').map(Number)
                move(s.cls, b, p)
              }}>
                {options.map((o) => (
                  <option key={`${o.bank}:${o.pad}`} value={`${o.bank}:${o.pad}`}>
                    {o.label}
                  </option>
                ))}
              </select>
            </td>
            <td>
              {noteName(s.note, names)} <span className="muted">({s.note})</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PreparePanel(props: { lesson: Lesson; model: PartModel; track: TutorTrack; profile: InstrumentProfile; onPads: (ov: Record<string, { bank: number; pad: number }>) => void }) {
  const { lesson, model, track, profile } = props
  const midi = useMidi()
  const port = midi.inputs.find((i) => i.id === midi.selectedId)
  const keys = track.lanes.kind === 'keys'
  const a = model.arrangement
  const units = model.patterns
  return (
    <div className="panel-body">
      <ol className="steps">
        <li>
          <b>Контроллер:</b> {profile.name} —{' '}
          {port ? <span className="ok-text">подключён ({port.name})</span> : <span className="warn-text">не подключён</span>}.{' '}
          <Link to="/instrument">Настроить</Link>
        </li>
        {keys ? (
          <li>
            <b>Октава: {octLabel(track.startOctave)}</b> — {pressesText(track.startOctave)}.
            {track.changes.length > 0 && (
              <> По ходу партии октава меняется {track.changes.length} раз — заранее появится оранжевая линия и подсказка.</>
            )}
            {a.kind === 'keys' && a.passes.length > 1 && (
              <div className="callout info">
                Партия шире {profile.keys.count} клавиш, поэтому она разбита на {a.passes.length} прохода. Учите и записывайте их
                по очереди: в DAW второй проход пишется поверх первого (overdub).
              </div>
            )}
          </li>
        ) : (
          <li>
            <b>Пэды:</b> банк {profile.pads!.banks[0].id}. Раскладку можно поменять — изменения сохраняются в уроке.
            <PadMapEditor lesson={lesson} model={model} profile={profile} onChange={props.onPads} />
          </li>
        )}
        <li>
          <b>Что учим:</b> {units.patterns.length} уникальн{units.patterns.length === 1 ? 'ый паттерн' : 'ых паттерна(ов)'} по{' '}
          {units.unitBars} такт(а). Сначала каждый паттерн отдельно (выберите его на полосе структуры), потом весь трек.
        </li>
        <li>
          <b>Порядок:</b> Смотреть → Учить по шагам (без темпа) → Играть в темпе с 60–70% до 100% → Записать в DAW.
        </li>
      </ol>
      {a.warnings.map((w) => (
        <div key={w} className="callout warn small">
          {w}
        </div>
      ))}
    </div>
  )
}

function DawPanel({ lesson, model, track, profile }: { lesson: Lesson; model: PartModel; track: TutorTrack; profile: InstrumentProfile }) {
  const names = useOctaveNames()
  const part = model.part
  const grid = lesson.grid!
  const base = safeName(`${lesson.title} - ${part.name}`)
  const hasBacking = lesson.parts.some((p) => p.id !== part.id && p.media.stemWav)
  const a = model.arrangement
  return (
    <div className="panel-body">
      <ol className="steps">
        <li>
          В DAW поставьте темп <b>{fmtBpm(grid.bpm)}</b>, размер <b>{grid.timeSig[0]}/{grid.timeSig[1]}</b>.
        </li>
        <li>
          Скачайте файлы — все они начинаются с такта 1 и совпадают с сеткой DAW:
          <div className="row wrap">
            <button className="btn small" onClick={() => downloadBlob(exportPartMidi(lesson, model, profile), `${base}.mid`, 'audio/midi')}>
              MIDI-референс партии
            </button>
            {part.isDrum && (
              <button className="btn small ghost" onClick={() => downloadBlob(exportPartMidi(lesson, model, profile, 'gm'), `${base} (GM).mid`, 'audio/midi')}>
                MIDI с нотами GM
              </button>
            )}
            {hasBacking && (
              <a className="btn small" href={exportAudioUrl(lesson.id, 'backing', part.id)}>
                Минусовка WAV
              </a>
            )}
            {!hasBacking && lesson.media.mix && (
              <a className="btn small" href={exportAudioUrl(lesson.id, 'mix')}>
                Трек WAV
              </a>
            )}
            {part.media.stemWav && (
              <a className="btn small ghost" href={exportAudioUrl(lesson.id, 'stem', part.id)}>
                Оригинал партии WAV
              </a>
            )}
          </div>
        </li>
        <li>Перетащите минусовку на аудиодорожку в самое начало (такт 1).</li>
        <li>
          Создайте MIDI-дорожку «{part.name}», инструмент: {DAW_INSTRUMENT[part.role]}.
          {a.kind === 'pads' && (
            <div className="small">
              Положите звуки в Drum Rack на ноты:{' '}
              {a.slots.map((s) => `${noteName(s.note, names)} — ${DRUM_LABEL[s.cls]}`).join(' · ')}.
            </div>
          )}
        </li>
        <li>
          На контроллере:{' '}
          {track.lanes.kind === 'keys' ? <b>{octLabel(track.startOctave)}</b> : <b>банк пэдов {profile.pads?.banks[0].id}</b>}
          {track.changes.length > 0 && ', следите за сменами октавы'}.
        </li>
        <li>
          Включите запись и метроном DAW, сыграйте партию{track.passCount > 1 ? ' — каждый проход отдельным дублем поверх предыдущего' : ''}.
        </li>
        <li>Сравните результат: положите рядом скачанный MIDI-референс или оригинал партии.</li>
      </ol>
    </div>
  )
}

function StatsPanel({ snap, offsetMs, onOffset }: { snap: SessionSnapshot; offsetMs: number; onOffset: (ms: number) => void }) {
  const s = snap.stats
  const total = s.perfect + s.good + s.ok + s.miss
  const holds = s.held + s.short + s.long
  const mean = s.offsets.length ? (s.offsets.reduce((a, b) => a + b, 0) / s.offsets.length) * 1000 : 0
  return (
    <div className="panel-body">
      <div className="stat-row">
        <span className="stat perfect">{s.perfect}<small>точно</small></span>
        <span className="stat good">{s.good}<small>хорошо</small></span>
        <span className="stat okk">{s.ok}<small>около</small></span>
        <span className="stat miss">{s.miss}<small>мимо</small></span>
        <span className="stat extra">{s.extra}<small>лишних</small></span>
      </div>
      {holds > 0 && (
        <div className="muted small">
          Длинные ноты: выдержано {s.held} из {holds}
          {s.short > 0 && ` · отпущено рано ${s.short}`}
          {s.long > 0 && ` · держали дольше ${s.long}`}
        </div>
      )}
      {s.octave > 0 && <div className="muted small">Сыграно в другой октаве: {s.octave} — проверьте кнопки OCT.</div>}
      <div className="muted small">
        {total ? `Точность: ${Math.round(accuracyOf(s) * 100)}%` : 'Играйте вместе с падающими нотами: попадайте в начало ноты и держите длинные до конца.'}
        {s.offsets.length > 3 && ` · в среднем ${mean < 0 ? 'раньше' : 'позже'} на ${Math.abs(Math.round(mean))} мс`}
      </div>
      {snap.calibrateMs !== null && (
        <div className="callout small">
          Нажатия стабильно {snap.calibrateMs > 0 ? 'позже' : 'раньше'} нот на {Math.abs(snap.calibrateMs)} мс
          {snap.calibrateMs > 0 ? ' — похоже на задержку звука (Bluetooth-наушники, драйвер).' : ' — можно сдвинуть оценку под вашу игру.'}{' '}
          <button className="btn small" onClick={() => onOffset(offsetMs + (snap.calibrateMs ?? 0))}>
            Учесть
          </button>
        </div>
      )}
      <div className="row latency small muted" title="Задержка звука: сколько проходит от ноты в программе до звука в наушниках. Измеряется автоматически; поправка — если нажатия всё равно стабильно опаздывают или спешат.">
        <span>Задержка звука {snap.latencyMs} мс · поправка</span>
        <button className="btn small ghost" onClick={() => onOffset(offsetMs - 10)} aria-label="Меньше">−</button>
        <b className="num">{offsetMs > 0 ? '+' : ''}{offsetMs}</b>
        <button className="btn small ghost" onClick={() => onOffset(offsetMs + 10)} aria-label="Больше">+</button>
        {offsetMs !== 0 && (
          <button className="btn small ghost" onClick={() => onOffset(0)}>
            сброс
          </button>
        )}
      </div>
      {snap.history.length > 0 && (
        <div className="history">
          {snap.history.map((h, i) => (
            <span key={i} className={`hist ${h.accuracy >= 0.9 ? 'good' : h.accuracy >= 0.7 ? 'mid' : 'bad'}`} title={`темп ${Math.round(h.tempo * 100)}%`}>
              {Math.round(h.accuracy * 100)}%
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const noopSub = () => () => {}
const EMPTY: SessionSnapshot | null = null

export default function TutorialPage() {
  const { id, partId } = useParams()
  const { lesson, patch } = useLesson(id)
  const { base, profile, calibration } = useProfile()
  const names = useOctaveNames()
  const monitorDefault = useSettings((s) => s.settings.ui.monitor ?? false)
  const patchUi = useSettings((s) => s.patchUi)
  const unitBarsPref = useSettings((s) => s.settings.ui.unitBars as number | undefined)
  const inputOffsetMs = useSettings((s) => (s.settings.ui.inputOffsetMs as number | undefined) ?? 0)
  const [simplify, setSimplify] = useState(false)
  const part = lesson?.parts.find((p) => p.id === partId)
  const grid = lesson?.grid ?? null

  // The arrangement (and with it the practice session) does not depend on the block length:
  // changing 'блоки' only re-splits the part into blocks.
  const baseModel = useMemo(
    () => (lesson && part && grid ? buildPartModel(lesson, part, base, calibration, { simplify }) : null),
    [lesson, part, grid, base, calibration, simplify],
  )
  const model = useMemo(() => (baseModel && grid ? withUnitBars(baseModel, grid, unitBarsPref) : baseModel), [baseModel, grid, unitBarsPref])
  const lessonModel = useMemo(() => (lesson?.status === 'ready' ? buildLessonModel(lesson) : null), [lesson])
  const [passIdx, setPassIdx] = useState(0)
  const track = useMemo(() => (baseModel ? tutorTrack(baseModel, passIdx, profile, names) : null), [baseModel, passIdx, profile, names])

  const [mode, setMode] = useState<Mode>('prepare')
  const [unit, setUnit] = useState<number | 'all' | null>(null)
  const [unitEnd, setUnitEnd] = useState<number | null>(null) // Shift+click: a run of blocks
  const [repeat, setRepeat] = useState(false)
  const [tempo, setTempo] = useState(0.75)
  const [zoom, setZoom] = useState(1)
  const hasStem = !!part?.media.stem
  const hasBacking = !!part?.media.backing
  const hasMix = !!lesson?.media.mix
  const [watchPart, setWatchPart] = useState<SoundSettings['part'] | null>(null)
  const [playPart, setPlayPart] = useState<SoundSettings['part']>('off')
  const [backing, setBacking] = useState<boolean | null>(null)
  const [mixOn, setMixOn] = useState<boolean | null>(null)
  const [metronome, setMetronome] = useState(false)
  const [countIn, setCountIn] = useState(true)
  const [autoTempo, setAutoTempo] = useState(true)
  const monitor = monitorDefault
  const effWatchPart = watchPart ?? (hasStem ? 'stem' : 'synth')
  const effBacking = backing ?? hasBacking
  const effMix = mixOn ?? (!hasBacking && hasMix)
  const sound: SoundSettings = {
    part: mode === 'play' ? playPart : mode === 'learn' ? (effWatchPart === 'off' ? 'off' : 'synth') : effWatchPart,
    backing: effBacking,
    mix: effMix,
    metronome,
    countIn,
    monitor,
    autoTempo,
    repeat,
  }

  // Default loop: the first non-empty unit (first pattern to learn).
  const units = model?.patterns.units ?? []
  const unitBars = model?.patterns.unitBars ?? 1
  useEffect(() => {
    setUnit((u) => (u === 'all' ? u : null)) // block indices change with the block length
    setUnitEnd(null)
  }, [unitBars, part?.id])
  const firstUnit = units.find((u) => !u.empty)?.index ?? null
  const unitSel = unit ?? firstUnit ?? 'all'
  const selLo = unitSel === 'all' ? null : Math.min(unitSel, unitEnd ?? unitSel)
  const selHi = unitSel === 'all' ? null : Math.max(unitSel, unitEnd ?? unitSel)
  const loopRange =
    selLo === null || selHi === null || !units[selLo] || !units[selHi] ? null : { start: units[selLo].startBeat, end: units[selHi].endBeat }
  const playThrough = mode === 'play' && !repeat

  const [session, setSession] = useState<TutorSession | null>(null)
  useEffect(() => {
    if (!track || !grid || !part || !lesson) return
    const offset = lesson.source.kind === 'midi' ? lesson.prefs.audioOffset ?? 0 : 0
    const s = new TutorSession(
      grid,
      track,
      part,
      profile,
      {
        stem: part.media.stem ? mediaUrl(lesson.id, part.media.stem) : undefined,
        backing: part.media.backing ? mediaUrl(lesson.id, part.media.backing) : undefined,
        mix: lesson.media.mix ? mediaUrl(lesson.id, lesson.media.mix) : undefined,
        offset,
      },
      sound,
      tempo,
    )
    setSession(s)
    return () => {
      s.dispose()
      setSession(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, grid, part?.id, lesson?.id, lesson?.prefs.audioOffset, profile])

  useEffect(() => {
    if (!session) return
    session.setMode(mode)
    session.setLoop(loopRange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, mode, loopRange?.start, loopRange?.end])
  useEffect(() => session?.setTempo(tempo), [session, tempo])
  useEffect(() => session?.setInputOffset(inputOffsetMs), [session, inputOffsetMs])
  useEffect(() => {
    session?.setSound(sound)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sound.part, sound.backing, sound.mix, sound.metronome, sound.countIn, sound.monitor, sound.autoTempo, sound.repeat])
  useEffect(() => {
    if (!session) return
    return session.subscribe(() => {
      const t = session.getSnapshot().tempo
      if (Math.abs(t - tempo) > 1e-6) setTempo(t)
    })
  }, [session, tempo])

  const snap = useSyncExternalStore(session?.subscribe ?? noopSub, () => session?.getSnapshot() ?? EMPTY)
  const octNow = snap?.octaveNow ?? track?.startOctave ?? 0
  const live = useLiveControls(profile, track?.lanes.kind === 'keys' ? octNow : undefined)

  // Space toggles playback.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
        e.preventDefault()
        void session?.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])

  if (!lesson) return <div className="page"><p className="muted">Загрузка…</p></div>
  if (!part || !grid || !model || !track) {
    return (
      <div className="page">
        <Link to={`/lesson/${lesson.id}`} className="back">← К уроку</Link>
        <div className="callout warn">Партия не найдена или урок ещё обрабатывается.</div>
      </div>
    )
  }

  const keysMode = track.lanes.kind === 'keys'
  const expected = snap?.expectedLanes ?? []
  const expectKeys = new Map<number, string>()
  const expectPads = new Set<number>()
  let bank = 0
  const padLabels = new Map<number, PadLabel>()
  if (keysMode) for (const l of expected) expectKeys.set(l, 'var(--expect)')
  else {
    const slots = track.lanes.slots
    const firstExpected = expected.length ? slots[expected[0]] : slots[0]
    bank = firstExpected?.bank ?? 0
    for (const s of slots) if (s.bank === bank) padLabels.set(s.pad, { label: DRUM_LABEL[s.cls], color: DRUM_COLOR[s.cls] })
    for (const l of expected) if (slots[l]?.bank === bank) expectPads.add(slots[l].pad)
  }
  const keyLabels = new Map<number, string>()
  if (keysMode) {
    for (const l of expected) keyLabels.set(l, noteName(profile.keys.lowNote + 12 * octNow + l, names).replace(/-?\d+$/, ''))
  }
  const chordNow = lessonModel?.chords.find((c) => c.start <= (snap?.beat ?? 0) + 1e-6 && c.end > (snap?.beat ?? 0))
  const practice = mode === 'watch' || mode === 'learn' || mode === 'play'
  const nextNew = (() => {
    if (selHi === null) return null
    const seen = new Set(units.slice(0, selHi + 1).map((u) => u.patternId))
    return units.find((u) => u.index > selHi && !u.empty && !seen.has(u.patternId)) ?? null
  })()
  const setOffset = (ms: number) => patchUi({ inputOffsetMs: Math.max(-300, Math.min(500, Math.round(ms))) })
  const result = mode === 'play' && !snap?.playing ? snap?.result ?? null : null

  return (
    <div className="tutor">
      <div className="tutor-head">
        <Link to={`/lesson/${lesson.id}`} className="back">← {lesson.title}</Link>
        <div className="row">
          <RoleChip role={part.role} />
          <h1 className="tutor-title">{part.name}</h1>
          <span className="muted">{fmtBpm(grid.bpm)}{lessonModel?.key ? ` · ${lessonModel.key.name}` : ''}</span>
        </div>
        {track.passCount > 1 && (
          <div className="seg">
            {Array.from({ length: track.passCount }, (_, i) => (
              <button key={i} className={i === passIdx ? 'on' : ''} onClick={() => setPassIdx(i)}>
                Проход {i + 1}
              </button>
            ))}
          </div>
        )}
        <div className="mode-tabs">
          {MODES.map((m) => (
            <button key={m.id} className={m.id === mode ? 'on' : ''} onClick={() => setMode(m.id)} title={m.hint}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tutor-body">
        <div className="tutor-main">
          <div className="status-bar">
            {keysMode ? (
              <span className={`oct-badge ${snap?.octaveHint ? 'blink' : ''}`}>{octLabel(octNow)}</span>
            ) : (
              <span className="oct-badge">Банк {profile.pads?.banks[bank]?.id}</span>
            )}
            {chordNow && <span className="chord-now">{chordNow.name}</span>}
            {snap?.nextChange && (
              <span className="next-change">
                Через {Math.max(1, Math.ceil(snap.nextChange.inBeats))} д.: {octLabel(snap.nextChange.to)} ({snap.nextChange.to > snap.nextChange.from ? 'OCT +' : 'OCT −'} ×
                {Math.abs(snap.nextChange.to - snap.nextChange.from)})
              </span>
            )}
            {mode === 'learn' && snap && (
              <span className="muted">
                Шаг {Math.min(snap.stepIndex + 1, snap.stepTotal)} / {snap.stepTotal} · кругов {snap.loopsDone} (чистых {snap.cleanLoops}) · ошибок {snap.mistakes}
              </span>
            )}
            {mode === 'play' && snap && snap.stats.score > 0 && (
              <span className="combo" title="Очки × множитель за серию попаданий подряд">
                ×{multiplierOf(snap.stats.combo)} · серия {snap.stats.combo} · <b className="num">{Math.round(snap.stats.score)}</b>
              </span>
            )}
            {snap?.hint && <span className="hint">{snap.hint}</span>}
          </div>

          <div className="waterfall-wrap">
            <Waterfall
              lanes={track.lanes}
              events={track.events}
              grid={grid}
              getNow={session?.getNow ?? (() => 0)}
              state={session?.wf ?? { current: newWaterfallState() }}
              changes={track.changes}
              loop={playThrough ? (loopRange ? { start: loopRange.start, end: Infinity } : null) : loopRange}
              octaveAt={(b) => octaveAt(track, b)}
              names={names}
              zoom={zoom}
            />
            {mode === 'prepare' && (
              <div className="overlay-tip">Настройте контроллер справа, затем переходите к «Смотреть».</div>
            )}
            {result && (
              <div className="result-card">
                <div className="result-acc">{Math.round(result.accuracy * 100)}%</div>
                <div className="result-line">
                  Очки <b className="num">{result.score}</b> · лучшая серия <b className="num">{result.maxCombo}</b> · темп {Math.round(result.tempo * 100)}%
                </div>
                <div className="result-line muted">
                  точно {result.stats.perfect} · хорошо {result.stats.good} · около {result.stats.ok} · мимо {result.stats.miss} · лишних {result.stats.extra}
                  {result.stats.held + result.stats.short + result.stats.long > 0 &&
                    ` · длинных выдержано ${result.stats.held} из ${result.stats.held + result.stats.short + result.stats.long}`}
                </div>
                <div className="row">
                  <button className="btn primary" onClick={() => session?.restart()}>
                    ↺ Ещё раз
                  </button>
                  {result.accuracy >= 0.9 && tempo < 1 && (
                    <button className="btn" onClick={() => setTempo(Math.min(1, Math.round((tempo + 0.05) * 100) / 100))}>
                      Темп +5%
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="transport">
            {(mode === 'watch' || mode === 'play') && (
              <button className="btn primary big" onClick={() => void session?.toggle()}>
                {snap?.playing ? '❚❚ Пауза' : snap?.paused ? '▶ Продолжить' : '▶ Старт'}
              </button>
            )}
            {(mode === 'watch' || mode === 'play') && snap?.paused && (
              <button className="btn" onClick={() => session?.restart()}>
                ↺ С начала
              </button>
            )}
            {mode === 'learn' && (
              <button className="btn" onClick={() => session?.restart()}>
                ↺ С начала
              </button>
            )}
            {(mode === 'watch' || mode === 'play') && (
              <label className="field inline tempo">
                <span>Темп</span>
                <input type="range" min={0.25} max={1.25} step={0.05} value={tempo} onChange={(e) => setTempo(parseFloat(e.target.value))} />
                <b className="num">{Math.round(tempo * 100)}%</b>
              </label>
            )}
            {practice && (
              <div className="toggles">
                {mode !== 'play' && (
                  <label>
                    Партия
                    <select value={effWatchPart} onChange={(e) => setWatchPart(e.target.value as SoundSettings['part'])}>
                      {hasStem && mode !== 'learn' && <option value="stem">оригинал</option>}
                      <option value="synth">синтезатор</option>
                      <option value="off">выкл</option>
                    </select>
                  </label>
                )}
                {mode === 'play' && (
                  <label>
                    Подсказка
                    <select value={playPart} onChange={(e) => setPlayPart(e.target.value as SoundSettings['part'])}>
                      <option value="off">выкл (играю сам)</option>
                      <option value="synth">синтезатор</option>
                      {hasStem && <option value="stem">оригинал</option>}
                    </select>
                  </label>
                )}
                {mode !== 'learn' && hasBacking && (
                  <label className="chk">
                    <input type="checkbox" checked={effBacking} onChange={(e) => setBacking(e.target.checked)} /> минусовка
                  </label>
                )}
                {mode !== 'learn' && hasMix && (
                  <label className="chk">
                    <input type="checkbox" checked={effMix} onChange={(e) => setMixOn(e.target.checked)} /> весь трек
                  </label>
                )}
                {mode !== 'learn' && (
                  <>
                    <label className="chk">
                      <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} /> метроном
                    </label>
                    <label className="chk">
                      <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} /> отсчёт
                    </label>
                  </>
                )}
                {mode === 'play' && (
                  <label className="chk" title="Выключено — играем от выбранного блока до конца партии, как в Guitar Hero. Включено — выбранный отрезок повторяется по кругу.">
                    <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> повторять отрезок
                  </label>
                )}
                {mode === 'play' && repeat && (
                  <label className="chk" title="После круга с точностью ≥ 90% темп растёт на 5%">
                    <input type="checkbox" checked={autoTempo} onChange={(e) => setAutoTempo(e.target.checked)} /> авто-темп
                  </label>
                )}
                <label className="chk" title="Озвучивать ваши нажатия встроенным синтезатором (выключите, если звук идёт из DAW)">
                  <input type="checkbox" checked={monitor} onChange={(e) => patchUi({ monitor: e.target.checked })} /> звук моей игры
                </label>
              </div>
            )}
            <span className="spacer" />
            <label className="field inline zoom" title="Масштаб по времени">
              <span>Масштаб</span>
              <input type="range" min={0.5} max={2.5} step={0.1} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
            </label>
          </div>
        </div>

        <aside className="tutor-side">
          <DeviceView
            profile={profile}
            octave={keysMode ? octNow : 0}
            bank={bank}
            activeKeys={live.keys}
            activePads={live.pads}
            expectKeys={expectKeys}
            expectPads={expectPads}
            keyLabels={keyLabels}
            padLabels={padLabels.size ? padLabels : undefined}
            octaveHint={snap?.octaveHint ?? null}
            interactive
          />

          <div className="structure">
            <div className="row between">
              <b>Структура</b>
              <label className="muted small" title="Длина блока для заучивания. «Авто» — столько тактов, чтобы уникального материала было меньше всего.">
                блоки{' '}
                <select value={unitBarsPref ?? 0} onChange={(e) => patchUi({ unitBars: Number(e.target.value) || undefined })}>
                  <option value={0}>авто{unitBarsPref ? '' : ` (${unitBars})`}</option>
                  {[1, 2, 4, 8, 16].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'такт' : n < 5 ? 'такта' : 'тактов'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="units">
              <button
                className={`unit all ${unitSel === 'all' ? 'on' : ''}`}
                onClick={() => {
                  setUnit('all')
                  setUnitEnd(null)
                }}
              >
                Всё
              </button>
              {units.map((u) =>
                u.empty ? (
                  <span key={u.index} className="unit empty" title={`такт ${u.startBar + 1}: пауза`}>
                    ·
                  </span>
                ) : (
                  <button
                    key={u.index}
                    className={`unit ${selLo !== null && selHi !== null && u.index >= selLo && u.index <= selHi ? 'on' : ''}`}
                    style={{ ['--h' as string]: `${(u.patternId * 67) % 360}` }}
                    onClick={(e) => {
                      if (e.shiftKey && typeof unitSel === 'number') setUnitEnd(u.index)
                      else {
                        setUnit(u.index)
                        setUnitEnd(null)
                      }
                    }}
                    title={`такт ${u.startBar + 1}${u.bars > 1 ? `–${u.startBar + u.bars}` : ''} · Shift+щелчок — выделить несколько блоков`}
                  >
                    {u.label}
                  </button>
                ),
              )}
            </div>
            {selLo !== null && selHi !== null && units[selLo] && units[selHi] && (
              <div className="muted small">
                {playThrough
                  ? `Старт с такта ${units[selLo].startBar + 1}, дальше — до конца партии`
                  : units[selLo].startBar + 1 === units[selHi].startBar + units[selHi].bars
                    ? `Отрезок: такт ${units[selLo].startBar + 1}`
                    : `Отрезок: такты ${units[selLo].startBar + 1}–${units[selHi].startBar + units[selHi].bars}`}{' '}
                · Shift+щелчок — несколько блоков
              </div>
            )}
            {nextNew && (
              <button
                className="btn small"
                onClick={() => {
                  setUnit(nextNew.index)
                  setUnitEnd(null)
                }}
              >
                Следующий новый паттерн: {nextNew.label} →
              </button>
            )}
            {keysMode && (
              <label className="chk small">
                <input type="checkbox" checked={simplify} onChange={(e) => setSimplify(e.target.checked)} /> упрощённо (≤ 4 ноты в аккорде)
              </label>
            )}
          </div>

          <section className="side-panel">
            {mode === 'prepare' && (
              <PreparePanel
                lesson={lesson}
                model={model}
                track={track}
                profile={profile}
                onPads={(ov) => void patch({ prefs: { padOverrides: { ...(lesson.prefs.padOverrides ?? {}), [part.id]: ov } } })}
              />
            )}
            {mode === 'daw' && <DawPanel lesson={lesson} model={model} track={track} profile={profile} />}
            {mode === 'play' && snap && <StatsPanel snap={snap} offsetMs={inputOffsetMs} onOffset={setOffset} />}
            {mode === 'watch' && (
              <div className="panel-body muted">
                Смотрите и слушайте: ноты падают на клавиши, которые нужно нажать. Выберите блок на полосе структуры, чтобы зациклить его
                (Shift+щелчок — несколько блоков подряд; длину блока можно поменять). Пробел — старт/пауза.
              </div>
            )}
            {mode === 'learn' && (
              <div className="panel-body muted">
                Время стоит, пока вы не нажмёте подсвеченные {keysMode ? 'клавиши' : 'пэды'}. Аккорд можно брать по одной ноте. Ошибся октавой —
                появится подсказка, какую кнопку OCT нажать.
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
