import { useEffect, useMemo, useRef, useState } from 'react'
import { DeviceView } from '../components/DeviceView'
import { PROFILES, matchProfile, profileById, type InstrumentProfile } from '../instruments/profiles'
import { useLiveControls } from '../midi/live'
import { chLabel, onMidi, useMidi, type MidiMsg } from '../midi/midi'
import { noteName } from '../music/notes'
import { useOctaveNames, useProfile, useSettings } from '../state/settings'
import type { Calibration } from '../types'

function MidiPanel() {
  const { status, inputs, selectedId, portError, error, select, init } = useMidi()
  const patch = useSettings((s) => s.patch)
  return (
    <section className="card">
      <h3>MIDI-вход</h3>
      {status === 'unsupported' && (
        <p className="warn-text">Этот браузер не поддерживает Web MIDI. Откройте StemTutor в Chrome или Edge.</p>
      )}
      {status === 'denied' && (
        <p className="warn-text">
          Доступ к MIDI запрещён. Разрешите его в настройках сайта (значок замка в адресной строке) и обновите страницу.
        </p>
      )}
      {status === 'error' && <p className="warn-text">Ошибка Web MIDI: {error}</p>}
      {status === 'idle' && (
        <button className="btn" onClick={() => void init()}>
          Подключить MIDI
        </button>
      )}
      {status === 'ready' && (
        <>
          {inputs.length === 0 ? (
            <p className="muted">Устройства не найдены. Подключите контроллер по USB — список обновится сам.</p>
          ) : (
            <label className="field">
              <span>Устройство</span>
              <select
                value={selectedId ?? ''}
                onChange={(e) => {
                  const id = e.target.value || null
                  void select(id)
                  patch({ midiInputName: inputs.find((i) => i.id === id)?.name ?? null })
                }}
              >
                <option value="">— не выбрано —</option>
                {inputs.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {portError && (
            <div className="callout warn">
              <b>Порт занят.</b> {portError}
              <ul>
                <li>
                  Обновите Windows 11 (24H2/25H2): с Windows MIDI Services один контроллер доступен нескольким программам
                  сразу.
                </li>
                <li>Или закройте DAW на время тренировки, а записывайте после.</li>
                <li>Или в DAW отключите вход контроллера и пустите его MIDI-выход в StemTutor через loopback-порт.</li>
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function fmtMsg(m: MidiMsg, names: 'ableton' | 'scientific'): string {
  switch (m.type) {
    case 'noteon':
      return `Note On  ch${m.ch + 1}  ${m.note} (${noteName(m.note, names)})  vel ${m.vel}`
    case 'noteoff':
      return `Note Off ch${m.ch + 1}  ${m.note} (${noteName(m.note, names)})`
    case 'cc':
      return `CC ${m.cc} ch${m.ch + 1} = ${m.value}`
    case 'pitchbend':
      return `Pitch bend ch${m.ch + 1} = ${m.value}`
    default:
      return m.type
  }
}

interface Step {
  kind: 'key' | 'pad'
  bank?: number
  pad?: number
  text: string
}

function CalibrationWizard({ base, onClose }: { base: InstrumentProfile; onClose: () => void }) {
  const setCalibration = useSettings((s) => s.setCalibration)
  const names = useOctaveNames()
  const steps = useMemo<Step[]>(() => {
    const out: Step[] = [
      { kind: 'key', text: 'Сбросьте октаву в 0 (индикатор OCT не горит) и нажмите самую левую клавишу.' },
    ]
    if (base.pads) {
      base.pads.banks.forEach((b, bi) => {
        for (let i = 0; i < base.pads!.count; i++) {
          out.push({
            kind: 'pad',
            bank: bi,
            pad: i,
            text:
              (i === 0 && bi > 0 ? `Переключите пэды на банк ${b.id}. ` : '') +
              `Ударьте пэд ${i + 1}${base.pads!.banks.length > 1 ? ` (банк ${b.id})` : ''}.`,
          })
        }
      })
    }
    return out
  }, [base])
  const [step, setStepState] = useState(0)
  const stepRef = useRef(0)
  const setStep = (s: number) => {
    stepRef.current = s
    setStepState(s)
  }
  const [keyLow, setKeyLow] = useState<{ ch: number; note: number } | null>(null)
  const [pads, setPads] = useState<{ ch: number; note: number }[][]>([])
  const cur = steps[step]

  useEffect(() => {
    return onMidi((m) => {
      if (m.type !== 'noteon') return
      const st = steps[stepRef.current]
      if (!st) return
      if (st.kind === 'key') setKeyLow({ ch: m.ch, note: m.note })
      else
        setPads((prev) => {
          const next = prev.map((b) => b.slice())
          while (next.length <= st.bank!) next.push([])
          next[st.bank!][st.pad!] = { ch: m.ch, note: m.note }
          return next
        })
      setStep(stepRef.current + 1)
    })
  }, [steps])

  const finish = (skipRest: boolean) => {
    const cal: Calibration = { calibratedAt: new Date().toISOString() }
    if (keyLow) {
      cal.keysLowNote = keyLow.note
      cal.keysChannel = keyLow.ch
    }
    const fullBanks = pads.filter((b) => base.pads && b.filter(Boolean).length === base.pads.count)
    if (fullBanks.length) {
      cal.padBanks = fullBanks.map((b) => b.map((x) => x.note))
      const chs = new Set(fullBanks.flat().map((x) => x.ch))
      cal.padsChannel = chs.size === 1 ? [...chs][0] : null
    }
    if (!skipRest || keyLow || fullBanks.length) setCalibration(base.id, cal)
    onClose()
  }

  const done = step >= steps.length
  const previewProfile = base
  const bankDone = (bi: number) => (pads[bi]?.filter(Boolean).length ?? 0) === base.pads?.count
  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <h2>Калибровка: {base.short}</h2>
        {!done ? (
          <p className="lead">
            Шаг {step + 1} из {steps.length}. {cur.text}
          </p>
        ) : (
          <p className="lead">Готово! Проверьте результат и сохраните.</p>
        )}
        <DeviceView
          profile={previewProfile}
          expectKeys={!done && cur.kind === 'key' ? new Map([[0, 'var(--accent-soft)']]) : undefined}
          expectPads={!done && cur.kind === 'pad' ? new Set([cur.pad!]) : undefined}
          bank={!done && cur.kind === 'pad' ? cur.bank : 0}
          highlightBank={!done && cur.kind === 'pad' && cur.pad === 0 && (cur.bank ?? 0) > 0}
        />
        <div className="calib-summary">
          <div>
            Клавиши:{' '}
            {keyLow ? (
              <b>
                канал {keyLow.ch + 1}, левая клавиша = {keyLow.note} ({noteName(keyLow.note, names)})
              </b>
            ) : (
              <span className="muted">ещё нет</span>
            )}
          </div>
          {base.pads?.banks.map((b, bi) => (
            <div key={b.id}>
              Пэды {b.id}:{' '}
              {pads[bi]?.length ? (
                <b>
                  {pads[bi].map((x) => (x ? x.note : '·')).join(' ')}
                  {bankDone(bi) ? ` · канал ${pads[bi][0].ch + 1}` : ''}
                </b>
              ) : (
                <span className="muted">ещё нет</span>
              )}
            </div>
          ))}
        </div>
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          {!done && step > 0 && (
            <button className="btn ghost" onClick={() => setStep(steps.length)}>
              Пропустить остальное
            </button>
          )}
          <button className="btn primary" disabled={!keyLow && !pads.length} onClick={() => finish(false)}>
            Сохранить калибровку
          </button>
        </div>
      </div>
    </div>
  )
}

export default function InstrumentPage() {
  const { settings, patch, patchUi, setCalibration } = useSettings()
  const { base, profile, calibration } = useProfile()
  const { inputs, selectedId, log } = useMidi()
  const names = useOctaveNames()
  const live = useLiveControls(profile)
  const [calibrating, setCalibrating] = useState(false)
  const port = inputs.find((i) => i.id === selectedId)
  const suggested = port ? matchProfile(port.name) : null

  const lowName = noteName(profile.keys.lowNote, names)
  const highName = noteName(profile.keys.lowNote + profile.keys.count - 1, names)
  const groups: [string, InstrumentProfile[]][] = [
    ['AKAI', PROFILES.filter((p) => p.vendor.startsWith('AKAI'))],
    ['Другие контроллеры', PROFILES.filter((p) => !p.vendor.startsWith('AKAI') && p.vendor !== 'Generic')],
    ['Универсальные', PROFILES.filter((p) => p.vendor === 'Generic')],
  ]

  return (
    <div className="page instrument-page">
      <aside className="profile-list">
        <h2>Инструмент</h2>
        {groups.map(([title, list]) => (
          <div key={title} className="profile-group">
            <div className="group-title">{title}</div>
            {list.map((p) => (
              <button
                key={p.id}
                className={`profile-item ${p.id === base.id ? 'selected' : ''}`}
                onClick={() => patch({ instrumentId: p.id })}
              >
                <span className="name">{p.short}</span>
                <span className="meta">
                  {p.keys.count} клавиш{p.pads ? ` · ${p.pads.count} пэдов` : ''}
                  {settings.calibrations[p.id] ? ' · откалиброван' : ''}
                </span>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <div className="instrument-main">
        <div className="row between">
          <div>
            <h1>{base.name}</h1>
            <p className="muted">{base.hint}</p>
          </div>
          <div className="row">
            {calibration && (
              <button className="btn ghost" onClick={() => setCalibration(base.id, null)}>
                Сбросить калибровку
              </button>
            )}
            <button className="btn primary" onClick={() => setCalibrating(true)}>
              {calibration ? 'Перекалибровать' : 'Калибровка'}
            </button>
          </div>
        </div>
        {suggested && suggested.id !== base.id && (
          <div className="callout info">
            Подключено «{port!.name}» — похоже на <b>{suggested.short}</b>.{' '}
            <button className="link" onClick={() => patch({ instrumentId: suggested.id })}>
              Выбрать этот профиль
            </button>
          </div>
        )}

        <div className="device-wrap">
          <DeviceView
            profile={profile}
            octave={live.octave}
            bank={live.bank ?? 0}
            activeKeys={live.keys}
            activePads={live.pads}
            interactive
            displayText={port ? `OCT ${live.octave > 0 ? '+' : ''}${live.octave}` : 'NO MIDI'}
          />
          <p className="muted small">
            Нажимайте клавиши и пэды на контроллере — они подсветятся. Без контроллера можно щёлкать мышью прямо по рисунку.
          </p>
        </div>

        <div className="grid-2">
          <MidiPanel />
          <section className="card">
            <h3>Карта MIDI</h3>
            <dl className="kv">
              <dt>Клавиши</dt>
              <dd>
                {profile.keys.count} шт., канал {chLabel(profile.keys.channel)}, при OCT 0: {lowName}–{highName} (ноты{' '}
                {profile.keys.lowNote}–{profile.keys.lowNote + profile.keys.count - 1})
              </dd>
              <dt>Октавы</dt>
              <dd>
                {profile.keys.octaveRange[0] === profile.keys.octaveRange[1]
                  ? 'без сдвига'
                  : `OCT ${profile.keys.octaveRange[0]}…+${profile.keys.octaveRange[1]}`}
              </dd>
              {profile.pads && (
                <>
                  <dt>Пэды</dt>
                  <dd>
                    канал {chLabel(profile.pads.channel)};{' '}
                    {profile.pads.banks.map((b) => `банк ${b.id}: ${b.notes[0]}–${b.notes[b.notes.length - 1]}`).join(', ')}
                  </dd>
                </>
              )}
              {profile.knobs && (
                <>
                  <dt>Ручки</dt>
                  <dd>CC {profile.knobs.ccs.join(', ')}</dd>
                </>
              )}
            </dl>
            <label className="field inline">
              <span>Названия нот</span>
              <select value={names} onChange={(e) => patchUi({ octaveNames: e.target.value as 'ableton' | 'scientific' })}>
                <option value="ableton">C3 = 60 (Ableton, Cubase, Logic)</option>
                <option value="scientific">C4 = 60 (научная, FL Studio ≈)</option>
              </select>
            </label>
            {calibration?.calibratedAt && (
              <p className="muted small">Откалиброван {new Date(calibration.calibratedAt).toLocaleString('ru-RU')}</p>
            )}
          </section>
        </div>

        <section className="card">
          <h3>Монитор MIDI</h3>
          {log.length === 0 ? (
            <p className="muted">Сообщений пока нет.</p>
          ) : (
            <pre className="midi-log">{log.slice(0, 14).map((m) => fmtMsg(m, names)).join('\n')}</pre>
          )}
        </section>
      </div>
      {calibrating && <CalibrationWizard base={profileById(base.id)} onClose={() => setCalibrating(false)} />}
    </div>
  )
}
