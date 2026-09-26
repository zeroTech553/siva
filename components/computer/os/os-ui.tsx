'use client'

/**
 * os-ui.tsx — the Zero OS control set.
 *
 * Small, flat, hard-shadowed controls in the 90s idiom: 2px ink borders, a
 * 2px offset shadow that collapses when the control is pressed, and the
 * Silkscreen bitmap face for chrome. Everything in an OS window is built from
 * these, which is what keeps the whole product looking like one machine.
 *
 * Every control plays the matching sound (lib/client/zero-sound.ts) so the UI
 * feels like hardware rather than a web page.
 */

import type { ChangeEvent, ReactNode } from 'react'

import { playClick } from '@/lib/client/zero-sound'

export function OsButton({
  children,
  onClick,
  disabled,
  type = 'button',
  variant = 'default',
  title,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
  /** `primary` is the cyan-filled call to action; `danger` is ink-on-red text. */
  variant?: 'default' | 'primary' | 'danger'
  title?: string
}) {
  return (
    <button
      type={type}
      className={`zos-btn${variant === 'default' ? '' : ` zos-btn-${variant}`}`}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (disabled) return
        void playClick()
        onClick?.()
      }}
    >
      {children}
    </button>
  )
}

/** The three title-bar buttons: minimize, maximize/restore, close. */
export function OsCaptionButton({
  glyph,
  label,
  onClick,
}: {
  glyph: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="zos-caption-btn"
      aria-label={label}
      title={label}
      onClick={() => {
        void playClick()
        onClick()
      }}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}

export function OsField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  mono = true,
  ariaLabel,
}: {
  label?: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  ariaLabel?: string
}) {
  return (
    <label className="zos-field">
      {label ? <span className="zos-field-label">{label}</span> : null}
      <input
        className={mono ? 'zos-input zos-input-mono' : 'zos-input'}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </label>
  )
}

export function OsSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label?: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (next: T) => void
  disabled?: boolean
}) {
  return (
    <label className="zos-field">
      {label ? <span className="zos-field-label">{label}</span> : null}
      <select
        className="zos-select"
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function OsTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  ariaLabel,
  onKeyDown,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  rows?: number
  ariaLabel?: string
  disabled?: boolean
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  return (
    <textarea
      className="zos-textarea"
      value={value}
      rows={rows}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}

export function OsCheck({
  checked,
  onChange,
  label,
  hint,
  risky = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  hint?: ReactNode
  risky?: boolean
}) {
  return (
    <label className={`zos-check${risky ? ' zos-check-risky' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          void playClick()
          onChange(event.target.checked)
        }}
      />
      <span className="zos-check-box" aria-hidden="true">
        {checked ? '✔' : ''}
      </span>
      <span className="zos-check-text">
        <span className="zos-check-label">{label}</span>
        {hint ? <span className="zos-check-hint">{hint}</span> : null}
      </span>
    </label>
  )
}

/** Small note line under a control. */
export function OsNote({ children }: { children: ReactNode }) {
  return <p className="zos-note">{children}</p>
}

/** A sunken panel, like a group box in a 90s dialog. */
export function OsGroup({ legend, children }: { legend?: string; children: ReactNode }) {
  return (
    <fieldset className="zos-group">
      {legend ? <legend>{legend}</legend> : null}
      {children}
    </fieldset>
  )
}

/**
 * A pixel-art icon from public/sprites/*.png (built by `pnpm sprites` from
 * pixel/sprites.mjs). `name` is the sprite filename without the extension.
 */
export function OsSprite({ name, size = 20, alt = '' }: { name: string; size?: number; alt?: string }) {
  return (
    <img
      className="zos-sprite"
      src={`/sprites/${name}.png`}
      width={size}
      height={size}
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  )
}

/** A status chip: online / offline / working. */
export function OsPill({ tone = 'idle', children }: { tone?: 'idle' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  return <span className={`zos-pill zos-pill-${tone}`}>{children}</span>
}
