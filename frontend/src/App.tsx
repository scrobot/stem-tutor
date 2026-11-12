import { useEffect } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom'
import { resumeAudio } from './audio/engine'
import { matchProfile, profileById } from './instruments/profiles'
import { useMidi, type MidiPortInfo } from './midi/midi'
import { BuiltinLessonPage, BuiltinTutorialPage, ChordsCatalogPage } from './pages/ChordsPage'
import CoverPage from './pages/CoverPage'
import GlossaryPage from './pages/GlossaryPage'
import InstrumentPage from './pages/InstrumentPage'
import LessonPage from './pages/LessonPage'
import LibraryPage from './pages/LibraryPage'
import TutorialPage from './pages/TutorialPage'
import { useSettings } from './state/settings'

function choosePort(ports: MidiPortInfo[]): string | null {
  const s = useSettings.getState().settings
  const byName = ports.find((p) => p.name === s.midiInputName)
  if (byName) return byName.id
  const profile = profileById(s.instrumentId)
  const byProfile = ports.find((p) => profile.portMatch.some((m) => p.name.toLowerCase().includes(m)))
  if (byProfile) return byProfile.id
  const known = ports.find((p) => matchProfile(p.name))
  return (known ?? ports[0])?.id ?? null
}

function MidiStatus() {
  const { status, inputs, selectedId, portError } = useMidi()
  const port = inputs.find((i) => i.id === selectedId)
  let cls = 'off'
  let text = 'MIDI: нет устройства'
  if (status === 'unsupported') text = 'Браузер без Web MIDI'
  else if (status === 'denied') text = 'MIDI запрещён'
  else if (portError) {
    cls = 'warn'
    text = 'Порт занят'
  } else if (port) {
    cls = 'on'
    text = port.name
  }
  return (
    <Link to="/instrument" className={`midi-status ${cls}`} title="Настройка контроллера">
      <span className="dot" />
      {text}
    </Link>
  )
}

export default function App() {
  const loaded = useSettings((s) => s.loaded)
  useEffect(() => {
    void useSettings.getState().load()
    const unlock = () => void resumeAudio()
    window.addEventListener('pointerdown', unlock, { once: false })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [])
  useEffect(() => {
    if (loaded) void useMidi.getState().init(choosePort)
  }, [loaded])

  return (
    <BrowserRouter>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="logo" aria-hidden>
            <i style={{ background: 'var(--bass)' }} />
            <i style={{ background: 'var(--chords)' }} />
            <i style={{ background: 'var(--melody)' }} />
            <i style={{ background: 'var(--drums)' }} />
          </span>
          StemTutor
        </Link>
        <nav>
          <NavLink to="/" end>
            Мои треки
          </NavLink>
          <NavLink to="/learn">Аккорды и разминка</NavLink>
          <NavLink to="/instrument">Клавиатура</NavLink>
          <NavLink to="/help">Словарик</NavLink>
        </nav>
        <MidiStatus />
      </header>
      <main>
        {!loaded ? (
          <div className="page">
            <p className="muted">Загрузка…</p>
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/instrument" element={<InstrumentPage />} />
            <Route path="/lesson/:id" element={<LessonPage />} />
            <Route path="/lesson/:id/cover" element={<CoverPage />} />
            <Route path="/lesson/:id/part/:partId" element={<TutorialPage />} />
            <Route path="/learn" element={<ChordsCatalogPage />} />
            <Route path="/learn/:lessonId" element={<BuiltinLessonPage />} />
            <Route path="/learn/:lessonId/:exId" element={<BuiltinTutorialPage />} />
            <Route path="/help" element={<GlossaryPage />} />
            <Route path="*" element={<LibraryPage />} />
          </Routes>
        )}
      </main>
    </BrowserRouter>
  )
}
