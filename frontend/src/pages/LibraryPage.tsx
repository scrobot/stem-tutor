import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, mediaUrl } from '../api'
import { Progress, RoleChip, fmtBpm, fmtDuration } from '../components/common'
import type { LessonSummary, Role } from '../types'
import NewLessonDialog from './NewLessonDialog'

const KIND_LABEL = { midi: 'MIDI', stems: 'Стемы', audio: 'Авто' } as const

function LessonCard({ l, onChange }: { l: LessonSummary; onChange: () => void }) {
  const busy = l.status === 'queued' || l.status === 'processing'
  const roles = [...new Set(l.roles)] as Role[]
  return (
    <div className={`lesson-card ${l.status}`}>
      <Link to={`/lesson/${l.id}`} className="lesson-link">
        <div className="thumb">
          {l.thumbnail ? <img src={mediaUrl(l.id, l.thumbnail)} alt="" /> : <span>{l.title.slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="lesson-body">
          <div className="lesson-title">{l.title}</div>
          <div className="muted small">
            {l.artist ? `${l.artist} · ` : ''}
            {KIND_LABEL[l.sourceKind]} · {fmtDuration(l.durationSec)} · {fmtBpm(l.bpm)}
          </div>
          {busy && <Progress value={l.progress} label={l.status === 'queued' ? 'В очереди…' : l.stageLabel ?? 'Обработка…'} />}
          {l.status === 'failed' && <div className="error-text">{l.error ?? 'Ошибка обработки'}</div>}
          {l.status === 'ready' && (
            <div className="chips">
              {roles.map((r) => (
                <RoleChip key={r} role={r} small />
              ))}
            </div>
          )}
        </div>
      </Link>
      <div className="lesson-actions">
        {l.status === 'failed' && (
          <button className="btn small" onClick={() => void api.retryLesson(l.id).then(onChange)}>
            Повторить
          </button>
        )}
        {busy ? (
          <button
            className="btn small ghost"
            disabled={l.cancelRequested}
            onClick={() => void api.cancelLesson(l.id).then(onChange, onChange)}
          >
            {l.cancelRequested ? 'Отменяется…' : 'Отменить'}
          </button>
        ) : (
          <button
            className="btn small ghost"
            onClick={() => {
              if (confirm(`Удалить урок «${l.title}»? Файлы урока будут удалены.`)) void api.deleteLesson(l.id).then(onChange)
            }}
          >
            Удалить
          </button>
        )}
      </div>
    </div>
  )
}

export default function LibraryPage() {
  const [lessons, setLessons] = useState<LessonSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)

  const load = useCallback(() => {
    api
      .lessons()
      .then((l) => {
        setLessons(l)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
  }, [])

  useEffect(load, [load])
  const anyBusy = lessons?.some((l) => l.status === 'queued' || l.status === 'processing')
  useEffect(() => {
    if (!anyBusy) return
    const t = window.setInterval(load, 1200)
    return () => window.clearInterval(t)
  }, [anyBusy, load])

  return (
    <div className="page">
      <div className="row between">
        <h1>Уроки</h1>
        <button className="btn primary" onClick={() => setDialog(true)}>
          + Новый урок
        </button>
      </div>
      {error && <div className="callout danger">Сервер недоступен: {error}</div>}
      {lessons && lessons.length === 0 && (
        <div className="empty">
          <h2>Пока пусто</h2>
          <p>Урок — это трек, разобранный на дорожки и переложенный под ваш контроллер. Есть два пути:</p>
          <div className="grid-2">
            <div className="card">
              <h3>Готовые материалы</h3>
              <p className="muted">
                MIDI-файл трека (MuseScore, BitMidi, VGMusic…) и/или стемы. Самый точный путь: ноты берутся из файла.
              </p>
            </div>
            <div className="card">
              <h3>Автоматически</h3>
              <p className="muted">Ссылка или аудиофайл. Приложение разделит трек на стемы и распознает ноты каждой дорожки.</p>
            </div>
          </div>
          <button className="btn primary" onClick={() => setDialog(true)}>
            Создать первый урок
          </button>
        </div>
      )}
      <div className="lesson-grid">
        {lessons?.map((l) => (
          <LessonCard key={l.id} l={l} onChange={load} />
        ))}
      </div>
      {dialog && (
        <NewLessonDialog
          onClose={() => {
            setDialog(false)
            load()
          }}
        />
      )}
    </div>
  )
}
