import { useMemo, useRef } from 'react'
import { deviceGeometry } from '../instruments/layout'
import type { InstrumentProfile } from '../instruments/profiles'
import { emitMidi } from '../midi/midi'

export interface PadLabel {
  label: string
  color: string
}

export interface DeviceViewProps {
  profile: InstrumentProfile
  octave?: number
  bank?: number
  activeKeys?: Set<number>
  expectKeys?: Map<number, string>
  wrongKeys?: Set<number>
  keyLabels?: Map<number, string>
  activePads?: Set<number>
  expectPads?: Set<number>
  wrongPads?: Set<number>
  padLabels?: Map<number, PadLabel>
  octaveHint?: 'up' | 'down' | null
  highlightBank?: boolean
  displayText?: string
  interactive?: boolean
  className?: string
}

const C = {
  body: 'var(--dev-body)',
  panel: 'var(--dev-panel)',
  white: 'var(--key-white)',
  black: 'var(--key-black)',
  active: 'var(--accent)',
  wrong: 'var(--danger)',
  pad: 'var(--dev-pad)',
  text: 'var(--dev-text)',
}

export function DeviceView(props: DeviceViewProps) {
  const { profile, octave = 0, bank = 0, interactive } = props
  const g = useMemo(() => deviceGeometry(profile), [profile])
  const held = useRef<{ ch: number; note: number } | null>(null)

  const press = (ch: number, note: number) => {
    if (!interactive) return
    held.current = { ch, note }
    emitMidi({ type: 'noteon', ch, note, vel: 100, t: performance.now() })
  }
  const release = () => {
    if (!held.current) return
    emitMidi({ type: 'noteoff', ch: held.current.ch, note: held.current.note, t: performance.now() })
    held.current = null
  }
  const keyNote = (i: number) => profile.keys.lowNote + 12 * octave + i
  const keyCh = profile.keys.channel ?? 0
  const padCh = profile.pads?.channel ?? 9

  const whites = g.keys.filter((k) => !k.black)
  const blacks = g.keys.filter((k) => k.black)
  const keyFill = (i: number, black: boolean) => {
    if (props.wrongKeys?.has(i)) return C.wrong
    if (props.activeKeys?.has(i)) return C.active
    const exp = props.expectKeys?.get(i)
    if (exp) return exp
    return black ? C.black : C.white
  }

  const renderKey = (k: (typeof g.keys)[number]) => {
    const label = props.keyLabels?.get(k.index)
    const expected = props.expectKeys?.has(k.index)
    return (
      <g
        key={k.index}
        onPointerDown={(e) => {
          e.preventDefault()
          press(keyCh, keyNote(k.index))
        }}
        onPointerUp={release}
        onPointerLeave={release}
        style={{ cursor: interactive ? 'pointer' : undefined }}
      >
        <rect
          x={k.x + 1}
          y={k.y}
          width={k.w - 2}
          height={k.h}
          rx={k.black ? 3 : 5}
          fill={keyFill(k.index, k.black)}
          stroke={expected ? 'var(--fg)' : 'var(--key-edge)'}
          strokeWidth={expected ? 2 : 1}
        />
        {label && (
          <text
            x={k.x + k.w / 2}
            y={k.y + k.h - (k.black ? 10 : 14)}
            textAnchor="middle"
            fontSize={k.black ? 13 : 15}
            fontWeight={700}
            fill={k.black ? '#fff' : '#111'}
          >
            {label}
          </text>
        )}
      </g>
    )
  }

  const octUpHint = props.octaveHint === 'up'
  const octDownHint = props.octaveHint === 'down'

  return (
    <svg
      className={`device ${props.className ?? ''}`}
      viewBox={`0 0 ${g.width} ${g.height}`}
      role="img"
      aria-label={profile.name}
      onPointerUp={release}
    >
      <rect x={0} y={0} width={g.width} height={g.height} rx={26} fill={C.body} />
      {g.stick && g.stick.kind === 'joystick' && (
        <g>
          <circle cx={g.stick.x + g.stick.w / 2} cy={g.stick.y + g.stick.h / 2} r={g.stick.w / 2} fill={C.panel} />
          <circle cx={g.stick.x + g.stick.w / 2} cy={g.stick.y + g.stick.h / 2} r={g.stick.w / 4.2} fill="var(--dev-stick)" />
        </g>
      )}
      {g.stick && g.stick.kind !== 'joystick' && (
        <g>
          {[0, 1].map((i) => (
            <rect
              key={i}
              x={g.stick!.x + i * (g.stick!.w / 2 + 4)}
              y={g.stick!.y}
              width={g.stick!.w / 2 - 6}
              height={g.stick!.h}
              rx={8}
              fill={C.panel}
            />
          ))}
        </g>
      )}
      {g.buttons.map((b) => {
        const hint = (b.id === 'octUp' && octUpHint) || (b.id === 'octDown' && octDownHint) || (b.id === 'bank' && props.highlightBank)
        const isOct = b.id === 'octUp' || b.id === 'octDown'
        const lit = isOct && ((b.id === 'octUp' && octave > 0) || (b.id === 'octDown' && octave < 0))
        return (
          <g key={b.id} className={hint ? 'blink' : undefined}>
            <rect
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={6}
              fill={hint ? 'var(--warn)' : lit ? 'var(--dev-btn-lit)' : C.panel}
              stroke={hint ? 'var(--warn)' : 'transparent'}
            />
            <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 5} textAnchor="middle" fontSize={13} fontWeight={600} fill={hint ? '#111' : C.text}>
              {b.label}
            </text>
          </g>
        )
      })}
      {g.display && (
        <g>
          <rect x={g.display.x} y={g.display.y} width={g.display.w} height={g.display.h} rx={6} fill="#05070a" stroke="#2a313b" />
          <text
            x={g.display.x + g.display.w / 2}
            y={g.display.y + g.display.h / 2 + 7}
            textAnchor="middle"
            fontSize={18}
            fontFamily="var(--mono)"
            fill="#7fd6ff"
          >
            {props.displayText ?? `OCT ${octave > 0 ? '+' : ''}${octave}`}
          </text>
        </g>
      )}
      {g.pads.map((p) => {
        const lab = props.padLabels?.get(p.index)
        const active = props.activePads?.has(p.index)
        const wrong = props.wrongPads?.has(p.index)
        const expect = props.expectPads?.has(p.index)
        const notes = profile.pads!.banks[Math.min(bank, profile.pads!.banks.length - 1)].notes
        return (
          <g
            key={p.index}
            onPointerDown={(e) => {
              e.preventDefault()
              press(padCh, notes[p.index])
            }}
            onPointerUp={release}
            onPointerLeave={release}
            style={{ cursor: interactive ? 'pointer' : undefined }}
          >
            <rect
              x={p.x}
              y={p.y}
              width={p.w}
              height={p.h}
              rx={10}
              fill={wrong ? C.wrong : active ? lab?.color ?? C.active : C.pad}
              stroke={expect ? lab?.color ?? 'var(--fg)' : lab ? lab.color : '#3a414c'}
              strokeWidth={expect ? 5 : lab ? 2.5 : 1}
              opacity={lab || active || !props.padLabels ? 1 : 0.55}
            />
            <text x={p.x + 10} y={p.y + 22} fontSize={15} fontWeight={700} fill={active ? '#111' : C.text} opacity={0.75}>
              {p.index + 1}
            </text>
            {lab && (
              <text
                x={p.x + p.w / 2}
                y={p.y + p.h / 2 + 8}
                textAnchor="middle"
                fontSize={Math.min(20, p.w / 5)}
                fontWeight={700}
                fill={active ? '#111' : lab.color}
              >
                {lab.label}
              </text>
            )}
          </g>
        )
      })}
      {g.knobs.map((k) => (
        <g key={k.index}>
          <circle cx={k.cx} cy={k.cy} r={k.r} fill={C.panel} stroke="#3a414c" />
          <line x1={k.cx} y1={k.cy} x2={k.cx} y2={k.cy - k.r * 0.8} stroke={C.text} strokeWidth={3} strokeLinecap="round" />
        </g>
      ))}
      <g>{whites.map(renderKey)}</g>
      <g>{blacks.map(renderKey)}</g>
    </svg>
  )
}
