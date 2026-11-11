import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, exportAudioUrl, mediaUrl } from '../api'
import { Transport, resumeAudio } from '../audio/engine'
import { metronomeSource } from '../audio/sources'
import { Progress, ROLE_HINT, ROLE_LABEL, RoleChip, downloadBlob, fmtBpm, fmtDuration, safeName } from '../components/common'
import { DRUM_LABEL } from '../music/drums'
import { exportPartMidi } from '../music/exportMidi'
import { editGrid, scaleGrid, timeToBeat } from '../music/grid'
import { buildLessonModel, buildPartModel, type PartModel } from '../music/model'
import { noteName } from '../music/notes'
import { useLesson } from '../state/lesson'
import { useOctaveNames, useProfile } from '../state/settings'
import type { Grid, Lesson, Role } from '../types'

const ROLES: Role[] = ['drums', 'bass', 'chords', 'melody', 'vocal', 'other']

function GridCard({ lesson, onGrid, onOffset }: { lesson: Lesson; onGrid: (g: Grid) => void; onOffset: (s: number) => void }) {
  const grid = lesson.grid!
  const [bpmText, setBpmText] = useState(String(Math.round(grid.bpm * 100) / 100))
  const [playing, setPlaying] = useState(false)
  const [beat, setBeat] = useState(0)
  const tr = useRef<Transport | null>(null)
  const gridRef = useRef(grid)
  gridRef.current = grid
  useEffect(() => setBpmText(String(Math.round(grid.bpm * 100) / 100)), [grid.bpm])

  const mix = lesson.media.mix
  const offset = lesson.prefs.audioOffset ?? 0
  useEffect(() => {
    const t = new Transport()
    tr.current = t
    t.endTime = lesson.durationSec + 1
    t.onStop = () => setPlaying(false)
    let el: HTMLAudioElement | null = null
    let unfollow = () => {}
    if (mix) {
      el = new Audio(mediaUrl(lesson.id, mix))
      el.preload = 'auto'
      unfollow = t.follow({ el, offset })
    }
    const unsrc = t.addSource(metronomeSource(gridRef.current, { enabled: () => true }))
    let raf = 0
    const loop = () => {
      setBeat(timeToBeat(gridRef.current, t.now()))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      unsrc()
      unfollow()
      t.dispose()
      el?.removeAttribute('src')
    }
  }, [lesson.id, mix, offset, lesson.durationSec, grid])

  const toggle = async () => {
    await resumeAudio()
    const t = tr.current!
    if (t.playing) {
      t.pause()
      setPlaying(false)
    } else {
      t.play(t.now())
      setPlaying(true)
    }
  }
  const rel = (((Math.floor(beat + 1e-6) - grid.firstDownbeat) % grid.barLength) + grid.barLength) % grid.barLength
  const bar = Math.floor((beat - grid.firstDownbeat) / grid.barLength) + 1
  const apply = (g: Grid) => {
    tr.current?.pause()
    setPlaying(false)
    onGrid(g)
  }

  return (
    <section className="card">
      <div className="row between">
        <h3>Сетка и темп</h3>
        <span className="muted small">
          {grid.origin === 'midi' ? 'из MIDI-файла' : grid.origin === 'tracked' ? 'определена по аудио' : 'задана вручную'}
        </span>
      </div>
      <div className="grid-controls">
        <label className="field inline">
          <span>BPM</span>
          <input
            className="num"
            value={bpmText}
            onChange={(e) => setBpmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = parseFloat(bpmText.replace(',', '.'))
                if (v >= 30 && v <= 300) apply(editGrid(grid, lesson.durationSec, { bpm: v }))
              }
            }}
          />
        </label>
        <button className="btn small" onClick={() => apply(scaleGrid(grid, 0.5))} title="Темп определился вдвое быстрее">
          ÷2
        </button>
        <button className="btn small" onClick={() => apply(scaleGrid(grid, 2))} title="Темп определился вдвое медленнее">
          ×2
        </button>
        <span className="sep" />
        <span className="muted small">Сильная доля:</span>
        <button className="btn small" onClick={() => apply(editGrid(grid, lesson.durationSec, { shiftBeats: -1 }))}>
          ← доля
        </button>
        <button className="btn small" onClick={() => apply(editGrid(grid, lesson.durationSec, { shiftBeats: 1 }))}>
          доля →
        </button>
        <button className="btn small" onClick={() => apply(editGrid(grid, lesson.durationSec, { nudgeSec: -0.01 }))}>
          −10 мс
        </button>
        <button className="btn small" onClick={() => apply(editGrid(grid, lesson.durationSec, { nudgeSec: 0.01 }))}>
          +10 мс
        </button>
      </div>
      <div className="row">
        <button className="btn" onClick={() => void toggle()}>
          {playing ? '❚❚ Стоп' : `▶ Проверить сетку${mix ? ' (трек + метроном)' : ' (метроном)'}`}
        </button>
        <div className="beat-dots" aria-hidden>
          {Array.from({ length: Math.max(1, Math.round(grid.barLength)) }, (_, i) => (
            <i key={i} className={playing && Math.floor(rel) === i ? (i === 0 ? 'on accent' : 'on') : ''} />
          ))}
        </div>
        {playing && <span className="muted small">такт {bar}</span>}
      </div>
      {lesson.source.kind === 'midi' && mix && (
        <label className="field inline">
          <span>Сдвиг записи относительно MIDI, с</span>
          <input
            type="range"
            min={-3}
            max={3}
            step={0.01}
            value={offset}
            onChange={(e) => onOffset(parseFloat(e.target.value))}
          />
          <b className="num">{offset.toFixed(2)}</b>
        </label>
      )}
      <p className="muted small">
        Метроном должен совпадать с треком, а акцент — приходиться на «раз». Если нет — поправьте BPM, ×2/÷2 или сильную долю.
      </p>
    </section>
  )
}

