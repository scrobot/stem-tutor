import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ApiError, api, exportAudioUrl, mediaUrl } from '../api'
import { exercisePassBars, type ExerciseInfo } from '../builtin/lessons'
import { LEARN_ACCURACY, LEARN_TEMPO, addLearned, goodPass, readLearned, type LearnedMark } from '../cover/progress'
import { ChordReadout } from '../components/ChordReadout'
import { DeviceView, type PadLabel } from '../components/DeviceView'
import { RoleChip, downloadBlob, fmtBpm, plural, safeName } from '../components/common'
import { Waterfall, newWaterfallState, rangeLabel, type BeatRange } from '../components/Waterfall'
import type { InstrumentProfile } from '../instruments/profiles'
import { useLiveControls } from '../midi/live'
import { useMidi } from '../midi/midi'
import type { LayerKind, PadsArrangement } from '../music/arrange'
import { DRUM_COLOR, DRUM_LABEL, DRUM_LABEL_RU } from '../music/drums'
import { chordFlats, chordInfo } from '../music/explain'
import { exportPartMidi, exportStretchMidi } from '../music/exportMidi'
import { exportOrigin, inStretch } from '../music/grid'
import { buildLessonModel, buildPartModel, layerBlocks, type PartModel } from '../music/model'
import { noteName } from '../music/notes'
import { blockMarks, mainUnit, type PatternAnalysis } from '../music/patterns'
import { useLesson } from '../state/lesson'
import { useOctaveNames, useProfile, useSettings } from '../state/settings'
import { tutorTrack, type TutorTrack } from '../tutorial/events'
import { TutorSession, accuracyOf, type Mode, type SessionSnapshot, type SoundSettings } from '../tutorial/session'
import type { Lesson, Role } from '../types'

type LessonPatch = Parameters<typeof api.patchLesson>[1]

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'prepare', label: 'Подготовка', hint: 'какую октаву поставить и что учим' },
  { id: 'watch', label: '1 · Послушать', hint: 'ноты падают на клавиши — смотрите и слушайте' },
  { id: 'learn', label: '2 · Разучить', hint: 'без темпа: программа ждёт, пока вы нажмёте подсвеченные клавиши' },
  { id: 'play', label: '3 · Играть', hint: 'в темпе, с оценкой каждой ноты; по кругу темп растёт сам' },
  { id: 'daw', label: '4 · Записать в DAW', hint: 'MIDI куска, минусовка и как записать дорожку' },
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
  return `от нуля нажмите «${o > 0 ? 'OCT +' : 'OCT −'}» ${n} ${plural(n, 'раз', 'раза', 'раз')}`
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

