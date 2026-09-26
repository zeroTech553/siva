'use client'

/**
 * flag-panel.tsx — what the chosen CLI can do, as switches instead of man pages.
 *
 * Every flag in lib/shared/cli-flags.ts is rendered by its `kind`:
 *
 *   toggle   a checkbox              (--continue, --json, --silent …)
 *   select   a small radio row       (--sandbox read-only|workspace-write|…)
 *   value    a text box that fills   --allowedTools <what you type>
 *
 * Each one carries a one-sentence `hint`, because the whole point of this panel
 * is that somebody who has never used a terminal can still choose sensibly.
 * Risky flags (they hand the agent real power over the machine) are marked and
 * explained rather than hidden.
 *
 * "Deep research" sits at the top: it adds that CLI's read-only/research flags
 * AND wraps the prompt in a research brief (see DEEP_RESEARCH_BRIEF).
 */

import { OsButton } from '@/components/computer/os/os-ui'
import type { CliFlag, CliProfile, FlagState } from '@/lib/shared/cli-flags'

export function FlagPanel({
  profile,
  flags,
  deepResearch,
  onToggle,
  onSelect,
  onValue,
  onDeepResearch,
  onReset,
}: {
  profile: CliProfile
  flags: FlagState
  deepResearch: boolean
  onToggle(id: string, on: boolean): void
  onSelect(id: string, value: string): void
  onValue(id: string, value: string): void
  onDeepResearch(on: boolean): void
  onReset(): void
}) {
  return (
    <div className="cli-flags">
      <label className={`cli-flag cli-flag-research${deepResearch ? ' cli-flag-on' : ''}`}>
        <input type="checkbox" checked={deepResearch} onChange={(event) => onDeepResearch(event.target.checked)} />
        <span className="cli-flag-box" aria-hidden="true">
          {deepResearch ? '✔' : ''}
        </span>
        <span className="cli-flag-text">
          <span className="cli-flag-name">Deep research</span>
          <span className="cli-flag-hint">
            {profile.deepResearch.argv.length
              ? `Adds ${profile.deepResearch.argv.join(' ')} — ${profile.deepResearch.note}`
              : profile.deepResearch.note}
            . The prompt is wrapped in a research brief: evidence first, no edits.
          </span>
        </span>
      </label>

      <div className="cli-flags-head">
        <span className="cli-field-label">Flags for {profile.binary}</span>
        <OsButton onClick={onReset}>Reset</OsButton>
      </div>

      <div className="cli-flags-list">
        {profile.flags.map((flag) => (
          <FlagRow
            key={flag.id}
            flag={flag}
            state={flags}
            onToggle={onToggle}
            onSelect={onSelect}
            onValue={onValue}
          />
        ))}
      </div>
    </div>
  )
}

function FlagRow({
  flag,
  state,
  onToggle,
  onSelect,
  onValue,
}: {
  flag: CliFlag
  state: FlagState
  onToggle(id: string, on: boolean): void
  onSelect(id: string, value: string): void
  onValue(id: string, value: string): void
}) {
  const on = flag.kind === 'toggle' ? Boolean(state.toggles[flag.id]) : undefined

  return (
    <div className={`cli-flag${on ? ' cli-flag-on' : ''}${flag.risky ? ' cli-flag-risky' : ''}`}>
      {flag.kind === 'toggle' ? (
        <label className="cli-flag-main">
          <input type="checkbox" checked={Boolean(on)} onChange={(event) => onToggle(flag.id, event.target.checked)} />
          <span className="cli-flag-box" aria-hidden="true">
            {on ? '✔' : ''}
          </span>
          <span className="cli-flag-text">
            <span className="cli-flag-name">
              {flag.label}
              {flag.risky ? <em className="cli-flag-warn">powerful</em> : null}
            </span>
            <span className="cli-flag-hint">{flag.hint}</span>
            <code className="cli-flag-argv">{(flag.argv ?? []).join(' ')}</code>
          </span>
        </label>
      ) : null}

      {flag.kind === 'select' ? (
        <div className="cli-flag-main">
          <span className="cli-flag-text">
            <span className="cli-flag-name">{flag.label}</span>
            <span className="cli-flag-hint">{flag.hint}</span>
          </span>
          <span className="cli-flag-choices">
            {(flag.options ?? []).map((option) => {
              const selected = (state.selects[flag.id] ?? '') === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`cli-choice${selected ? ' cli-choice-on' : ''}`}
                  aria-pressed={selected}
                  title={option.argv.length ? option.argv.join(' ') : 'no extra flag'}
                  onClick={() => onSelect(flag.id, option.value)}
                >
                  {option.label}
                </button>
              )
            })}
          </span>
        </div>
      ) : null}

      {flag.kind === 'value' ? (
        <label className="cli-flag-main">
          <span className="cli-flag-text">
            <span className="cli-flag-name">{flag.label}</span>
            <span className="cli-flag-hint">{flag.hint}</span>
            <code className="cli-flag-argv">{(flag.template ?? []).join(' ').replace('{value}', '…')}</code>
          </span>
          <input
            className="cli-input cli-flag-input"
            value={state.values[flag.id] ?? ''}
            placeholder={flag.placeholder}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => onValue(flag.id, event.target.value)}
          />
        </label>
      ) : null}
    </div>
  )
}
