import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Health } from '../types'

type Mode = 'auto' | 'materials'

const AUDIO_RE = /\.(wav|mp3|flac|ogg|opus|m4a|aac|aiff?|webm|wma)$/i
const MIDI_RE = /\.(mid|midi|kar|rmi)$/i

function FileDrop(props: {
  label: string
  hint: string
  accept: string
  multiple?: boolean
  files: File[]
  onFiles: (f: File[]) => void
  filter: RegExp
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const list = Array.from(e.dataTransfer.files).filter((f) => props.filter.test(f.name))
    if (list.length) props.onFiles(props.multiple ? [...props.files, ...list] : list.slice(0, 1))
  }
  return (
    <div
      className={`drop ${over ? 'over' : ''} ${props.files.length ? 'has' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
    >
      <div className="drop-label">{props.label}</div>
      {props.files.length ? (
        <ul className="file-list">
          {props.files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              {f.name}
              <button
                className="x"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onFiles(props.files.filter((_, j) => j !== i))
                }}
                aria-label="Убрать"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="drop-hint">{props.hint}</div>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={props.accept}
        multiple={props.multiple}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? [])
          props.onFiles(props.multiple ? [...props.files, ...list] : list.slice(0, 1))
          e.target.value = ''
        }}
      />
    </div>
  )
}

export default function NewLessonDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate()
  const [mode, setMode] = useState<Mode>('materials')
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [audio, setAudio] = useState<File[]>([])
  const [midi, setMidi] = useState<File[]>([])
  const [stems, setStems] = useState<File[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)

  useEffect(() => {
    api.health().then(setHealth).catch(() => undefined)
  }, [])
  const engine = health?.engines?.demucs
  const demucs = engine?.available ?? false
  const effModel = model ?? engine?.default ?? 'htdemucs_ft'

  const canSubmit =
    !busy && (mode === 'auto' ? demucs && (url.trim() !== '' || audio.length > 0) : midi.length > 0 || stems.length > 0)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const fd = new FormData()
    fd.set('mode', mode)
    fd.set('title', title)
    fd.set('url', url.trim())
    if (mode === 'auto') fd.set('engine', `demucs:${effModel}`)
    if (audio[0]) fd.set('audio', audio[0])
    if (mode === 'materials') {
      if (midi[0]) fd.set('midi', midi[0])
      for (const s of stems) fd.append('stems', s)
    }
    try {
      const lesson = await api.createLesson(fd)
      onClose()
      nav(`/lesson/${lesson.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal wide">
        <h2>Новый урок</h2>
        <div className="mode-cards">
          <button className={`mode-card ${mode === 'materials' ? 'selected' : ''}`} onClick={() => setMode('materials')}>
            <b>Готовые материалы</b>
            <span>MIDI-файл и/или стемы из интернета, Ableton, UVR, Moises. Точнее всего — готовый MIDI: ноты без ошибок распознавания.</span>
          </button>
          <button className={`mode-card ${mode === 'auto' ? 'selected' : ''}`} onClick={() => setMode('auto')}>
            <b>Автоматически</b>
            <span>Ссылка или аудиофайл → разделение на стемы → распознавание нот. Нужен модуль разделения.</span>
          </button>
        </div>

        {mode === 'auto' && !demucs && engine?.state !== 'error' && (
          <div className="callout warn">
            <b>Модуль разделения на стемы не установлен.</b> Варианты:
            <ul>
              <li>
                Разделите трек в Ableton Live 12.3 Suite (клип → <i>Separate Stems</i>), UVR или Moises и создайте урок через
                «Готовые материалы».
              </li>
              <li>
                Или закройте StemTutor и установите модуль: <code>start.bat --with-separation</code> (Demucs + PyTorch, ~3 ГБ; на видеокарте NVIDIA
                трек делится за секунды).
              </li>
            </ul>
          </div>
        )}

        <label className="field">
          <span>Название (необязательно)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Promise of the Forgotten" />
        </label>

        {mode === 'auto' ? (
          <>
            <div className="grid-2">
              <label className="field">
                <span>Ссылка на трек</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtube.com/… или soundcloud.com/…" />
              </label>
              <FileDrop label="…или аудиофайл" hint="WAV, MP3, FLAC…" accept="audio/*" files={audio} onFiles={setAudio} filter={AUDIO_RE} />
            </div>
            {demucs && (
              <label className="field">
                <span>Разделение на стемы (Demucs)</span>
                <select value={effModel} onChange={(e) => setModel(e.target.value)}>
                  {(engine?.models ?? [{ id: 'htdemucs_ft', label: '4 стема · точнее' }]).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <span className="muted small">При первом использовании модель скачивается из интернета (80–320 МБ).</span>
              </label>
            )}
            {engine?.hint && (engine.state === 'error' || engine.device === 'cpu') && (
              <div className={`callout ${engine.state === 'error' ? 'danger' : 'warn'}`}>{engine.hint}</div>
            )}
          </>
        ) : (
          <>
            <div className="grid-2">
              <FileDrop
                label="MIDI-файл"
                hint="Перетащите .mid или щёлкните"
                accept=".mid,.midi,.kar,.rmi"
                files={midi}
                onFiles={setMidi}
                filter={MIDI_RE}
              />
              <FileDrop
                label="Стемы"
                hint="Несколько файлов: drums, bass, vocals, other…"
                accept="audio/*"
                multiple
                files={stems}
                onFiles={setStems}
                filter={AUDIO_RE}
              />
            </div>
            <div className="grid-2">
              <label className="field">
                <span>Оригинал для фона — ссылка (необязательно)</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
              </label>
              <FileDrop
                label="…или файл оригинала"
                hint="Чтобы играть поверх записи"
                accept="audio/*"
                files={audio}
                onFiles={setAudio}
                filter={AUDIO_RE}
              />
            </div>
            <p className="muted small">
              С MIDI ноты берутся из файла, а стемы и оригинал звучат в плеере. Только стемы — ноты распознаются автоматически.
            </p>
          </>
        )}

        {error && <div className="callout danger">{error}</div>}
        <div className="row end">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? 'Загрузка…' : 'Создать урок'}
          </button>
        </div>
      </div>
    </div>
  )
}