function PreparePanel(props: {
  lesson: Lesson
  model: PartModel
  track: TutorTrack
  profile: InstrumentProfile
  stretch: string
  onPads?: (ov: Record<string, { bank: number; pad: number }>) => void
  builtin?: BuiltinInfo
}) {
  const { lesson, model, track, profile, stretch, builtin } = props
  const midi = useMidi()
  const port = midi.inputs.find((i) => i.id === midi.selectedId)
  const keys = track.lanes.kind === 'keys'
  const a = model.arrangement
  return (
    <div className="panel-body">
      {builtin && <div className="callout info">{builtin.exercise.exercise.goal}</div>}
      <ol className="steps">
        <li>
          <b>Клавиатура:</b> {profile.name} —{' '}
          {port ? <span className="ok-text">подключена ({port.name})</span> : <span className="warn-text">не подключена</span>}.{' '}
          <Link to="/instrument">Настроить</Link>
        </li>
        {keys ? (
          <li>
            <b>Октава: {octLabel(track.octave)}</b> — {pressesText(track.octave)}. Поставьте её перед стартом, во время игры кнопки OCT
            не трогайте.
            {track.folded > 0 && (
              <div className="small muted">
                {track.folded} {plural(track.folded, 'нота', 'ноты', 'нот')} этого куска не{' '}
                {plural(track.folded, 'помещается', 'помещаются', 'помещаются')} на {profile.keys.count} клавиш —{' '}
                {plural(track.folded, 'она сдвинута', 'они сдвинуты', 'они сдвинуты')} на октаву (пунктирная обводка).
              </div>
            )}
          </li>
        ) : (
          <li>
            <b>Пэды:</b> банк {profile.pads!.banks[0].id}. Раскладку можно поменять — изменения сохраняются в уроке.
            {props.onPads && <PadMapEditor lesson={lesson} model={model} profile={profile} onChange={props.onPads} />}
          </li>
        )}
        {keys && (
          <li>
            <b>Что играем: {track.layerLabel}.</b> {track.layerHint}
            {track.layerCount > 1 && (
              <>
                {' '}Партия разложена на {track.layerCount} {plural(track.layerCount, 'слой', 'слоя', 'слоёв')} для одной руки: учите и
                записывайте их по очереди, каждый на свою дорожку в DAW.
              </>
            )}
          </li>
        )}
        <li>
          <b>Кусок: {stretch}.</b> Другой — двойным щелчком по такту на ленте нот, протяжкой по нескольким тактам или блоком в «Из
          чего состоит дорожка».
        </li>
        <li>
          <b>Порядок:</b> Послушать → Разучить (без темпа) → Играть по кругу с 60–70% темпа до 100% → Записать в DAW.
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

function DawPanel({ lesson, model, track, profile, range, stretch }: { lesson: Lesson; model: PartModel; track: TutorTrack; profile: InstrumentProfile; range: BeatRange; stretch: string }) {
  const names = useOctaveNames()
  const part = model.part
  const grid = lesson.grid!
  const base = safeName(`${lesson.title} - ${part.name}`)
  const hasBacking = lesson.parts.some((p) => p.id !== part.id && p.media.stemWav)
  const a = model.arrangement
  const keys = track.lanes.kind === 'keys'
  const channel = keys ? (profile.keys.channel ?? 0) : (profile.pads?.channel ?? 9)
  const trackName = keys && track.layerCount > 1 ? `${part.name} · ${track.layerLabel}` : part.name
  // Bars as the DAW counts them: exported audio starts at the export origin, which can be a bar
  // or more before the app's bar 1.
  const dawStretch = rangeLabel({ ...grid, firstDownbeat: exportOrigin(grid).beat }, range)
  const hasAudio = hasBacking || !!lesson.media.mix
  return (
    <div className="panel-body">
      <ol className="steps">
        <li>
          В DAW поставьте темп <b>{fmtBpm(grid.bpm)}</b>, размер <b>{grid.timeSig[0]}/{grid.timeSig[1]}</b>.
        </li>
        <li>
          Скачайте файлы:
          <div className="row wrap">
            <button
              className="btn small primary"
              onClick={() =>
                downloadBlob(
                  exportStretchMidi(lesson, `${trackName} · ${stretch}`, track.events, range, channel),
                  `${safeName(`${base} - ${track.layerLabel} - ${stretch}`)}.mid`,
                  'audio/midi',
                )
              }
              title="Только этот кусок, с начала первого такта — готовая петля для DAW"
            >
              MIDI этого куска
            </button>
            <button
              className="btn small"
              onClick={() => downloadBlob(exportPartMidi(lesson, model, profile), `${base}.mid`, 'audio/midi')}
              title={a.kind === 'keys' && a.layers.length > 1 ? 'Вся партия, каждый слой — отдельной MIDI-дорожкой' : 'Вся партия целиком'}
            >
              MIDI всей партии{a.kind === 'keys' && a.layers.length > 1 ? ' (по слоям)' : ''}
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
          <div className="small muted">
            «MIDI всей партии» и аудио начинаются с такта 1 и совпадают с сеткой DAW. «MIDI этого куска» — только {stretch}: клип
            начинается с этого куска, в DAW его кладут на {dawStretch}.
          </div>
        </li>
        <li>
          Создайте MIDI-дорожку «{trackName}», инструмент: {DAW_INSTRUMENT[part.role]}.
          {a.kind === 'pads' && (
            <div className="small">
              Положите звуки в Drum Rack на ноты:{' '}
              {a.slots.map((s) => `${noteName(s.note, names)} — ${DRUM_LABEL[s.cls]}`).join(' · ')}.
            </div>
          )}
        </li>
        <li>
          На клавиатуре: {keys ? <b>{octLabel(track.octave)}</b> : <b>банк пэдов {profile.pads?.banks[0].id}</b>} — поставьте до записи.
        </li>
        {hasAudio && <li>Положите {hasBacking ? 'минусовку' : 'трек'} на аудиодорожку в самое начало (такт 1).</li>}
        <li>
          Включите в DAW цикл (Loop) на {dawStretch}
          {hasAudio ? ' — там этот кусок звучит в треке' : ''}, метроном и запись. Сыграйте несколько кругов и оставьте лучший.
        </li>
        {keys && track.layerCount > 1 && <li>Следующий слой записывайте на новую дорожку — в DAW слои зазвучат вместе.</li>}
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
        <div className="history" title="Точность последних кругов">
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

/** A built-in exercise: exact chord names, fingers, and where to go next. */
export interface BuiltinInfo {
  exercise: ExerciseInfo
  /** Step mode takes a chord only with all its keys held together. */
  chordsTogether: boolean
  next?: { to: string; label: string }
}

const noopSub = () => () => {}
const EMPTY: SessionSnapshot | null = null
const LAYER_KINDS: LayerKind[] = ['all', 'melody', 'chords', 'bass']

/** What a good pass in «Играть» covered (for the cover plan's «выучена»). */
export interface GoodPass {
  layer: string
  range: BeatRange
  accuracy: number
  tempo: number
}

/** Runs `fn` when `value` changes after the first render (not on mount). */
function useOnChange<T>(value: T, fn: () => void) {
  const prev = useRef(value)
  useEffect(() => {
    if (Object.is(prev.current, value)) return
    prev.current = value
    fn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
}

/**
 * Route /lesson/:id/part/:partId — a lesson from the library. The cover plan links here with
 * `?layer=<kind>&from=<beat>&to=<beat>&label=<A>&plan=1` to open one loop of one layer.
 */
export default function TutorialPage() {
  const { id, partId } = useParams()
  const [params] = useSearchParams()
  const { lesson, patch } = useLesson(id)
  const marks = useRef<LearnedMark[] | null>(null)
  if (!lesson) return <div className="page"><p className="muted">Загрузка…</p></div>
  const fromPlan = params.get('plan') === '1'
  const layer = params.get('layer')
  const from = Number(params.get('from'))
  const to = Number(params.get('to'))
  const label = (params.get('label') ?? '').slice(0, 8)
  const initial = {
    layer: LAYER_KINDS.includes(layer as LayerKind) ? (layer as LayerKind) : null,
    range: params.has('from') && params.has('to') && isFinite(from) && isFinite(to) && to - from >= 0.5 ? { start: from, end: to } : null,
    label: label || null,
  }
  // Good passes go straight to the server, one mark at a time (the server merges it, so two
  // trainer tabs cannot overwrite each other). Updating the lesson here would rebuild the
  // part and stop the practice.
  const onGoodPass = (p: GoodPass) => {
    if (!partId) return
    const round = (x: number, k: number) => Math.round(x * k) / k
    const mark: LearnedMark = {
      part: partId,
      layer: p.layer,
      start: round(p.range.start, 1000),
      end: round(p.range.end, 1000),
      acc: round(p.accuracy, 100),
      tempo: round(p.tempo, 100),
      at: Date.now(),
    }
    api.addLearnedMark(lesson.id, mark).then(
      (r) => {
        marks.current = readLearned(r.coverLearned)
      },
      (e) => {
        // An older server without the merge endpoint: merge here and write the whole list.
        if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) return console.warn('cover plan mark not saved', e)
        const next = addLearned(marks.current ?? readLearned(lesson.prefs.coverLearned), mark)
        marks.current = next
        void api.patchLesson(lesson.id, { prefs: { coverLearned: next } }).catch((err) => console.warn('cover plan mark not saved', err))
      },
    )
  }
  return (
    <TutorialView
      key={params.toString()}
      lesson={lesson}
      partId={partId}
      onPatch={patch}
      back={fromPlan ? { to: `/lesson/${lesson.id}/cover`, label: 'План кавера' } : { to: `/lesson/${lesson.id}`, label: lesson.title }}
      initial={initial}
      onGoodPass={onGoodPass}
      planNote={fromPlan}
    />
  )
}

export function TutorialView({
  lesson,
  partId,
  onPatch,
  back,
  builtin,
  initial,
  onGoodPass,
  planNote,
}: {
  lesson: Lesson
  partId: string | undefined
  onPatch?: (p: LessonPatch) => void | Promise<void>
  back: { to: string; label: string }
  builtin?: BuiltinInfo
  /** Open on this layer and stretch (links from the cover plan: also the loop's letter). */
  initial?: { layer: LayerKind | null; range: BeatRange | null; label?: string | null }
  /** Called after a pass in «Играть» good enough to call the stretch learnt. */
  onGoodPass?: (p: GoodPass) => void
  /** Say so when a good pass counts for the cover plan. */
  planNote?: boolean
}) {
  const { base, profile, calibration } = useProfile()
  const names = useOctaveNames()
  const monitorDefault = useSettings((s) => s.settings.ui.monitor ?? false)
  const patchUi = useSettings((s) => s.patchUi)
  const unitBarsPref = useSettings((s) => s.settings.ui.unitBars as number | undefined)
  // A built-in exercise is learnt as one written pass — the whole progression or line.
  const ex = builtin?.exercise.exercise
  const passBars = ex ? exercisePassBars(ex) : undefined
  const blockBars = passBars ?? unitBarsPref
  const inputOffsetMs = useSettings((s) => (s.settings.ui.inputOffsetMs as number | undefined) ?? 0)
  const togetherPref = useSettings((s) => (s.settings.ui.chordsTogether as boolean | undefined) ?? false)
  const part = lesson.parts.find((p) => p.id === partId)
  const grid = lesson.grid ?? null
  const [topAsMelody, setTopAsMelody] = useState(false)
  useEffect(() => setTopAsMelody(false), [part?.id])

  // The arrangement (and with it the practice session) does not depend on the block length:
  // changing it only re-splits the part into blocks.
  const baseModel = useMemo(
    () => (part && grid ? buildPartModel(lesson, part, base, calibration, { topAsMelody }) : null),
    [lesson, part, grid, base, calibration, topAsMelody],
  )
  const lessonModel = useMemo(() => (lesson.status === 'ready' && !builtin ? buildLessonModel(lesson) : null), [lesson, builtin])
  // The chosen layer is kept by kind: «верхние ноты аккордов — отдельно» adds or removes
  // «Мелодия» and shifts the other layers' indices.
  const [layerKind, setLayerKind] = useState<LayerKind | null>(initial?.layer ?? null)
  const keysArr = baseModel?.arrangement.kind === 'keys' ? baseModel.arrangement : null
  const layerIdx = Math.max(0, keysArr?.layers.findIndex((l) => l.kind === layerKind) ?? 0)
  const layer = keysArr?.layers[layerIdx] ?? null

  // Blocks of what is being learnt: the chosen layer (a melody repeats differently from its
  // chords). The cover plan lists the same blocks as its loops (layerBlocks).
  const patterns = useMemo<PatternAnalysis | null>(() => {
    if (!baseModel || !grid) return null
    return layerBlocks(baseModel, grid, layer ? layerIdx : null, blockBars)
  }, [baseModel, grid, layer, layerIdx, blockBars])

  const [mode, setMode] = useState<Mode>(builtin ? 'watch' : 'prepare')
  // A loop opened from the cover plan is one of these blocks (the same analysis): it opens as
  // that block, so its letter shows in «Из чего состоит дорожка»; otherwise as a picked stretch.
  const [opening] = useState(() => {
    const r = initial?.range
    const u = r && patterns ? patterns.units.find((x) => !x.empty && Math.abs(x.startBeat - r.start) < 1e-3 && Math.abs(x.endBeat - r.end) < 1e-3) : undefined
    return { unit: u ? u.index : null, custom: u ? null : r ?? null }
  })
  const [unit, setUnit] = useState<number | 'all' | null>(opening.unit)
  const [unitEnd, setUnitEnd] = useState<number | null>(null) // Shift+click: a run of blocks
  const [custom, setCustom] = useState<BeatRange | null>(opening.custom) // picked on the note view, or a plan's loop
  const [repeat, setRepeat] = useState(true)
  const [tempo, setTempo] = useState(builtin ? 0.8 : 0.75)
  const [zoom, setZoom] = useState(1)
  const hasStem = !!part?.media.stem
  const hasBacking = !!part?.media.backing
  const hasMix = !!lesson.media.mix
  const [watchPart, setWatchPart] = useState<SoundSettings['part'] | null>(null)
  const [playPart, setPlayPart] = useState<SoundSettings['part']>('off')
  const [backing, setBacking] = useState<boolean | null>(null)
  const [mixOn, setMixOn] = useState<boolean | null>(null)
  const [metronome, setMetronome] = useState(!!builtin)
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

  // Selection: a picked stretch, a block (or a run of blocks), or everything. By default the
  // main loop — the block that repeats most often.
  const units = patterns?.units ?? []
  const unitBars = patterns?.unitBars ?? 1
  // Block indices change with the block length, the part and the layer (not on opening: a
  // loop from the plan opens selected).
  useOnChange(`${unitBars}|${part?.id}|${layerIdx}`, () => {
    setUnit((u) => (u === 'all' ? u : null))
    setUnitEnd(null)
  })
  // Another part: its own layers and stretches (the ones it opened with stay on mount).
  useOnChange(part?.id, () => {
    setLayerKind(null)
    setCustom(null)
  })
  const main = patterns ? mainUnit(patterns) : null
  // The same blocks, marked on the note view: letters, where each starts, new or a repeat.
  const marks = useMemo(() => (patterns ? blockMarks(patterns) : []), [patterns])
  const unitSel = custom ? null : unit ?? main?.index ?? 'all'
  const selLo = typeof unitSel === 'number' ? Math.min(unitSel, unitEnd ?? unitSel) : null
  const selHi = typeof unitSel === 'number' ? Math.max(unitSel, unitEnd ?? unitSel) : null
  const blockRange = selLo !== null && selHi !== null && units[selLo] && units[selHi] ? { start: units[selLo].startBeat, end: units[selHi].endBeat } : null
  const rawRange = custom ?? blockRange
  const loopKey = rawRange ? `${rawRange.start}:${rawRange.end}` : 'all'
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loopRange = useMemo(() => rawRange, [loopKey])
  const whole = useMemo<BeatRange>(
    () => (units.length ? { start: units[0].startBeat, end: units[units.length - 1].endBeat } : { start: 0, end: 16 }),
    [units],
  )

  const fingers = builtin?.exercise.fingers
  const keyFlats = lessonModel?.key?.flats ?? false
  const flatsAt = useMemo(() => {
    const marks = builtin?.exercise.chords
    if (!marks) return () => keyFlats
    return (beat: number) => {
      const c = marks.find((m) => m.start <= beat + 1e-6 && m.end > beat)
      return c ? chordFlats(c.name) : false
    }
  }, [builtin, keyFlats])
  const track = useMemo(
    () => (baseModel ? tutorTrack(baseModel, layerIdx, profile, names, loopRange, { fingers, flatsAt }) : null),
    [baseModel, layerIdx, profile, names, loopRange, fingers, flatsAt],
  )

  const [session, setSession] = useState<TutorSession | null>(null)
  const trackRef = useRef(track)
  trackRef.current = track
  const soundRef = useRef(sound)
  soundRef.current = sound
  const tempoRef = useRef(tempo)
  tempoRef.current = tempo
  const hasTrack = !!track
  useEffect(() => {
    const t = trackRef.current
    if (!t || !grid || !part) return
    const offset = lesson.source.kind === 'midi' ? lesson.prefs.audioOffset ?? 0 : 0
    const s = new TutorSession(
      grid,
      t,
      part,
      profile,
      {
        stem: part.media.stem ? mediaUrl(lesson.id, part.media.stem) : undefined,
        backing: part.media.backing ? mediaUrl(lesson.id, part.media.backing) : undefined,
        mix: lesson.media.mix ? mediaUrl(lesson.id, lesson.media.mix) : undefined,
        offset,
      },
      soundRef.current,
      tempoRef.current,
    )
    setSession(s)
    return () => {
      s.dispose()
      setSession(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTrack, grid, part?.id, lesson.id, lesson.prefs.audioOffset, profile])

  // Another layer or stretch (maybe another OCT): same session, new track.
  useEffect(() => {
    if (session && track) session.setTrack(track)
  }, [session, track])
  useEffect(() => {
    if (!session) return
    session.setMode(mode)
    session.setLoop(loopRange)
  }, [session, mode, loopRange])
  useEffect(() => session?.setTempo(tempo), [session, tempo])
  useEffect(() => session?.setInputOffset(inputOffsetMs), [session, inputOffsetMs])
  const together = track?.lanes.kind === 'keys' && (builtin ? builtin.chordsTogether : togetherPref)
  useEffect(() => session?.setChordsTogether(together), [session, together])
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
  const octNow = snap?.octaveNow ?? track?.octave ?? 0
  const live = useLiveControls(profile, track?.lanes.kind === 'keys' ? octNow : undefined)

  // A new stretch that needs another OCT setting: say so for a few seconds.
  const [octNotice, setOctNotice] = useState<{ from: number; to: number } | null>(null)
  const prevOct = useRef<number | null>(null)
  const trackOct = track?.lanes.kind === 'keys' ? track.octave : null
  useEffect(() => {
    if (trackOct === null) return
    const before = prevOct.current
    prevOct.current = trackOct
    if (before === null || before === trackOct) return
    setOctNotice({ from: before, to: trackOct })
    const t = window.setTimeout(() => setOctNotice(null), 4000)
    return () => window.clearTimeout(t)
  }, [trackOct])

  // Space toggles playback.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      // A focused button would also "click" on key-up: let go of it so Space only plays/pauses.
      if (e.target instanceof HTMLButtonElement) e.target.blur()
      void session?.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])

  // A good pass in «Играть» counts for the cover plan — on the plan's own layers (not with
  // the top notes split off into a melody). The plan's loops are these very blocks
  // (layerBlocks), so the trainer can say which loops the pass ticks: those whose first time
  // it covered.
  const passes = snap?.history
  const lastPass = passes && passes.length ? passes[passes.length - 1] : null
  const seenPass = useRef<object | null>(null)
  const [planToast, setPlanToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!lastPass || lastPass === seenPass.current) return
    seenPass.current = lastPass
    if (!onGoodPass || mode !== 'play' || topAsMelody || !track || !patterns || !goodPass(lastPass)) return
    const r = loopRange ?? whole
    onGoodPass({ layer: track.layerKind, range: r, accuracy: lastPass.accuracy, tempo: lastPass.tempo })
    if (!planNote) return
    const ticked = patterns.patterns
      .filter((p) => {
        const u = patterns.units[p.units[0]]
        return u && r.start <= u.startBeat + 1e-3 && r.end >= u.endBeat - 1e-3
      })
      .map((p) => p.label)
    const linked = initial?.range && grid ? rangeLabel(grid, initial.range) : null
    setPlanToast(
      ticked.length
        ? `✓ Засчитано в плане кавера: ${ticked.length > 1 ? 'петли' : 'петля'} ${ticked.join(', ')}`
        : `Хороший проход! Чтобы петля засчиталась в плане, сыграйте её целиком${linked ? `: ${linked}` : ''}.`,
    )
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setPlanToast(null), 6000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPass])
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  if (!part || !grid || !baseModel || !track || !patterns) {
    return (
      <div className="page">
        <Link to={back.to} className="back">← {back.label}</Link>
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
  const beatNow = snap?.beat ?? 0
  const fingerOf = new Map<number, number>()
  if (fingers) {
    for (const e of track.events) {
      if (e.start > beatNow + 0.25) break
      if (e.finger && e.start + Math.max(e.dur, 0.2) > beatNow - 0.02) fingerOf.set(e.lane, e.finger)
    }
  }
  const keyLabels = new Map<number, string>()
  if (keysMode) {
    for (const l of expected) {
      const letter = noteName(profile.keys.lowNote + 12 * octNow + l, names, flatsAt(beatNow)).replace(/-?\d+$/, '')
      const f = fingerOf.get(l)
      keyLabels.set(l, f ? `${letter}·${f}` : letter)
    }
  }
  const chordMarks = builtin?.exercise.chords ?? lessonModel?.chords ?? []
  const chordNow = chordMarks.find((c) => c.start <= beatNow + 1e-6 && c.end > beatNow)
  const chordNowInfo = chordNow ? chordInfo(chordNow.name) : null
  const practice = mode === 'watch' || mode === 'learn' || mode === 'play'
  const nextNew = (() => {
    if (selHi === null) return null
    const seen = new Set(units.slice(0, selHi + 1).map((u) => u.patternId))
    return units.find((u) => u.index > selHi && !u.empty && !seen.has(u.patternId)) ?? null
  })()
  const setOffset = (ms: number) => patchUi({ inputOffsetMs: Math.max(-300, Math.min(500, Math.round(ms))) })
  const result = mode === 'play' && !snap?.playing ? snap?.result ?? null : null
  const stretch = loopRange ? rangeLabel(grid, loopRange) : 'вся партия'
  const pickRange = (r: BeatRange) => {
    const start = Math.max(whole.start, r.start)
    const end = Math.min(whole.end, r.end)
    if (end - start < 0.5) return
    setCustom({ start, end })
    setUnitEnd(null)
  }
  const pickBlock = (index: number, shift: boolean) => {
    if (shift && typeof unitSel === 'number') setUnitEnd(index)
    else {
      setUnit(index)
      setUnitEnd(null)
    }
    setCustom(null)
  }
  const exerciseChords = builtin?.exercise.exercise.steps ?? []
  const emptyStretch = loopRange
    ? !track.events.some((e) => inStretch(e.start, loopRange))
    : track.events.length === 0
  const canSplitTop = !!keysArr && !builtin && (topAsMelody || (keysArr.layers.some((l) => l.kind === 'chords') && !keysArr.layers.some((l) => l.kind === 'melody')))

  return (
    <div className="tutor">
      <div className="tutor-head">
        <Link to={back.to} className="back">← {back.label}</Link>
        <div className="row">
          <RoleChip role={part.role} />
          <h1 className="tutor-title">{part.name}</h1>
          <span className="muted">{fmtBpm(grid.bpm)}{lessonModel?.key ? ` · ${lessonModel.key.name}` : ''}</span>
        </div>
        {track.layerCount > 1 && keysArr && (
          <div className="layers">
            <span className="muted small">Что играем:</span>
            <div className="seg">
              {keysArr.layers.map((l, i) => (
                <button key={l.kind} className={i === track.layerIndex ? 'on' : ''} onClick={() => setLayerKind(l.kind)} title={l.hint}>
                  {l.label}
                </button>
              ))}
            </div>
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
              <span
                className={`oct-badge ${snap?.octaveHint ? 'blink' : ''}`}
                title={`Кнопки OCT на клавиатуре: ${pressesText(track.octave)}. Во время игры не переключайте.`}
              >
                {octLabel(octNow)}
              </span>
            ) : (
              <span className="oct-badge">Банк {profile.pads?.banks[bank]?.id}</span>
            )}
            <span className="stretch-chip" title="Что сейчас учим. Другой кусок — двойным щелчком по такту или протяжкой по ленте нот.">
              {keysMode && track.layerCount > 1 ? `${track.layerLabel} · ` : ''}
              {stretch}
            </span>
            {chordNow && (
              <span className="chord-now" title={chordNowInfo ? `${chordNowInfo.short}: ${chordNowInfo.mood}` : undefined}>
                {chordNow.name}
                {chordNowInfo && <small> {chordNowInfo.short}</small>}
              </span>
            )}
            {mode === 'learn' && snap && (
              <span className="muted">
                {keysMode ? 'Нажатие' : 'Удар'} {Math.min(snap.stepIndex + 1, snap.stepTotal)} из {snap.stepTotal} · кругов {snap.loopsDone}, без ошибок{' '}
                {snap.cleanLoops} · ошибок {snap.mistakes}
              </span>
            )}
            {mode === 'play' && snap && snap.stats.combo > 1 && (
              <span className="combo" title="Попаданий подряд">
                серия {snap.stats.combo}
              </span>
            )}
            {snap?.hint && <span className="hint">{snap.hint}</span>}
            {octNotice !== null && !snap?.hint && (
              <span className="hint">
                Здесь нужна {octLabel(octNotice.to)} (было {octLabel(octNotice.from)}) — нажмите «{octNotice.to > octNotice.from ? 'OCT +' : 'OCT −'}»{' '}
                {Math.abs(octNotice.to - octNotice.from)} {plural(Math.abs(octNotice.to - octNotice.from), 'раз', 'раза', 'раз')}.
              </span>
            )}
            {emptyStretch && <span className="hint">В этом куске у слоя «{track.layerLabel}» нет нот — выберите другой кусок.</span>}
            {planToast && <span className={`hint ${planToast.startsWith('✓') ? 'ok' : ''}`}>{planToast}</span>}
          </div>

          <div className="waterfall-wrap">
            <Waterfall
              lanes={track.lanes}
              events={track.events}
              grid={grid}
              getNow={session?.getNow ?? (() => 0)}
              state={session?.wf ?? { current: newWaterfallState() }}
              loop={loopRange}
              octave={track.octave}
              names={names}
              zoom={zoom}
              interactive={!snap?.playing}
              onSelect={pickRange}
              bounds={whole}
              resetKey={`${mode}:${loopKey}:${track.layerIndex}:${snap?.playing ? 1 : 0}:${snap?.stepIndex ?? 0}`}
              onZoom={(f) => setZoom((z) => Math.max(0.5, Math.min(2.5, Math.round(z * f * 10) / 10)))}
              blocks={marks}
            />
            {mode === 'prepare' && (
              <div className="overlay-tip">
                {keysMode ? 'Поставьте октаву и выберите кусок' : 'Проверьте пэды и выберите кусок'} — затем «Послушать».
              </div>
            )}
            {result && (
              <div className="result-card">
                <div className="result-acc">{Math.round(result.accuracy * 100)}%</div>
                <div className="result-line">
                  лучшая серия <b className="num">{result.maxCombo}</b> · темп {Math.round(result.tempo * 100)}%
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
                  {!repeat && (
                    <button className="btn" onClick={() => setRepeat(true)}>
                      По кругу
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="wf-hint">
            {snap?.playing
              ? 'Пробел — пауза; на паузе ленту можно листать и выбирать кусок.'
              : 'Буквы слева — петли: одинаковые буквы — одинаковая музыка · колёсико (или щелчок и ↑ ↓) — листать · двойной щелчок по такту или протяжка — выбрать кусок · Ctrl + колёсико — масштаб'}
          </div>

          <div className="transport">
            {(mode === 'watch' || mode === 'play') && (
              <button className="btn primary big" disabled={emptyStretch && !snap?.playing} onClick={() => void session?.toggle()}>
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
              <label className="field inline tempo" title="Скорость: 100% — как в оригинале">
                <span>Темп</span>
                <input type="range" min={0.25} max={1.25} step={0.05} value={tempo} onChange={(e) => setTempo(parseFloat(e.target.value))} />
                <b className="num">{Math.round(tempo * 100)}%</b>
              </label>
            )}
            {practice && (
              <div className="toggles">
                {mode !== 'play' && (
                  <label>
                    Звук партии
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
                  <label className="chk" title="Трек без этой партии">
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
                    <label className="chk" title="Щелчок на каждый счёт">
                      <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} /> метроном
                    </label>
                    <label className="chk" title="Один такт щелчков перед стартом, чтобы попасть в темп">
                      <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} /> отсчёт
                    </label>
                  </>
                )}
                {mode === 'play' && (
                  <label className="chk" title="Включено — кусок повторяется по кругу. Выключено — кусок играется один раз, потом итог.">
                    <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> по кругу
                  </label>
                )}
                {mode === 'play' && repeat && (
                  <label className="chk" title="После круга с точностью от 90% темп растёт на 5%">
                    <input type="checkbox" checked={autoTempo} onChange={(e) => setAutoTempo(e.target.checked)} /> авто-темп
                  </label>
                )}
                {mode === 'learn' && keysMode && !builtin && (
                  <label className="chk" title="Аккорд засчитывается, только когда все его клавиши зажаты одновременно">
                    <input type="checkbox" checked={togetherPref} onChange={(e) => patchUi({ chordsTogether: e.target.checked })} /> аккорд — всеми
                    клавишами вместе
                  </label>
                )}
                <label className="chk" title="Озвучивать ваши нажатия встроенным синтезатором (выключите, если звук идёт из DAW)">
                  <input type="checkbox" checked={monitor} onChange={(e) => patchUi({ monitor: e.target.checked })} /> звук моей игры
                </label>
              </div>
            )}
            <span className="spacer" />
            <label className="field inline zoom" title="Сколько тактов видно на ленте (Ctrl + колёсико над лентой)">
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

          {builtin && keysMode && (
            <section className="builtin-side">
              <ChordReadout profile={profile} />
              {exerciseChords.length > 0 && (
                <div className="chord-legend">
                  {[...new Map(exerciseChords.map((s) => [s.chord, s])).values()].map((s) => {
                    const info = chordInfo(s.chord)
                    return (
                      <span key={s.chord} className="chord-chip" title={info ? `${info.short}: ${info.mood}` : undefined}>
                        <b>{s.chord}</b> = {s.notes.map((n) => noteName(n, names, chordFlats(s.chord)).replace(/-?\d+$/, '')).join(' ')}
                      </span>
                    )
                  })}
                </div>
              )}
              {builtin.next && (
                <Link className="btn small" to={builtin.next.to}>
                  Дальше: {builtin.next.label} →
                </Link>
              )}
            </section>
          )}

          <div className="structure">
            <div className="row between">
              <b title="Дорожка разбита на куски. Одинаковые буквы — одинаковая музыка: выучив A один раз, вы сыграете все A. A′ — почти как A.">
                Из чего состоит дорожка
              </b>
              {!builtin && (
              <label className="muted small" title="Длина куска для заучивания. «Авто» — столько тактов, чтобы разных кусков было меньше всего.">
                длина куска{' '}
                <select value={unitBarsPref ?? 0} onChange={(e) => patchUi({ unitBars: Number(e.target.value) || undefined })}>
                  <option value={0}>авто{unitBarsPref ? '' : ` (${unitBars})`}</option>
                  {[1, 2, 4, 8, 16].map((n) => (
                    <option key={n} value={n}>
                      {n} {plural(n, 'такт', 'такта', 'тактов')}
                    </option>
                  ))}
                </select>
              </label>
              )}
            </div>
            <div className="units">
              <button
                className={`unit all ${unitSel === 'all' && !custom ? 'on' : ''}`}
                onClick={() => {
                  setUnit('all')
                  setUnitEnd(null)
                  setCustom(null)
                }}
                title="Вся партия целиком"
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
                    className={`unit ${selLo !== null && selHi !== null && u.index >= selLo && u.index <= selHi ? 'on' : ''} ${
                      custom && u.startBeat < custom.end && u.endBeat > custom.start ? 'part-on' : ''
                    } ${main?.index === u.index ? 'main' : ''}`}
                    style={{ ['--h' as string]: `${(u.patternId * 67) % 360}` }}
                    onClick={(e) => pickBlock(u.index, e.shiftKey)}
                    title={`такт ${u.startBar + 1}${u.bars > 1 ? `–${u.startBar + u.bars}` : ''}${main?.index === u.index ? ' · повторяется чаще всего — скорее всего, главный мотив' : ''} · Shift+щелчок — несколько кусков подряд`}
                  >
                    {u.label}
                    {main?.index === u.index && <i className="star">★</i>}
                  </button>
                ),
              )}
            </div>
            <div className="muted small">
              {custom ? (
                <>
                  {initial?.label && initial.range && Math.abs(custom.start - initial.range.start) < 1e-3 && Math.abs(custom.end - initial.range.end) < 1e-3
                    ? `Петля ${initial.label} из плана: ${stretch}`
                    : `Выделено на ленте нот: ${stretch}`}{' '}
                  ·{' '}
                  <button className="linklike" onClick={() => setCustom(null)}>
                    сбросить
                  </button>
                </>
              ) : (
                <>Учим: {stretch}. Одинаковые буквы — одинаковая музыка. На паузе ленту нот можно листать колёсиком и выделять такты мышью.</>
              )}
            </div>
            {nextNew && !custom && (
              <button className="btn small" onClick={() => pickBlock(nextNew.index, false)}>
                Следующий новый кусок: {nextNew.label} →
              </button>
            )}
            {canSplitTop && (
              <label className="chk small" title="Если мелодия звучит верхними нотами аккордов, вынесите её в отдельный слой «Мелодия»">
                <input type="checkbox" checked={topAsMelody} onChange={(e) => setTopAsMelody(e.target.checked)} /> верхние ноты аккордов —
                отдельно, как мелодия
              </label>
            )}
          </div>

          <section className="side-panel">
            {mode === 'prepare' && (
              <PreparePanel
                lesson={lesson}
                model={baseModel}
                track={track}
                profile={profile}
                stretch={stretch}
                builtin={builtin}
                onPads={onPatch ? (ov) => void onPatch({ prefs: { padOverrides: { ...(lesson.prefs.padOverrides ?? {}), [part.id]: ov } } }) : undefined}
              />
            )}
            {mode === 'daw' && <DawPanel lesson={lesson} model={baseModel} track={track} profile={profile} range={loopRange ?? whole} stretch={stretch} />}
            {mode === 'play' && snap && <StatsPanel snap={snap} offsetMs={inputOffsetMs} onOffset={setOffset} />}
            {mode === 'play' && planNote && (
              <div className="panel-body muted small">
                {topAsMelody ? (
                  <>
                    Пока включено «верхние ноты аккордов — отдельно», проходы в план кавера не засчитываются: в плане слои без этой галочки.
                    Выключите её, чтобы «выучена» ставилась сама.
                  </>
                ) : (
                  <>
                    Для плана кавера: сыграйте петлю целиком с точностью от {Math.round(LEARN_ACCURACY * 100)}% на темпе от{' '}
                    {Math.round(LEARN_TEMPO * 100)}% — галочка «выучена» в плане поставится сама. Авто-темп поднимает темп после кругов от
                    90%.
                  </>
                )}
              </div>
            )}
            {mode === 'watch' && (
              <div className="panel-body muted">
                Смотрите и слушайте: ноты падают на клавиши, которые нужно нажать. Длина полоски — сколько держать. Кусок повторяется по
                кругу. Пробел — старт и пауза.
              </div>
            )}
            {mode === 'learn' && (
              <div className="panel-body muted">
                Время стоит, пока вы не нажмёте подсвеченные {keysMode ? 'клавиши' : 'пэды'}.{' '}
                {together && keysMode ? 'Аккорд засчитывается, когда все его клавиши зажаты вместе.' : 'Аккорд можно брать по одной клавише.'}{' '}
                Ошиблись октавой — появится подсказка, какую кнопку OCT нажать.
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