function PartCard({ lesson, model, onPatch }: { lesson: Lesson; model: PartModel; onPatch: (role: Role, name: string) => void }) {
  const { profile } = useProfile()
  const names = useOctaveNames()
  const { part, arrangement: a, patterns, stats } = model
  const [name, setName] = useState(part.name)
  useEffect(() => setName(part.name), [part.name])
  let summary = ''
  if (a.kind === 'pads') {
    summary = a.slots
      .slice(0, 6)
      .map((s) => `${profile.pads!.banks[s.bank].id}${s.pad + 1} ${DRUM_LABEL[s.cls]}`)
      .join(' · ')
  } else if (a.passes.length) {
    const p = a.passes[0]
    const oct = (o: number) => `OCT ${o > 0 ? '+' : ''}${o}`
    summary =
      a.passes.length > 1
        ? `${a.passes.length} прохода: ${a.passes.map((x) => oct(x.startOctave)).join(' / ')}`
        : `${oct(p.startOctave)}${p.changes.length ? `, смен октавы: ${p.changes.length}` : ', без смен октавы'}`
  }
  const uniq = patterns.patterns.length
  const struct = patterns.units
    .filter((u) => !u.empty)
    .map((u) => u.label)
    .join(' ')
  return (
    <div className={`part-card ${part.silent ? 'silent' : ''}`} style={{ ['--c' as string]: `var(--${part.role})` }}>
      <div className="part-head">
        <RoleChip role={part.role} />
        <input
          className="part-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== part.name && onPatch(part.role, name.trim())}
        />
        <select value={part.role} onChange={(e) => onPatch(e.target.value as Role, name)} title="Роль дорожки">
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      {part.silent ? (
        <p className="muted">В стеме тишина или не распознано ни одной ноты.</p>
      ) : (
        <>
          <div className="part-stats muted small">
            {ROLE_HINT[part.role]} · {stats.notes} нот
            {!part.isDrum && stats.notes > 0 && ` · ${noteName(stats.low, names)}–${noteName(stats.high, names)}`} ·{' '}
            {stats.perBar.toFixed(1)} в такт{part.origin === 'transcribed' ? ' · распознано' : ''}
          </div>
          <div className="part-arr">
            <b>{profile.short}:</b> {summary || '—'}
          </div>
          <div className="part-arr muted small">
            Структура: {uniq} {uniq === 1 ? 'паттерн' : 'паттерна(ов)'} по {patterns.unitBars} такт(а) — {struct || '—'}
          </div>
          {a.warnings.map((w) => (
            <div key={w} className="warn-text small">
              {w}
            </div>
          ))}
          <div className="row">
            <Link className="btn primary" to={`/lesson/${lesson.id}/part/${part.id}`}>
              Учить →
            </Link>
            <button
              className="btn small"
              onClick={() =>
                downloadBlob(exportPartMidi(lesson, model, profile), `${safeName(`${lesson.title} - ${part.name}`)}.mid`, 'audio/midi')
              }
            >
              MIDI
            </button>
            {part.media.stemWav && (
              <a className="btn small ghost" href={exportAudioUrl(lesson.id, 'stem', part.id)}>
                Стем WAV
              </a>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function LessonPage() {
  const { id } = useParams()
  const { lesson, error, patch, reload } = useLesson(id)
  const { base, calibration } = useProfile()
  const model = useMemo(() => (lesson && lesson.status === 'ready' ? buildLessonModel(lesson) : null), [lesson])
  const parts = useMemo(() => {
    if (!lesson || lesson.status !== 'ready') return []
    return lesson.parts
      .map((p) => buildPartModel(lesson, p, base, calibration))
      .filter((m): m is PartModel => m !== null)
  }, [lesson, base, calibration])

  if (error) return <div className="page"><div className="callout danger">{error}</div></div>
  if (!lesson) return <div className="page"><p className="muted">Загрузка…</p></div>
  const busy = lesson.status === 'queued' || lesson.status === 'processing'

  return (
    <div className="page lesson-page">
      <Link to="/" className="back">
        ← Уроки
      </Link>
      <div className="row between">
        <div>
          <h1>{lesson.title}</h1>
          <div className="muted">
            {lesson.artist ? `${lesson.artist} · ` : ''}
            {fmtDuration(lesson.durationSec)} · {fmtBpm(lesson.grid?.bpm)}
            {lesson.grid ? ` · ${lesson.grid.timeSig[0]}/${lesson.grid.timeSig[1]}` : ''}
            {model?.key ? ` · ${model.key.name}` : ''}
          </div>
        </div>
        {lesson.media.mix && lesson.status === 'ready' && (
          <a className="btn ghost" href={exportAudioUrl(lesson.id, 'mix')}>
            Трек WAV (под сетку DAW)
          </a>
        )}
      </div>

      {busy && (
        <section className="card">
          <Progress value={lesson.progress} label={lesson.status === 'queued' ? 'В очереди…' : lesson.stageLabel ?? 'Обработка…'} />
          <div className="row between">
            <p className="muted small">Можно уйти со страницы — обработка продолжится.</p>
            <button
              className="btn small ghost"
              disabled={lesson.cancelRequested}
              onClick={() => void api.cancelLesson(lesson.id).then(reload, reload)}
            >
              {lesson.cancelRequested ? 'Отменяется…' : 'Отменить обработку'}
            </button>
          </div>
        </section>
      )}
      {lesson.status === 'failed' && (
        <div className="callout danger">
          <b>Ошибка:</b> {lesson.error}
          <div className="row">
            <button className="btn small" onClick={() => void api.retryLesson(lesson.id).then(reload)}>
              Повторить
            </button>
          </div>
        </div>
      )}
      {lesson.warnings.map((w) => (
        <div key={w} className="callout warn">
          {w}
        </div>
      ))}

      {lesson.status === 'ready' && lesson.grid && (
        <>
          <GridCard
            lesson={lesson}
            onGrid={(g) => void patch({ grid: g })}
            onOffset={(s) => void patch({ prefs: { audioOffset: s } })}
          />
          {model && model.chords.length > 0 && (
            <section className="card">
              <h3>Аккорды</h3>
              <div className="chord-strip">
                {model.chords.slice(0, 48).map((c, i) => (
                  <span key={i} className="chord">
                    {c.name}
                  </span>
                ))}
                {model.chords.length > 48 && <span className="muted">…</span>}
              </div>
            </section>
          )}
          <h2>Дорожки</h2>
          <div className="part-grid">
            {parts.map((m) => (
              <PartCard
                key={m.part.id}
                lesson={lesson}
                model={m}
                onPatch={(role, name) => void patch({ parts: [{ id: m.part.id, role, name }] })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
