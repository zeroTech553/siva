'use client'

/**
 * model-picker.tsx — which model the chosen CLI should run.
 *
 * A native <select> (styled retro) plus a "Custom model id" escape hatch, on
 * purpose: model ids change every few weeks and a stale list must never stop
 * somebody from running the model their plan actually has.
 */

import { CUSTOM_MODEL } from '@/lib/client/use-cli-selection'
import type { CliProfile } from '@/lib/shared/cli-flags'

export function ModelPicker({
  profile,
  value,
  customValue,
  onSelect,
  onCustom,
}: {
  profile: CliProfile
  value: string
  customValue: string
  onSelect: (id: string) => void
  onCustom: (value: string) => void
}) {
  const isCustom = value === CUSTOM_MODEL

  return (
    <div className="cli-model">
      <label className="cli-field">
        <span className="cli-field-label">Model</span>
        <select
          className="cli-select"
          value={isCustom ? CUSTOM_MODEL : value}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">{profile.name} default</option>
          {profile.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
              {model.note ? ` — ${model.note}` : ''}
            </option>
          ))}
          <option value={CUSTOM_MODEL}>Custom model id…</option>
        </select>
      </label>

      {isCustom ? (
        <label className="cli-field">
          <span className="cli-field-label">Model id</span>
          <input
            className="cli-input"
            value={customValue}
            placeholder={profile.models[0]?.id ?? 'model-id'}
            onChange={(event) => onCustom(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>
      ) : null}

      <p className="cli-hint">
        Passed as <code>{profile.modelFlag} &lt;id&gt;</code>. Lists go stale — Custom always works.
      </p>
    </div>
  )
}
