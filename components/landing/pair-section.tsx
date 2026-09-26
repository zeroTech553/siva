'use client'

/**
 * pair-section.tsx — section 04: pair a laptop.
 *
 * The same PairPanel that runs inside the Zero OS "Connect" window, on a big
 * canvas, next to a plain account of what the installer touches. The installer
 * details below are not marketing copy — they match lib/server/install-script.ts.
 */

import { PairPanel } from '@/components/pairing/pair-panel'
import type { Pairing } from '@/components/pairing/use-pairing'
import type { CliSelection } from '@/lib/client/use-cli-selection'

const STEPS = [
  {
    title: 'Downloads /install.py',
    body: 'A single Python file, straight from this origin. The shell stub at /install only fetches and runs it.',
  },
  {
    title: 'Installs into ~/.forge',
    body: 'The bridge modules and their own virtualenv live in ~/.forge/ — nothing is written into system Python.',
  },
  {
    title: 'Claims your code',
    body: 'POST /api/pair/claim with the code on screen. The laptop gets a device id and keeps its secret locally.',
  },
  {
    title: 'Starts the bridge',
    body: 'One outbound websocket to the relay, then your chosen CLI is launched in a real PTY on that machine.',
  },
  {
    title: 'Offers autostart',
    body: 'macOS: ~/Library/LaunchAgents/app.forge.bridge.plist. Linux: a --user systemd unit. Both are removed first, so re-running is safe.',
  },
]

const NEVER = [
  'No inbound port is opened and no tunnel binary is installed — the laptop only ever dials out.',
  'Your code is never uploaded; terminal and agent frames are sealed on the laptop before they leave it.',
  'CLI credentials (claude, codex, cursor…) stay in the laptop’s own config. The relay never sees them.',
  'Nothing is edited outside ~/.forge/ unless an agent you started asks to, and you can watch every step.',
]

export function PairSection({
  pairing,
  selection,
  onJump,
}: {
  pairing: Pairing
  selection: CliSelection
  onJump(section: string): void
}) {
  return (
    <section className="land-section" id="pair">
      <header className="land-section-head">
        <p className="land-kicker">
          <span className="land-kicker-tag">04</span> Pair
        </p>
        <h2 className="land-h2">One command, on the laptop you already own.</h2>
        <p className="land-lede">
          Pairing is what turns every window on this page from a demo into your machine. Copy the
          command, paste it into a terminal on the laptop, and this page notices by itself — no
          refreshing, no accounts, no cloud VM.
        </p>
      </header>

      <div className="land-pair-grid">
        <div className="land-panel">
          <div className="pair-platform" role="tablist" aria-label="Laptop platform">
            <button
              type="button"
              role="tab"
              aria-selected={pairing.platform === 'unix'}
              className="pair-platform-tab"
              onClick={() => pairing.setPlatform('unix')}
            >
              macOS / Linux
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pairing.platform === 'windows'}
              className="pair-platform-tab"
              onClick={() => pairing.setPlatform('windows')}
            >
              Windows
            </button>
          </div>

          <PairPanel
            pairing={pairing}
            cliName={selection.profile.name}
            onChangeCli={() => onJump('agent')}
            onContinue={() => onJump('terminal')}
          />
        </div>

        <aside className="land-pair-aside">
          <h3 className="land-h3">What the installer does</h3>
          <ol className="land-steps">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="land-step-n">{index + 1}</span>
                <div className="land-step-text">
                  <strong>{step.title}</strong>
                  <span>{step.body}</span>
                </div>
              </li>
            ))}
          </ol>

          <h3 className="land-h3">What it never does</h3>
          <ul className="land-facts">
            {NEVER.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </aside>
      </div>
    </section>
  )
}
