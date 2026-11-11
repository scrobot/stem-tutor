import { useMemo, useRef } from 'react'
import { classifyNote, type InstrumentProfile } from '../instruments/profiles'
import { useMidi } from './midi'

/**
 * Which controls are held right now, mapped onto the drawing. The keybed does not report
 * its OCT setting, so the key index is inferred: keep the last octave if the note fits the
 * window, otherwise move to the nearest octave where it does (or use `fixedOctave`).
 */
export function useLiveControls(profile: InstrumentProfile, fixedOctave?: number) {
  const active = useMidi((s) => s.active)
  const octRef = useRef(0)
  return useMemo(() => {
    const keys = new Set<number>()
    const pads = new Set<number>()
    let bank: number | null = null
    const { lowNote, count, octaveRange } = profile.keys
    for (const k of Object.keys(active)) {
      const [ch, note] = k.split(':').map(Number)
      const pad = classifyNote(profile, ch, note)
      if (pad) {
        pads.add(pad.pad)
        bank = pad.bank
        continue
      }
      let oct = fixedOctave ?? octRef.current
      let idx = note - (lowNote + 12 * oct)
      if (fixedOctave === undefined && (idx < 0 || idx >= count)) {
        oct = Math.max(octaveRange[0], Math.min(octaveRange[1], Math.floor((note - lowNote) / 12)))
        if (note - (lowNote + 12 * oct) >= count) oct++
        octRef.current = oct
        idx = note - (lowNote + 12 * oct)
      }
      if (idx >= 0 && idx < count) keys.add(idx)
    }
    return { keys, pads, bank, octave: fixedOctave ?? octRef.current }
  }, [active, profile, fixedOctave])
}
