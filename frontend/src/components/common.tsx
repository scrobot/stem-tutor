import type { ReactNode } from 'react'
import type { Role } from '../types'

export const ROLE_LABEL: Record<Role, string> = {
  drums: 'Ударные',
  bass: 'Бас',
  chords: 'Аккорды',
  melody: 'Мелодия',
  vocal: 'Вокал',
  other: 'Прочее',
}

export const ROLE_HINT: Record<Role, string> = {
  drums: 'удары по пэдам',
  bass: 'одноголосная линия',
  chords: 'аккорды и гармония',
  melody: 'одноголосная мелодия',
  vocal: 'мелодия вокала',
  other: 'прочие звуки',
}

export function RoleChip({ role, small }: { role: Role; small?: boolean }) {
  return (
    <span className={`role-chip ${small ? 'small' : ''}`} style={{ ['--c' as string]: `var(--${role})` }}>
      {ROLE_LABEL[role]}
    </span>
  )
}

export function Progress({ value, label }: { value: number; label?: ReactNode }) {
  return (
    <div className="progress">
      <div className="bar">
        <i style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
      </div>
      {label && <div className="progress-label">{label}</div>}
    </div>
  )
}

export function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function fmtBpm(bpm?: number | null): string {
  if (!bpm) return '—'
  // Two decimals for a non-integer tempo: what a DAW like Ableton accepts, and 0.1 BPM would
  // drift about 0.2 s over 10 minutes.
  return Math.abs(bpm - Math.round(bpm)) < 0.005 ? `${Math.round(bpm)} BPM` : `${Number(bpm.toFixed(2))} BPM`
}

export { plural } from '../music/explain'

export function downloadBlob(data: BlobPart, filename: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'stemtutor'
}
