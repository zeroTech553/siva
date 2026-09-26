'use client'

/**
 * agent-section.tsx — section 02: the agent selector.
 *
 * A CLI selector that behaves like a model selector (pick the tool → pick the
 * model → pick the flags), with a live command preview underneath so what you
 * see is exactly what the laptop will run.
 */

import { CliPicker } from '@/components/cli/cli-picker'
import { CommandPreview } from '@/components/cli/command-preview'
import { FlagPanel } from '@/components/cli/flag-panel'
import { ModelPicker } from '@/components/cli/model-picker'
import type { CliSelection } from '@/lib/client/use-cli-selection'
import { summariseFlags } from '@/lib/shared/cli-flags'

export function AgentSection({ selection }: { selection: CliSelection }) {
  return (
    <section className="land-section" id="agent">
      <header className="land-section-head">
        <p className="land-kicker">
          <span className="land-kicker-tag">02</span> Agent
        </p>
        <h2 className="land-h2">Pick the CLI. Pick the model. Pick the flags.</h2>
        <p className="land-lede">
          Every coding CLI is a different animal, so the selector changes with the tool you choose: its
          own models, its own flags, its own argv. Nothing is hidden behind a generic &quot;AI&quot;
          button — the exact command is printed below the controls.
        </p>
      </header>

      <div className="land-panel">
        <CliPicker
          profiles={selection.profiles}
          value={selection.cli}
          onChange={(cli) => selection.setCli(cli)}
          label="Agent CLI"
        />

        <div className="land-agent-grid">
          <ModelPicker
            profile={selection.profile}
            value={selection.model}
            customValue={selection.customModel}
            onSelect={selection.setModel}
            onCustom={selection.setCustomModel}
          />

          <dl className="land-meta">
            <div>
              <dt>Binary</dt>
              <dd>
                <code>{selection.profile.binary}</code>
              </dd>
            </div>
            <div>
              <dt>Login on the laptop</dt>
              <dd>
                <code>{selection.profile.login}</code>
              </dd>
            </div>
            <div>
              <dt>Docs</dt>
              <dd>
                <a href={selection.profile.docs} target="_blank" rel="noreferrer">
                  {new URL(selection.profile.docs).hostname}
                </a>
              </dd>
            </div>
            <div>
              <dt>Effective</dt>
              <dd>{summariseFlags({ cli: selection.cli, flags: selection.flags, deepResearch: selection.deepResearch })}</dd>
            </div>
          </dl>
        </div>

        <FlagPanel
          profile={selection.profile}
          flags={selection.flags}
          deepResearch={selection.deepResearch}
          onToggle={selection.toggleFlag}
          onSelect={selection.setFlagSelect}
          onValue={selection.setFlagValue}
          onDeepResearch={selection.setDeepResearch}
          onReset={selection.resetFlags}
        />

        <CommandPreview command={selection.command} />
      </div>
    </section>
  )
}
