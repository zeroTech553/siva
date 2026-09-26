'use client'

/**
 * cli-picker.tsx — choose which coding CLI does the work.
 *
 * Deliberately the same shape as a model selector: one row of choices, the
 * active one marked, everything visible without a dropdown (a dropdown on a
 * phone costs two taps and hides the logos). A radiogroup semantically, so a
 * keyboard visitor can arrow through it.
 */

import type { CliProfile } from '@/lib/shared/cli-flags'

export function CliPicker({
  profiles,
  value,
  onChange,
  label = 'Coding CLI',
  compact = false,
}: {
  profiles: readonly CliProfile[]
  value: string
  onChange: (id: string) => void
  label?: string
  compact?: boolean
}) {
  return (
    <div className={`cli-picker${compact ? ' cli-picker-compact' : ''}`}>
      <span className="cli-picker-label" id="cli-picker-label">
        {label}
      </span>
      <div className="cli-picker-row" role="radiogroup" aria-labelledby="cli-picker-label">
        {profiles.map((profile) => {
          const selected = profile.id === value
          return (
            <button
              key={profile.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`cli-chip${selected ? ' cli-chip-on' : ''}`}
              title={`${profile.name} — ${profile.binary}`}
              onClick={() => onChange(profile.id)}
            >
              <img className="cli-chip-logo" src={profile.logo} alt="" width={18} height={18} />
              <span className="cli-chip-name">{profile.name}</span>
              <span className="cli-chip-bin">{profile.binary}</span>
              {selected ? <span className="cli-chip-tick" aria-hidden="true">●</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
