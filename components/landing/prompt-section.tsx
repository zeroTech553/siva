'use client'

/**
 * prompt-section.tsx — section 05, the LAST one: "Send a prompt".
 *
 * For visitors who would rather not meet a terminal: pick the CLI the way you
 * would pick a model, switch on deep research if you want evidence before
 * changes, type plain English, press Send. The composer itself lives in
 * components/cli/prompt-composer.tsx (shared with the console's Prompt window);
 * this file only adds the section heading and the "pair a laptop first" block.
 */

import { OsButton, OsNote } from '@/components/computer/os/os-ui'
import { PromptComposer } from '@/components/cli/prompt-composer'
import type { CliSelection } from '@/lib/client/use-cli-selection'
import type { PairedMachine } from '@/lib/client/use-paired-machine'
import type { Pairing } from '@/components/pairing/use-pairing'

export function PromptSection({
  paired,
  pairing,
  selection,
  onJump,
}: {
  paired: PairedMachine
  pairing: Pairing
  selection: CliSelection
  onJump(section: string): void
}) {
  return (
    <section className="land-section" id="prompt">
      <header className="land-section-head">
        <p className="land-kicker">
          <span className="land-kicker-tag">05</span> Send a prompt
        </p>
        <h2 className="land-h2">Skip the terminal. Just say what you want.</h2>
        <p className="land-lede">
          Choose the CLI the way you would choose a model, switch on deep research if you want evidence
          before changes, and write your request in plain English. It goes straight to that CLI on your
          laptop — the exact command is printed under the box, so nothing is a black box.
        </p>
      </header>

      <div className="land-panel prompt-panel">
        <PromptComposer paired={paired} selection={selection} onNeedMachine={() => onJump('pair')} />

        {!paired.hasSession || !paired.online ? (
          <div className="prompt-need-machine">
            <strong>{paired.hasSession ? 'Laptop offline' : 'No laptop connected'}</strong>
            <OsNote>
              {paired.hasSession
                ? 'Start the Forge bridge on that machine and this box goes live by itself — no refresh needed.'
                : 'Run this on the machine you want to drive: it installs the bridge, pairs it to this browser and launches the CLI you picked above. Nothing is uploaded; the laptop only dials out.'}
            </OsNote>
            {pairing.command ? <pre className="prompt-command">{pairing.command}</pre> : null}
            <div className="os-actions">
              <OsButton variant="primary" onClick={() => onJump('pair')}>
                {pairing.code ? 'Back to my code' : 'Get my pairing code'}
              </OsButton>
              <OsButton onClick={() => onJump('terminal')}>Try the demo terminal</OsButton>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
