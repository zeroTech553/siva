'use client'

/**
 * site-chrome.tsx — the sticky top bar and the footer of the landing page.
 *
 * The bar doubles as the machine's status light: once a laptop is paired it
 * shows the hostname and a button into the full console, so the visitor always
 * knows whether the windows below are demos or the real thing.
 */

import { useRouter } from 'next/navigation'

import { ZeroLogo } from '@/components/computer/zero-logo'
import { OsButton, OsPill } from '@/components/computer/os/os-ui'
import type { PairedMachine } from '@/lib/client/use-paired-machine'

const LINKS = [
  { id: 'agent', label: 'Agent' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'pair', label: 'Pair' },
  { id: 'prompt', label: 'Send a prompt' },
]

export function SiteNav({
  paired,
  onJump,
}: {
  paired: PairedMachine
  onJump(section: string): void
}) {
  const router = useRouter()
  return (
    <header className="land-nav">
      <button type="button" className="land-nav-brand" onClick={() => onJump('top')}>
        <ZeroLogo scale={1} />
        <span className="land-nav-name">
          Forge
          <em>your computer, in your pocket</em>
        </span>
      </button>

      <nav className="land-nav-links" aria-label="Sections">
        {LINKS.map((link) => (
          <button type="button" key={link.id} onClick={() => onJump(link.id)}>
            {link.label}
          </button>
        ))}
      </nav>

      <div className="land-nav-state">
        <OsPill tone={paired.online ? 'good' : paired.hasSession ? 'warn' : 'idle'}>
          {paired.online ? `${paired.hostname} online` : paired.hasSession ? 'laptop offline' : 'no laptop'}
        </OsPill>
        {paired.hasSession ? (
          <OsButton variant="primary" onClick={() => router.push('/console')}>
            Open console
          </OsButton>
        ) : (
          <OsButton onClick={() => onJump('pair')}>Pair a laptop</OsButton>
        )}
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="land-footer">
      <div className="land-footer-cols">
        <div>
          <p className="land-footer-brand">
            <ZeroLogo scale={1} />
            <span className="land-footer-name">Forge</span>
          </p>
          <p className="land-footer-note">
            Your own laptop, driven from any browser. No cloud VM, no inbound port, no per-seat bill —
            the server only relays sealed frames between two devices you control.
          </p>
        </div>
        <div>
          <h4>How it works</h4>
          <ul>
            <li>Pairing code → laptop claims it → device secret stays local.</li>
            <li>One outbound websocket carries terminal, files, agents and presence.</li>
            <li>Payloads are AES-256-GCM sealed per device; the relay sees ciphertext.</li>
          </ul>
        </div>
        <div>
          <h4>Supported CLIs</h4>
          <ul>
            <li>Claude Code · Codex · Cursor</li>
            <li>OpenCode · GitHub Copilot · Antigravity</li>
            <li>Each with its own models, flags and permission model.</li>
          </ul>
        </div>
      </div>
      <p className="land-footer-legal">
        Built as a working product, not a mock-up: every window on this page is state, and every action
        either runs locally in the browser or on hardware you paired.
      </p>
    </footer>
  )
}
