/** Built-in lessons: the catalogue, a lesson page, and the trainer for one exercise. */
import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BUILTIN_LESSONS, builtinLesson, chordFingers, exerciseSummary, type BuiltinLesson } from '../builtin/lessons'
import { ChordReadout } from '../components/ChordReadout'
import { plural } from '../components/common'
import { keyboardGeometry } from '../instruments/layout'
import { chordFlats, chordInfo } from '../music/explain'
import { noteName } from '../music/notes'
import { useOctaveNames, useProfile } from '../state/settings'
import { TutorialView, type BuiltinInfo } from './TutorialPage'

const GROUPS: { id: BuiltinLesson['group']; title: string; text: string }[] = [
  { id: 'chords', title: 'Аккорды одной рукой', text: 'От первого аккорда до кругов для светлых, мрачных и спокойных подложек.' },
  { id: 'hand', title: 'Разминка для пальцев', text: 'Пять пальцев, минорная позиция и пентатоника — чтобы рука запомнила клавиатуру.' },
]

/** A 25-key keyboard (OCT 0) with the given keys lit and their fingers written on them. */
export function KeyDiagram({ notes, fingers, lowNote = 48, count = 25 }: { notes: number[]; fingers?: number[]; lowNote?: number; count?: number }) {
  const W = 300
  const H = 64
  const keys = keyboardGeometry(lowNote, count, 0, 0, W, H)
  const lit = new Map(notes.map((n, i) => [n - lowNote, fingers?.[i]]))
  return (
    <svg className="key-diagram" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Клавиши: ${notes.map((n) => noteName(n)).join(', ')}`}>
      {[false, true].map((black) =>
        keys
          .filter((k) => k.black === black)
          .map((k) => {
            const on = lit.has(k.index)
            const f = lit.get(k.index)
            return (
              <g key={k.index}>
                <rect x={k.x + 0.5} y={k.y} width={k.w - 1} height={k.h} rx={2} fill={on ? 'var(--accent)' : black ? '#15181d' : '#e9edf2'} stroke="#0b0d10" />
                {on && f && (
                  <text x={k.x + k.w / 2} y={k.y + k.h - 6} textAnchor="middle" fontSize={black ? 9 : 11} fontWeight={700} fill="#0b0d11">
                    {f}
                  </text>
                )}
              </g>
            )
          }),
      )}
    </svg>
  )
}

/** Route /learn — the built-in lessons. */
export function ChordsCatalogPage() {
  const { profile } = useProfile()
  return (
    <div className="page">
      <h1>Аккорды и разминка</h1>
      <p className="muted">
        Встроенные уроки для одной руки на 25 клавишах. Октава везде одна — <b>OCT 0</b> (по умолчанию), переключать ничего не нужно.
        Пальцы подписаны цифрами: 1 — большой … 5 — мизинец. Непонятное слово — загляните в <Link to="/help">словарик</Link>.
      </p>
      <section className="card sandbox">
        <h3>Что я нажал?</h3>
        <p className="muted small">Зажмите на клавиатуре любые клавиши — здесь появится, что это за аккорд и как он звучит.</p>
        <ChordReadout profile={profile} />
      </section>
      {GROUPS.map((g) => (
        <section key={g.id}>
          <h2>{g.title}</h2>
          <p className="muted">{g.text}</p>
          <div className="lesson-grid">
            {BUILTIN_LESSONS.filter((l) => l.group === g.id).map((l, i) => (
              <Link key={l.id} to={`/learn/${l.id}`} className="lesson-card builtin">
                <div className="lesson-link">
                  <div className="thumb">
                    <span>{i + 1}</span>
                  </div>
                  <div className="lesson-body">
                    <div className="lesson-title">{l.title}</div>
                    <div className="muted small">{l.summary}</div>
                    <div className="muted small">
                      {l.exercises.length} {plural(l.exercises.length, 'упражнение', 'упражнения', 'упражнений')} · {l.bpm} BPM
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** Route /learn/:lessonId — what the lesson teaches and its exercises. */
export function BuiltinLessonPage() {
  const { lessonId } = useParams()
  const built = builtinLesson(lessonId)
  const names = useOctaveNames()
  if (!built) {
    return (
      <div className="page">
        <Link to="/learn" className="back">← Аккорды и разминка</Link>
        <div className="callout warn">Урок не найден.</div>
      </div>
    )
  }
  const { def } = built
  const chords = [...new Map(def.exercises.flatMap((ex) => ex.steps ?? []).map((s) => [s.chord, s])).values()]
  const idx = BUILTIN_LESSONS.findIndex((l) => l.id === def.id)
  const nextLesson = BUILTIN_LESSONS[idx + 1]
  return (
    <div className="page lesson-page">
      <Link to="/learn" className="back">← Аккорды и разминка</Link>
      <h1>{def.title}</h1>
      <section className="card intro">
        {def.intro.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </section>
      {chords.length > 0 && (
        <section className="card">
          <h3>Аккорды урока</h3>
          <div className="chord-cards">
            {chords.map((s) => {
              const sorted = s.notes.slice().sort((a, b) => a - b)
              const info = chordInfo(s.chord)
              return (
                <div key={s.chord} className="chord-card">
                  <div className="row between">
                    <b className="chord-name">{s.chord}</b>
                    <span className="muted small">{sorted.map((n) => noteName(n, names, chordFlats(s.chord)).replace(/-?\d+$/, '')).join(' ')}</span>
                  </div>
                  <KeyDiagram notes={sorted} fingers={chordFingers(sorted)} />
                  {info && <div className="muted small">{info.short}: {info.mood}</div>}
                </div>
              )
            })}
          </div>
        </section>
      )}
      <h2>Упражнения</h2>
      <div className="part-grid">
        {def.exercises.map((ex, i) => (
          <div key={ex.id} className="part-card" style={{ ['--c' as string]: 'var(--chords)' }}>
            <div className="part-head">
              <b>
                {i + 1}. {ex.title}
              </b>
            </div>
            <div className="muted small">{ex.goal}</div>
            <div className="part-arr small">{exerciseSummary(ex)}</div>
            <div className="row">
              <Link className="btn primary" to={`/learn/${def.id}/${ex.id}`}>
                Учить →
              </Link>
            </div>
          </div>
        ))}
      </div>
      {nextLesson && (
        <p>
          <Link className="btn" to={`/learn/${nextLesson.id}`}>
            Следующий урок: {nextLesson.title} →
          </Link>
        </p>
      )}
    </div>
  )
}

/** Route /learn/:lessonId/:exId — the trainer for one exercise. */
export function BuiltinTutorialPage() {
  const { lessonId, exId } = useParams()
  const built = builtinLesson(lessonId)
  const info = built?.info.get(exId ?? '')
  const builtin = useMemo<BuiltinInfo | undefined>(() => {
    if (!built || !info) return undefined
    const i = built.def.exercises.findIndex((e) => e.id === exId)
    const next = built.def.exercises[i + 1]
    return {
      exercise: info,
      chordsTogether: built.def.group === 'chords' && !!info.exercise.steps && info.exercise.rhythm !== 'arpUpDown',
      next: next ? { to: `/learn/${built.def.id}/${next.id}`, label: next.title } : undefined,
    }
  }, [built, info, exId])
  if (!built || !builtin) {
    return (
      <div className="page">
        <Link to="/learn" className="back">← Аккорды и разминка</Link>
        <div className="callout warn">Упражнение не найдено.</div>
      </div>
    )
  }
  return (
    <TutorialView
      key={`${lessonId}/${exId}`}
      lesson={built.lesson}
      partId={exId}
      back={{ to: `/learn/${built.def.id}`, label: built.def.title }}
      builtin={builtin}
    />
  )
}
