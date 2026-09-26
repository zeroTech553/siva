'use client'

/**
 * terminal-section.tsx — section 03: the terminal.
 *
 * Paired and online? This is the real PTY on the laptop. Not paired yet? It is
 * the demo shell, which behaves like a terminal and teaches the pairing
 * commands. Either way it is a working terminal, not a screenshot.
 */

import { DemoTerminal } from '@/components/terminal/demo-terminal'
import { MachineTerminal } from '@/components/terminal/machine-terminal'
import { OsButton, OsPill } from '@/components/computer/os/os-ui'
import type { Pairing } from '@/components/pairing/use-pairing'
import type { PairedMachine } from '@/lib/client/use-paired-machine'

const PIPE = [
  '   phone / browser',
  '        │  wss  (one outbound socket)',
  '        ▼',
  '   /api/relay  ── sealed frames ──▶  relay room  ──▶  daemon on your laptop',
  '        ▲                                                      │',
  '        └────────────── AES-256-GCM ciphertext ◀───── real PTY ─┘',
].join('\n')

const FACTS = [
  'The daemon spawns a real PTY: your shell, your env vars, your git repo, your node_modules.',
  'Payloads are sealed per-device; the relay and the database only ever hold ciphertext.',
  'Terminal output, agent jobs, file listings and presence share one socket — no polling storms.',
  'Nothing is inbound: the laptop dials out, so no tunnel binary and no firewall change.',
]

export function TerminalSection({
  paired,
  pairing,
  onJump,
}: {
  paired: PairedMachine
  pairing: Pairing
  onJump(section: string): void
}) {
  const live = paired.hasSession && paired.online
  return (
    <section className="land-section" id="terminal">
      <header className="land-section-head">
        <p className="land-kicker">
          <span className="land-kicker-tag">03</span> Terminal
        </p>
        <h2 className="land-h2">
          A terminal that lives on your laptop{live ? ` (${paired.hostname})` : ''}
        </h2>
        <p className="land-lede">
          {live
            ? 'Connected. Type — this is your real shell, streamed over one encrypted socket.'
            : 'This one is the demo shell: it answers help, ls, open, cat, install and pair so you can feel how the OS works before you connect hardware. Pair a laptop and the same window becomes your real PTY.'}
        </p>
      </header>

      <div className="land-terminal-grid">
        <div className="land-panel land-terminal-panel" data-live={live ? 'true' : 'false'}>
          <div className="land-terminal-head">
            <span className="land-titlebar-dots" aria-hidden="true">
              <i /> <i /> <i />
            </span>
            <strong>{live ? `${paired.hostname} — zsh` : 'zero-os — demo shell'}</strong>
            <OsPill tone={live ? 'good' : 'idle'}>{live ? 'live pty' : 'demo'}</OsPill>
          </div>
          <div className="land-terminal-body">
            {live ? (
              <MachineTerminal
                deviceId={paired.deviceId}
                phoneSecret={paired.phoneSecret}
                hostname={paired.hostname}
              />
            ) : (
              <DemoTerminal
                hostname="zero-os"
                installCommand={pairing.command}
                onOpenApp={() => onJump('agent')}
                onPair={() => onJump('pair')}
              />
            )}
          </div>
        </div>

        <aside className="land-terminal-aside">
          <pre className="land-diagram" aria-label="How the connection works">
            {PIPE}
          </pre>
          <ul className="land-facts">
            {FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          <div className="os-actions">
            <OsButton variant="primary" onClick={() => onJump('pair')}>
              {live ? 'Pair another laptop' : 'Pair a laptop'}
            </OsButton>
            <OsButton onClick={() => onJump('prompt')}>Or just send a prompt</OsButton>
          </div>
        </aside>
      </div>
    </section>
  )
}
