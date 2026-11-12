import { classifyNote, type InstrumentProfile } from '../instruments/profiles'
import { useMidi } from '../midi/midi'
import { chordFlats, chordInfo } from '../music/explain'
import { pc, pcName, prefersFlats } from '../music/notes'
import { chordName, matchChord } from '../music/theory'

const MINORISH = new Set(['m', 'm7', 'm6', 'dim', 'm7b5'])

/** The chord a set of held keys makes (lowest key as the bass), e.g. "Am", "Ab". */
export function heldChordName(notes: number[]): string | null {
  const pcs = new Set(notes.map(pc))
  if (pcs.size < 2) return null
  const w = new Array(12).fill(0)
  for (const p of pcs) w[p] = 1
  const m = matchChord(w, pc(Math.min(...notes)))
  if (!m) return null
  return chordName(m.root, m.quality, null, prefersFlats(m.root, MINORISH.has(m.quality) ? 'minor' : 'major'))
}

/** "Что я играю": names the keys held right now and the chord they make. */
export function ChordReadout({ profile }: { profile: InstrumentProfile }) {
  const active = useMidi((s) => s.active)
  const notes = Object.keys(active)
    .map((k) => k.split(':').map(Number))
    .filter(([ch, note]) => !classifyNote(profile, ch, note))
    .map(([, note]) => note)
    .sort((a, b) => a - b)
  const name = heldChordName(notes)
  const info = name ? chordInfo(name) : null
  return (
    <div className="chord-readout" aria-live="polite">
      <span className="muted small">Сейчас нажато</span>
      {notes.length === 0 ? (
        <span className="muted">— зажмите несколько клавиш</span>
      ) : (
        <>
          <b className="readout-keys">{notes.map((n) => pcName(n, name ? chordFlats(name) : false)).join(' ')}</b>
          {name ? (
            <span className="readout-chord">
              = <b>{name}</b>
              {info && <span className="muted small"> · {info.short}: {info.mood}</span>}
            </span>
          ) : (
            notes.length > 1 && <span className="muted small">— не похоже на знакомый аккорд</span>
          )}
        </>
      )}
    </div>
  )
}
