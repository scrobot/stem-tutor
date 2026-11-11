import { useMemo } from 'react'
import { create } from 'zustand'
import { api } from '../api'
import { effectiveProfile, profileById, type InstrumentProfile } from '../instruments/profiles'
import type { Calibration, Settings } from '../types'

const DEFAULTS: Settings = { instrumentId: 'akai-mpk-mini-mk3', midiInputName: null, calibrations: {}, ui: {} }

interface SettingsState {
  settings: Settings
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  patch: (p: Partial<Settings>) => void
  patchUi: (p: Settings['ui']) => void
  setCalibration: (profileId: string, cal: Calibration | null) => void
}

let saveTimer: number | null = null
function scheduleSave(get: () => SettingsState) {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    api.saveSettings(get().settings).catch((e) => console.warn('settings save failed', e))
  }, 300)
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULTS,
  loaded: false,
  error: null,
  async load() {
    try {
      const s = await api.settings()
      set({ settings: { ...DEFAULTS, ...s, ui: { ...s.ui } }, loaded: true, error: null })
    } catch (e) {
      set({ loaded: true, error: String((e as Error).message) })
    }
  },
  patch(p) {
    set({ settings: { ...get().settings, ...p } })
    scheduleSave(get)
  },
  patchUi(p) {
    const s = get().settings
    set({ settings: { ...s, ui: { ...s.ui, ...p } } })
    scheduleSave(get)
  },
  setCalibration(profileId, cal) {
    const s = get().settings
    const calibrations = { ...s.calibrations }
    if (cal) calibrations[profileId] = cal
    else delete calibrations[profileId]
    set({ settings: { ...s, calibrations } })
    scheduleSave(get)
  },
}))

/** The selected controller with its calibration applied. */
export function useProfile(): { base: InstrumentProfile; profile: InstrumentProfile; calibration: Calibration | null } {
  const id = useSettings((s) => s.settings.instrumentId)
  const calibration = useSettings((s) => s.settings.calibrations[id] ?? null)
  return useMemo(() => {
    const base = profileById(id)
    return { base, profile: effectiveProfile(base, calibration), calibration }
  }, [id, calibration])
}

export function useOctaveNames(): 'ableton' | 'scientific' {
  return useSettings((s) => s.settings.ui.octaveNames ?? 'ableton')
}
