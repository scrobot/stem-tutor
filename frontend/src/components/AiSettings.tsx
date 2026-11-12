import { useEffect, useState } from 'react'
import { api } from '../api'
import { estimateCost, fmtUsd, type Digest } from '../cover/producer'
import { useSettings } from '../state/settings'
import type { AiModel, AiStatus } from '../types'

/** Seconds of audio the producer may listen to. */
export const AUDIO_SECONDS = 30

/**
 * The AI producer's connection: the OpenRouter key (sent once, only its hint comes back), the
 * model (from the ones that answer by a JSON schema) and what may be sent. Used on the cover
 * plan and on the «ИИ-продюсер» page.
 */
export function AiSettings(props: {
  status: AiStatus | null
  onStatus: (s: AiStatus) => void
  models: AiModel[] | null
  modelsError: string | null
  loadModels: () => void
  /** The plan's digest (shown as «Что уйдёт в нейросеть»); none on the settings page. */
  digest?: Digest | null
  /** Whether the lesson has audio to listen to (the settings page: unknown, so allowed). */
  hasAudio?: boolean
  audioBars?: string | null
}) {
  const { status, models } = props
  const digest = props.digest ?? null
  const hasAudio = props.hasAudio ?? true
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
  // Prices are for this track's digest; without one (the settings page) for a typical one.
  const digestChars = digest ? JSON.stringify(digest.digest).length : 20_000
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
            checked={sendAudio && hasAudio}
            disabled={!hasAudio}
            onChange={(e) => patchUi({ aiSendAudio: e.target.checked })}
          />{' '}
          дать послушать до {AUDIO_SECONDS} секунд трека{props.audioBars ? ` (${props.audioBars})` : ''} — точнее про звуки, но дороже
        </label>
        {!hasAudio && <div className="muted small">У этого урока нет звука — уйдут только ноты.</div>}
        {hasAudio && sendAudio && selected && !selected.audioInput && (
          <div className="warn-text small">Эта модель не слушает звук — уйдут только ноты. Для звука выберите модель с 🎧.</div>
        )}
        {digest && (
          <details className="digest">
            <summary>Что уйдёт в нейросеть</summary>
            <pre>{digestText}</pre>
            {sendAudio && hasAudio && selected?.audioInput && (
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
