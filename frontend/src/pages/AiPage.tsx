import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import { AiSettings } from '../components/AiSettings'
import type { AiModel, AiStatus } from '../types'

/** Route /ai — connect the AI producer once, for every track's cover plan. */
export default function AiPage() {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<AiModel[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api.ai().then(
      (s) => alive && setStatus(s),
      (e) => {
        if (!alive) return
        if (e instanceof ApiError && e.status === 404) setMissing(true)
        else setError((e as Error).message)
      },
    )
    return () => {
      alive = false
    }
  }, [])
  const loadModels = useCallback(() => {
    setModelsError(null)
    api.aiModels().then(
      (r) => setModels(r.models),
      (e) => setModelsError((e as Error).message),
    )
  }, [])

  return (
    <div className="page ai-page">
      <h1>ИИ-продюсер</h1>
      <p className="lead">
        По желанию: нейросеть смотрит на разбор трека (и может его послушать), называет дорожки, подсказывает звуки в Ableton и порядок записи,
        объясняет каждую дорожку простыми словами. Ноты, такты и октавы всё равно считает программа. Подключите её здесь один раз — потом в{' '}
        «Плане кавера» любого трека нажмите «Спросить ИИ-продюсера».
      </p>
      {missing ? (
        <div className="callout warn">
          <b>Сервер StemTutor старой версии — он ещё не умеет подключать нейросеть.</b> Закройте окно сервера (чёрное окно с заголовком
          «StemTutor») и снова запустите <code>start.bat</code> из папки StemTutor. Пока старый сервер работает, <code>start.bat</code> только
          открывает его в браузере.
        </div>
      ) : error ? (
        <div className="callout danger">{error}</div>
      ) : !status ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <section className="card">
          <AiSettings status={status} onStatus={setStatus} models={models} modelsError={modelsError} loadModels={loadModels} />
        </section>
      )}
      <p className="muted small">
        Как пользоваться: откройте трек в <Link to="/">«Моих треках»</Link> → «План кавера» → «Спросить ИИ-продюсера». Что именно уйдёт в
        нейросеть, видно там же, в настройках плана, до отправки.
      </p>
    </div>
  )
}
