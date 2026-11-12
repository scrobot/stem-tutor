import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api, exportAudioUrl } from '../api'
import { Progress, RoleChip, downloadBlob, fmtBpm, plural, safeName } from '../components/common'
import { DIFFICULTY_LABEL, appBars, buildCoverPlan, dawBars, octLabel, placement, type CoverLoop, type CoverPlan } from '../cover/plan'
import { applyProducer, audioWindow, buildDigest, estimateCost, fmtUsd, playerLine, type Digest, type PlannedTrack } from '../cover/producer'
import {
  LEARN_ACCURACY,
  LEARN_TEMPO,
  loopLearned,
  planProgress,
  readCoverPrefs,
  readLearned,
  setLearned,
  splitLoops,
  stepId,
  type CoverPrefs,
  type LearnedMark,
} from '../cover/progress'
import type { InstrumentProfile } from '../instruments/profiles'
import { exportCoverMidi, exportStretchMidi } from '../music/exportMidi'
import { noteName, type OctaveNames } from '../music/notes'
import { useLesson } from '../state/lesson'
import { useOctaveNames, useProfile, useSettings } from '../state/settings'
import { tutorTrack } from '../tutorial/events'
import type { AiModel, AiStatus, Lesson, ProducerAnswer } from '../types'

/**
 * Producer requests still running, by lesson: a page that is left and opened again (to practise
 * while the model thinks) picks the answer up instead of offering a second paid request.
 */
const inFlight = new Map<string, Promise<ProducerAnswer>>()

const AUDIO_SECONDS = 30

function sourceText(t: PlannedTrack): string {
  const from = t.origin === 'transcribed' ? `из стема «${t.partName}»` : `из MIDI-дорожки «${t.partName}»`
  return t.layerCount > 1 ? `${from}, слой «${t.layerLabel}»` : from
}

/** «C1 — Kick · C#1 — Snare · D1 — Hat»: which note each drum sound is on. */
function padNotes(map: { note: number; label: string }[], names: OctaveNames): string {
  return map.map((p) => `${noteName(p.note, names)} — ${p.label}`).join(' · ')
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Ticks on the plan, saved into the lesson one request after another (no lost ticks). */
function useCoverPrefs(lesson: Lesson | null) {
  const [prefs, setPrefs] = useState<CoverPrefs>({ done: {}, include: {}, unticked: {} })
  const ref = useRef(prefs)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const lessonId = lesson?.id
  useEffect(() => {
    if (!lesson) return
    const p = readCoverPrefs(lesson.prefs.cover)
    ref.current = p
    setPrefs(p)
    // Only on another lesson: the page writes the ticks itself and keeps them in state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId])
  const change = useCallback(
    (fn: (p: CoverPrefs) => CoverPrefs) => {
      if (!lessonId) return
      const next = fn(ref.current)
      ref.current = next
      setPrefs(next)
      chain.current = chain.current
        .catch(() => undefined)
        .then(() => api.patchLesson(lessonId, { prefs: { cover: next } }))
        .catch((e) => console.warn('cover progress not saved', e))
    },
    [lessonId],
  )
  return { prefs, change }
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className={`chk step-chk ${checked ? 'done' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {children}
    </label>
  )
}

function SongMap({ plan, track }: { plan: CoverPlan; track: PlannedTrack }) {
  const hue = new Map(track.loops.map((l) => [l.id, (l.pattern * 67) % 360]))
  const first = track.blocks.findIndex((b) => b.label)
  const blocks = first > 0 ? track.blocks.slice(first) : track.blocks // leading rests say nothing
  const title = (startBar: number, bars: number) =>
    `${appBars(startBar, bars)}${plan.dawOffset !== 1 ? ` (в Ableton — ${dawBars(plan, startBar, bars).replace(/^такт[ы]? /, '')})` : ''}`
  return (
    <div className="song-map" title="Как петли идут по треку. Одинаковые буквы — одинаковая музыка.">
      {blocks.map((b) =>
        b.label ? (
          <span key={b.startBar} className="unit static" style={{ ['--h' as string]: `${hue.get(b.loopId ?? '') ?? 210}` }} title={title(b.startBar, b.bars)}>
            {b.label}
          </span>
        ) : (
          <span key={b.startBar} className="unit empty" title={`${title(b.startBar, b.bars)}: пауза`}>
            ·
          </span>
        ),
      )}
    </div>
  )
}

function TrackCard(props: {
  n: number
  lesson: Lesson
  plan: CoverPlan
  track: PlannedTrack
  include: boolean
  prefs: CoverPrefs
  marks: LearnedMark[]
  profile: InstrumentProfile
  onInclude: (v: boolean) => void
  onDone: (id: string, v: boolean) => void
  onLearned: (loop: CoverLoop, v: boolean) => void
}) {
  const { n, lesson, plan, track: t, include, prefs, marks, profile } = props
  const names = useOctaveNames()
  const keys = t.device === 'keys'
  const { main, rest } = splitLoops(t.loops)
  const places = placement(plan, t)
  const otherOct = keys && t.loops.some((l) => l.octave !== t.octave)
  const shifted = plan.dawOffset !== 1
  const learnLink = (l: CoverLoop) =>
    `/lesson/${lesson.id}/part/${encodeURIComponent(t.partId)}?layer=${t.layerKind}&from=${+l.range.start.toFixed(4)}&to=${+l.range.end.toFixed(4)}&label=${encodeURIComponent(l.label)}&plan=1`
  const loopMidi = (l: CoverLoop) => {
    const model = plan.models.get(t.partId)
    if (!model) return
    const tt = tutorTrack(model, t.layerIndex, profile, names, l.range)
    const channel = tt.lanes.kind === 'keys' ? (profile.keys.channel ?? 0) : (profile.pads?.channel ?? 9)
    downloadBlob(
      exportStretchMidi(lesson, `${t.name} · ${l.label}`, tt.events, l.range, channel),
      `${safeName(`${lesson.title} - ${t.name} - ${l.label}`)}.mid`,
      'audio/midi',
    )
  }
  const loopRow = (l: CoverLoop) => {
    const { learned, mark } = loopLearned(prefs, marks, t, l)
    return (
      <li key={l.id} className="loop-step">
        <div className="row between">
          <div>
            <b className="loop-label">Петля {l.label}</b> · {appBars(l.firstBar, l.bars)}
            {shifted && <span className="muted"> (в Ableton — {dawBars(plan, l.firstBar, l.bars).replace(/^такт[ы]? /, '')})</span>} · звучит{' '}
            {l.at.length} {plural(l.at.length, 'раз', 'раза', 'раз')} · {DIFFICULTY_LABEL[l.difficulty]}
            {keys && l.octave !== t.octave && <b> · {octLabel(l.octave)}</b>}
            {l.variantOf && <span className="muted"> · почти как {l.variantOf}</span>}
          </div>
          <Link className="btn small primary" to={learnLink(l)}>
            Учить →
          </Link>
        </div>
        {t.tips[l.id] && <div className="ai-tip">{t.tips[l.id]}</div>}
        <div className="row">
          <Check checked={learned} onChange={(v) => props.onLearned(l, v)}>
            выучена
            {mark && (
              <span className="muted small">
                {' '}
                ({Math.round(mark.acc * 100)}% на темпе {Math.round(mark.tempo * 100)}%)
              </span>
            )}
          </Check>
          <Check checked={!!prefs.done[stepId.record(l)]} onChange={(v) => props.onDone(stepId.record(l), v)}>
            записана в Ableton
          </Check>
          <button className="btn small ghost" onClick={() => loopMidi(l)} title="MIDI этой петли с начала такта — образец, чтобы сверить свою запись">
            MIDI-образец
          </button>
        </div>
      </li>
    )
  }
  return (
    <section className={`card cover-track ${include ? '' : 'off'}`} style={{ ['--c' as string]: `var(--${t.role})` }}>
      <div className="row between">
        <div className="row">
          <span className="step-no">{include ? n : '—'}</span>
          <RoleChip role={t.role} />
          <h3>{t.name}</h3>
          {t.ai && (
            <span className="ai-badge" title="Название и советы — от ИИ-продюсера">
              ИИ
            </span>
          )}
        </div>
        <label className="chk" title="Выключите, если эту дорожку оставите из оригинала или эталонного MIDI">
          <input type="checkbox" checked={include} onChange={(e) => props.onInclude(e.target.checked)} /> записываю сам
        </label>
      </div>
      <div className="muted small">
        {sourceText(t)} · {keys ? `клавиши, ${octLabel(t.octave)}` : 'пэды'} · {t.loops.length}{' '}
        {plural(t.loops.length, 'петля', 'петли', 'петель')} по {t.unitBars} {plural(t.unitBars, 'такту', 'такта', 'тактов')}
      </div>
      {!include ? (
        <>
          <p className="muted">{t.ai?.what || t.skipReason || 'Эту дорожку можно взять из оригинала или из эталонного MIDI.'}</p>
          {t.padMap && t.padMap.length > 0 && (
            <div className="pad-map small">
              Если берёте ударные из эталонного MIDI: там они на нотах пэдов — {padNotes(t.padMap, names)}. Разложите на его дорожке Drum
              Rack так же (или перетащите клип на свою дорожку ударных с таким набором).
            </div>
          )}
        </>
      ) : (
        <>
          <p className="cover-what">{t.ai?.what || t.what}</p>
          <div className="cover-facts">
            <div>
              <b>Звук:</b> {t.ai?.instrument || t.instrument}
              {t.ai?.sound && <span className="muted"> {t.ai.sound}</span>}
            </div>
            {t.ai?.simplify && (
              <div>
                <b>Если сложно:</b> {t.ai.simplify}
              </div>
            )}
            {t.tip && (
              <div>
                <b>Совет:</b> {t.tip}
              </div>
            )}
            <div>
              <b>На клавиатуре:</b>{' '}
              {keys
                ? `${octLabel(t.octave)} — поставьте до записи${otherOct ? '; у некоторых петель своя октава, она указана рядом' : ''}.`
                : `пэды, банк ${profile.pads?.banks[0]?.id ?? 'A'}.`}
            </div>
          </div>
          <SongMap plan={plan} track={t} />
          <ol className="cover-steps">
            <li>
              <Check checked={!!prefs.done[stepId.create(t)]} onChange={(v) => props.onDone(stepId.create(t), v)}>
                Создайте в Ableton MIDI-дорожку «{t.name}» и поставьте на неё звук.
              </Check>
              {t.padMap && t.padMap.length > 0 && (
                <div className="pad-map small">
                  Пэды шлют свои ноты, а у готового набора звуки разложены иначе. Перетащите звуки набора в ячейки Drum Rack на эти ноты:{' '}
                  {padNotes(t.padMap, names)}. Тогда ваша запись, MIDI-образец и ударные из эталона, сыгранные через этот Drum Rack, зазвучат
                  правильно.
                </div>
              )}
            </li>
            {main.map(loopRow)}
            {rest.length > 0 && (
              <li>
                <details className="more-loops">
                  <summary>
                    Ещё {rest.length} {plural(rest.length, 'петля', 'петли', 'петель')} — звучат реже
                  </summary>
                  <ol className="cover-steps">{rest.map(loopRow)}</ol>
                </details>
              </li>
            )}
            <li>
              <Check checked={!!prefs.done[stepId.place(t)]} onChange={(v) => props.onDone(stepId.place(t), v)}>
                Разложите клипы по треку (такты — как в Ableton):
              </Check>
              <div className="placement small">
                {places.map((p) => (
                  <div key={p.loopId}>
                    <b>{p.label}</b> → {p.count === 1 && !p.text.includes('–') && !p.text.includes(',') ? 'такт' : 'такты'} {p.text}
                  </div>
                ))}
              </div>
            </li>
          </ol>
        </>
      )}
    </section>
  )
}

function AiPanel(props: {
  status: AiStatus | null
  onStatus: (s: AiStatus) => void
  models: AiModel[] | null
  modelsError: string | null
  loadModels: () => void
  digest: Digest | null
  hasAudio: boolean
  audioBars: string | null
}) {
  const { status, models, digest } = props
  const patchUi = useSettings((s) => s.patchUi)
  const sendNames = useSettings((s) => (s.settings.ui.aiSendNames as boolean | undefined) ?? true)
  const sendAudio = useSettings((s) => (s.settings.ui.aiSendAudio as boolean | undefined) ?? false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const { loadModels } = props
  useEffect(() => {
    if (!models) loadModels()
  }, [models, loadModels])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const saveKey = () =>
    run(async () => {
      props.onStatus(await api.saveAi({ key: key.trim() }))
      setKey('')
      setCheck(null)
    })
  const removeKey = () =>
    run(async () => {
      props.onStatus(await api.saveAi({ key: null }))
      setCheck(null)
    })
  const checkKey = () =>
    run(async () => {
      const c = await api.checkAi()
      const left = c.limitRemaining !== null ? `, на ключе осталось $${c.limitRemaining.toFixed(2)}` : ''
      setCheck(`Ключ работает${left}.${c.isFreeTier ? ' Бесплатный тариф: подойдут только бесплатные модели.' : ''}`)
    })
  const chooseModel = (id: string) => run(async () => props.onStatus(await api.saveAi({ model: id || null })))
  const digestText = digest ? JSON.stringify(digest.digest, null, 1) : ''
  const digestChars = digest ? JSON.stringify(digest.digest).length : 0
  const q = filter.trim().toLowerCase()
  const shown = (models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.id === status?.model)
  const selected = models?.find((m) => m.id === status?.model) ?? null
  const unknownModel = !!status?.model && !!models && !selected
  return (
    <div className="ai-panel">
      <div className="ai-row">
        <b>1. Ключ OpenRouter</b>
        {status?.configured ? (
          <div className="row">
            <span className="ok-text">подключён: {status.keyHint}</span>
            <button className="btn small" disabled={busy} onClick={() => void checkKey()}>
              Проверить
            </button>
            <button className="btn small ghost" disabled={busy} onClick={() => void removeKey()}>
              Удалить ключ
            </button>
          </div>
        ) : (
          <div className="row">
            <input
              type="password"
              className="key-input"
              aria-label="Ключ OpenRouter"
              placeholder="sk-or-…"
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key.trim() && void saveKey()}
            />
            <button className="btn small primary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
              Сохранить ключ
            </button>
          </div>
        )}
        <div className="muted small">
          Ключ создаётся на{' '}
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
            openrouter.ai/keys
          </a>{' '}
          (нужен аккаунт и немного денег на счёте). Он хранится только на этом компьютере, в папке данных StemTutor, и уходит только в
          OpenRouter.
        </div>
        {check && <div className="ok-text small">{check}</div>}
      </div>

      <div className="ai-row">
        <b>2. Модель</b>
        {props.modelsError ? (
          <div className="error-text">
            Список моделей не загрузился: {props.modelsError}{' '}
            <button className="linklike" onClick={props.loadModels}>
              ещё раз
            </button>
          </div>
        ) : !models ? (
          <div className="muted small">Загружаю список моделей…</div>
        ) : (
          <>
            <div className="row">
              <input
                className="model-filter"
                aria-label="Поиск модели"
                placeholder="поиск: gemini, gpt, claude…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <select className="model-select" aria-label="Модель" value={status?.model ?? ''} disabled={busy} onChange={(e) => void chooseModel(e.target.value)}>
                <option value="">— выберите модель —</option>
                {unknownModel && <option value={status!.model!}>{status!.model} (нет в списке)</option>}
                {shown.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.audioInput ? ' 🎧' : ''} · {fmtUsd(estimateCost(m, digestChars, sendAudio && m.audioInput ? AUDIO_SECONDS : 0))}
                  </option>
                ))}
              </select>
            </div>
            <div className="muted small">
              В списке только модели, которые умеют отвечать по схеме ({models.length}). 🎧 — умеет слушать звук. Цена — примерно за один
              план; быстрые и недорогие модели обычно с «flash», «mini» или «haiku» в названии.
            </div>
            {unknownModel && <div className="warn-text small">Выбранной модели нет в списке — она может не ответить по схеме. Выберите другую.</div>}
          </>
        )}
      </div>

      <div className="ai-row">
        <b>3. Что отправлять</b>
        <label className="chk">
          <input type="checkbox" checked={sendNames} onChange={(e) => patchUi({ aiSendNames: e.target.checked })} /> название трека, исполнитель и
          имена дорожек — модель может узнать песню и точнее подсказать звуки
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={sendAudio && props.hasAudio}
            disabled={!props.hasAudio}
            onChange={(e) => patchUi({ aiSendAudio: e.target.checked })}
          />{' '}
          дать послушать до {AUDIO_SECONDS} секунд трека{props.audioBars ? ` (${props.audioBars})` : ''} — точнее про звуки, но дороже
        </label>
        {!props.hasAudio && <div className="muted small">У этого урока нет звука — уйдут только ноты.</div>}
        {props.hasAudio && sendAudio && selected && !selected.audioInput && (
          <div className="warn-text small">Эта модель не слушает звук — уйдут только ноты. Для звука выберите модель с 🎧.</div>
        )}
        {digest && (
          <details className="digest">
            <summary>Что уйдёт в нейросеть</summary>
            <pre>{digestText}</pre>
            {sendAudio && props.hasAudio && selected?.audioInput && (
              <div className="muted small">И отрывок звука: {props.audioBars}, моно.</div>
            )}
          </details>
        )}
        <div className="muted small">Запрос уходит в OpenRouter и выбранную модель и оплачивается с вашего счёта OpenRouter.</div>
      </div>
      {error && <div className="callout danger small">{error}</div>}
    </div>
  )
}

/** Route /lesson/:id/cover — rebuild the track in a DAW by hand, step by step. */
export default function CoverPage() {
  const { id } = useParams()
  const { lesson, error } = useLesson(id)
  const { base, profile, calibration } = useProfile()
  const unitBars = useSettings((s) => s.settings.ui.unitBars as number | undefined)
  const plan = useMemo(() => (lesson ? buildCoverPlan(lesson, base, calibration, { unitBars }) : null), [lesson, base, calibration, unitBars])
  const { prefs, change } = useCoverPrefs(lesson)
  const marks = useMemo(() => readLearned(lesson?.prefs.coverLearned), [lesson])
  const sendNames = useSettings((s) => (s.settings.ui.aiSendNames as boolean | undefined) ?? true)
  const sendAudio = useSettings((s) => (s.settings.ui.aiSendAudio as boolean | undefined) ?? false)

  const [answer, setAnswer] = useState<ProducerAnswer | null>(null)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [aiMissing, setAiMissing] = useState(false)
  const [panel, setPanel] = useState(false)
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [models, setModels] = useState<AiModel[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Wait for a request this page (or an earlier visit of it) started.
  const shown = useRef<string | null>(null)
  shown.current = answer?.createdAt ?? null
  // The server is still answering a request this page cannot follow (another tab, or this page
  // before a reload): look for the new answer every few seconds, for a few minutes.
  const waitForAnswer = useCallback((lessonId: string, since: string | null) => {
    setAsking(true)
    setAskError(null)
    let tries = 0
    const later = () => {
      if (!mounted.current) return
      if (++tries > 48) {
        setAsking(false)
        setAskError('Ответ нейросети так и не появился — обновите страницу через пару минут.')
        return
      }
      window.setTimeout(look, 5000)
    }
    const look = () => {
      if (!mounted.current) return
      api.producer(lessonId).then((a) => {
        if (!mounted.current) return
        if (a.createdAt === since) return later()
        setAnswer(a)
        setPanel(false)
        setAsking(false)
      }, later)
    }
    later()
  }, [])
  // Wait for a request this page (or an earlier visit of it) started.
  const follow = useCallback(
    (lessonId: string, p: Promise<ProducerAnswer>) => {
      setAsking(true)
      setAskError(null)
      const done = () => {
        if (inFlight.get(lessonId) === p) inFlight.delete(lessonId)
      }
      p.then(
        (a) => {
          done()
          if (!mounted.current) return
          setAnswer(a)
          setPanel(false)
          setAsking(false)
        },
        (e) => {
          done()
          if (!mounted.current) return
          if (e instanceof ApiError && e.status === 409) return waitForAnswer(lessonId, shown.current)
          setAskError((e as Error).message)
          setAsking(false)
        },
      )
    },
    [waitForAnswer],
  )
  useEffect(() => {
    if (!id) return
    // The saved answer stays on screen while a new one is on its way (and if that one fails).
    api.producer(id).then((a) => mounted.current && setAnswer((cur) => cur ?? a), () => undefined)
    const running = inFlight.get(id)
    if (running) follow(id, running)
    api.ai().then(
      (s) => mounted.current && setStatus(s),
      (e) => {
        if (e instanceof ApiError && e.status === 404 && mounted.current) setAiMissing(true)
      },
    )
  }, [id, follow])
  const loadModels = useCallback(() => {
    setModelsError(null)
    api.aiModels().then(
      (r) => mounted.current && setModels(r.models),
      (e) => mounted.current && setModelsError((e as Error).message),
    )
  }, [])
  // Prices on the ask button need the model list.
  const configured = !!status?.configured
  useEffect(() => {
    if (configured && !models) loadModels()
  }, [configured, models, loadModels])

  const digest = useMemo(
    () => (plan && lesson ? buildDigest(plan, lesson, { names: sendNames, player: playerLine(profile) }) : null),
    [plan, lesson, sendNames, profile],
  )
  const produced = useMemo(() => (plan && digest ? applyProducer(plan, answer, digest.key) : null), [plan, answer, digest])

  if (error) return <div className="page"><div className="callout danger">{error}</div></div>
  if (!lesson) return <div className="page"><p className="muted">Загрузка…</p></div>
  if (!plan || !produced || !digest || !lesson.grid) {
    return (
      <div className="page">
        <Link to={`/lesson/${lesson.id}`} className="back">← {lesson.title}</Link>
        <div className="callout warn">План появится, когда трек обработается.</div>
      </div>
    )
  }

  const included = (t: PlannedTrack) => prefs.include[t.id] ?? t.include
  const tracks = produced.tracks.map((t) => ({ ...t, include: included(t) }))
  const recorded = tracks.filter((t) => t.include)
  const progress = planProgress(tracks, prefs, marks)
  const hasAudio = !!lesson.media.mix || lesson.parts.some((p) => !!p.media.stemWav)
  const win = audioWindow(plan, lesson, tracks, AUDIO_SECONDS)
  const winBars = win ? dawBars(plan, win.bar, win.bars) : null
  const ai = produced.ai
  const onDone = (sid: string, v: boolean) => change((p) => ({ ...p, done: { ...p.done, [sid]: v } }))
  const onInclude = (tid: string, v: boolean) => change((p) => ({ ...p, include: { ...p.include, [tid]: v } }))
  const onLearned = (loop: CoverLoop, v: boolean) => change((p) => setLearned(p, loop, v, Date.now()))
  const ready = !!status?.configured && !!status.model
  const selected = models?.find((m) => m.id === status?.model) ?? null
  const listen = sendAudio && hasAudio && !!win && !!selected?.audioInput
  const price = selected ? estimateCost(selected, JSON.stringify(digest.digest).length, listen ? AUDIO_SECONDS : 0) : null
  const bars = plan.lastBar - plan.firstBar + 1

  const ask = () => {
    if (!ready) {
      setPanel(true)
      return
    }
    const p = api.askProducer(lesson.id, {
      digest: digest.digest,
      digestKey: digest.key,
      trackIds: digest.trackIds,
      loopIds: digest.loopIds,
      audio: listen && win ? { start: win.start, duration: win.duration } : null,
    })
    inFlight.set(lesson.id, p)
    follow(lesson.id, p)
  }
  const clearAnswer = () => {
    if (!window.confirm('Удалить ответ нейросети? Вернуть его можно будет только новым платным запросом.')) return
    void api.clearProducer(lesson.id).then(() => setAnswer(null), (e) => setAskError((e as Error).message))
  }
  const referenceMidi = () => {
    const list = tracks
      .map((t) => ({ name: t.name, model: plan.models.get(t.partId), layerIndex: t.layerIndex }))
      .filter((x): x is { name: string; model: NonNullable<typeof x.model>; layerIndex: number } => !!x.model)
    downloadBlob(exportCoverMidi(lesson, list, profile), `${safeName(`${lesson.title} - эталон`)}.mid`, 'audio/midi')
  }
  const grid = lesson.grid

  return (
    <div className="page cover-page">
      <Link to={`/lesson/${lesson.id}`} className="back">
        ← {lesson.title}
      </Link>
      <h1>План кавера</h1>
      <p className="lead">
        Соберите «{lesson.title}» в Ableton своими руками: дорожка за дорожкой, петля за петлёй. Каждую петлю учите в тренажёре, записываете
        один раз и копируете туда, где она повторяется.
      </p>
      <div className="muted">
        {fmtBpm(grid.bpm)} · {grid.timeSig[0]}/{grid.timeSig[1]}
        {plan.keyName ? ` · ${plan.keyName}` : ''} · {bars} {plural(bars, 'такт', 'такта', 'тактов')} · записываете {recorded.length}{' '}
        {plural(recorded.length, 'дорожку', 'дорожки', 'дорожек')} из {tracks.length}
      </div>
      <Progress value={progress.total ? progress.done / progress.total : 0} label={`Сделано ${progress.done} из ${progress.total}`} />

      <section className="card producer">
        <div className="row between">
          <div>
            <h3>ИИ-продюсер</h3>
            <div className="muted small">
              {ai
                ? `План уточнила модель ${ai.model}${ai.audio ? ' (слушала трек)' : ''} · ${fmtDate(ai.createdAt)}${ai.cost !== null ? ` · $${ai.cost.toFixed(4)}` : ''}`
                : 'Сейчас план составлен программой по нотам трека.'}
            </div>
          </div>
          {!aiMissing && (
            <div className="row">
              <button className="btn primary" disabled={asking} onClick={ask}>
                {asking
                  ? 'Продюсер думает…'
                  : !ready
                    ? 'Подключить ИИ-продюсера'
                    : `${ai ? 'Спросить ещё раз' : 'Спросить ИИ-продюсера'}${price !== null ? ` · ${fmtUsd(price)}` : ''}`}
              </button>
              <button className="btn small ghost" onClick={() => setPanel((v) => !v)}>
                {panel ? 'Скрыть настройки' : 'Настройки'}
              </button>
            </div>
          )}
        </div>
        {aiMissing && (
          <div className="callout warn small">
            Чтобы подключить ИИ-продюсера, перезапустите StemTutor: закройте окно сервера и снова запустите start.bat.
          </div>
        )}
        {asking && (
          <div className="muted small">
            Обычно это занимает от 10 секунд до минуты, иногда до трёх. Можно пока заниматься по плану: ответ появится здесь сам.
          </div>
        )}
        {askError && <div className="callout danger small">{askError}</div>}
        {!ai && !panel && !aiMissing && (
          <p className="muted small">
            По желанию: нейросеть посмотрит на разбор трека (и может послушать его), назовёт дорожки, подскажет звуки в Ableton, порядок записи
            и объяснит каждую дорожку простыми словами. Ноты, такты и октавы всё равно считает программа. Нужен свой ключ OpenRouter.
          </p>
        )}
        {ai?.stale && (
          <div className="callout warn small">
            После ответа нейросети трек изменился (сетка, роли дорожек, ноты или «длина куска» в тренажёре), поэтому её советы к петлям
            скрыты. Спросите ещё раз.
          </div>
        )}
        {ai?.summary && <p>{ai.summary}</p>}
        {ai && ai.tips.length > 0 && (
          <ul className="ai-tips">
            {ai.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        )}
        {ai && (
          <button className="linklike small" onClick={clearAnswer}>
            удалить ответ нейросети
          </button>
        )}
        {panel && !aiMissing && (
          <AiPanel
            status={status}
            onStatus={setStatus}
            models={models}
            modelsError={modelsError}
            loadModels={loadModels}
            digest={digest}
            hasAudio={hasAudio}
            audioBars={winBars}
          />
        )}
      </section>

      <section className="card cover-setup">
        <div className="row">
          <span className="step-no">1</span>
          <h3>Подготовка в Ableton</h3>
        </div>
        <ol className="cover-steps">
          <li>
            Новый проект: темп <b>{fmtBpm(grid.bpm)}</b>, размер <b>{grid.timeSig[0]}/{grid.timeSig[1]}</b>. Работайте в окне Arrangement
            (переключается клавишей Tab).
          </li>
          {hasAudio ? (
            <li>
              Скачайте{' '}
              <a className="btn small" href={exportAudioUrl(lesson.id, 'mix')}>
                трек WAV
              </a>{' '}
              и положите его на аудиодорожку «Оригинал» в самое начало (такт 1): файл уже выровнен по тактам. Пока записываете — слушайте его тихо,
              в конце выключите.
            </li>
          ) : (
            <li>У этого урока нет звука — сверяйтесь с эталонным MIDI ниже.</li>
          )}
          <li>
            По желанию —{' '}
            <button className="btn small" onClick={referenceMidi} disabled={!tracks.length}>
              эталон: MIDI всех дорожек
            </button>
            . Перетащите файл в Arrangement на пустое место под дорожками, к самому началу (такт 1), — Live разложит его по MIDI-дорожкам. Там
            все дорожки плана, и те, что вы не записываете: их можно оставить из эталона или сверить по нему свою игру.
            {tracks.some((t) => t.padMap) && ' Ударные в эталоне — на нотах пэдов: какой звук на какой ноте, сказано в карточке ударных.'}
          </li>
          <li>
            Как записать петлю: выделите её такты на её дорожке и нажмите Ctrl+L — Live зациклит их. Включите метроном и запись, сыграйте
            несколько кругов — каждый круг ляжет отдельным дублем, оставьте лучший. Копия сразу за клипом — Ctrl+D; в другое место — Ctrl+C,
            щелчок в начало нужного такта на этой дорожке, Ctrl+V.
          </li>
          <li>
            Такты в плане: «такты 1–4» — как в тренажёре
            {plan.dawOffset !== 1
              ? `; «в Ableton» — как в Ableton, когда файлы лежат с такта 1 (у этого трека там номер на ${plan.dawOffset - 1} больше)`
              : ' и в Ableton'}
            . Галочка «выучена» ставится сама, когда в тренажёре, в «3 · Играть», петля сыграна целиком с точностью от{' '}
            {Math.round(LEARN_ACCURACY * 100)}% на темпе от {Math.round(LEARN_TEMPO * 100)}%; её можно поставить и вручную.
          </li>
        </ol>
        <Check checked={!!prefs.done[stepId.setup]} onChange={(v) => onDone(stepId.setup, v)}>
          Проект готов
        </Check>
      </section>

      {tracks.map((t, i) => (
        <TrackCard
          key={t.id}
          n={tracks.slice(0, i).filter((x) => x.include).length + 2}
          lesson={lesson}
          plan={plan}
          track={t}
          include={t.include}
          prefs={prefs}
          marks={marks}
          profile={profile}
          onInclude={(v) => onInclude(t.id, v)}
          onDone={onDone}
          onLearned={onLearned}
        />
      ))}

      <section className="card">
        <div className="row">
          <span className="step-no">{recorded.length + 2}</span>
          <h3>Сведение</h3>
        </div>
        <p>
          {hasAudio ? 'Выключите «Оригинал» и послушайте' : 'Послушайте'} свой кавер целиком. Подровняйте громкость дорожек: обычно громче всего
          бочка и бас, тише — тянущиеся аккорды и фоновые звуки. Всё — трек собран вашими руками.
        </p>
        <Check checked={!!prefs.done[stepId.final]} onChange={(v) => onDone(stepId.final, v)}>
          Кавер готов
        </Check>
      </section>
    </div>
  )
}
