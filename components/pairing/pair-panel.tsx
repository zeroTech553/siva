'use client'

/**
 * pair-panel.tsx — the pairing UI: code, install command, status, actions.
 *
 * Rendered in two places from the same component, so the two can never drift:
 *   • inside Zero OS on the landing page  (the "Connect a laptop" window)
 *   • as the pairing section at the bottom of the landing page
 *
 * All state comes from `use-pairing.ts`; this file only draws it. `compact`
 * tightens the copy for the small CRT.
 */

import { OsButton, OsNote, OsPill } from '@/components/computer/os/os-ui'
import type { Pairing } from '@/components/pairing/use-pairing'

const STATUS_COPY: Record<Pairing['status'], { label: string; tone: 'idle' | 'good' | 'warn' | 'bad'; hint: string }> = {
  idle: { label: 'Not started', tone: 'idle', hint: 'Mint a code to begin.' },
  loading: { label: 'Working', tone: 'warn', hint: 'Asking the relay for a pairing code…' },
  waiting: { label: 'Waiting', tone: 'warn', hint: 'Run the command on your laptop. This page updates itself.' },
  claimed: { label: 'Claimed', tone: 'warn', hint: 'The installer has the code. Waiting for the bridge to connect.' },
  online: { label: 'Online', tone: 'good', hint: 'Your laptop is connected. Open the desktop.' },
  error: { label: 'Error', tone: 'bad', hint: 'The relay could not be reached.' },
}

export function PairPanel({
  pairing,
  cliName,
  compact = false,
  onChangeCli,
  onContinue,
}: {
  pairing: Pairing
  cliName: string
  compact?: boolean
  /** Lets the visitor pick a different CLI without leaving the window. */
  onChangeCli?: () => void
  /** Shown once the laptop is online (the landing page opens the console). */
  onContinue?: () => void
}) {
  const status = STATUS_COPY[pairing.status]
  const hasCode = Boolean(pairing.code)

  return (
    <div className={`pair-pane${compact ? ' pair-pane-compact' : ''}`}>
      <header className="pair-head">
        <div className="pair-code-block">
          <span className="pair-kicker">Pairing code</span>
          <strong className="pair-code">{hasCode ? pairing.code : '———-———'}</strong>
        </div>
        <OsPill tone={status.tone}>{status.label}</OsPill>
      </header>

      <OsNote>
        {pairing.hostname ? (
          <>
            <strong>{pairing.hostname}</strong> · {status.hint}
          </>
        ) : (
          status.hint
        )}
      </OsNote>

      {pairing.error ? <p className="pair-error">{pairing.error}</p> : null}

      <div className="pair-command-block">
        <span className="pair-kicker">
          Run this on the laptop {compact ? '' : `— Forge installs the bridge and launches ${cliName}`}
        </span>
        <pre className="pair-command">
          {pairing.command ||
            (pairing.status === 'idle'
              ? 'Press “Get a code” to mint a pairing code.'
              : 'Minting a pairing code…')}
        </pre>
      </div>

      {pairing.privateOrigin ? (
        <OsNote>
          This preview host is private. Your laptop must be able to reach {pairing.appOrigin} for pairing to finish.
        </OsNote>
      ) : null}

      <div className="pair-actions">
        {hasCode ? (
          <>
            <OsButton variant="primary" onClick={() => void pairing.copy()}>
              {pairing.copied ? 'Copied ✓' : 'Copy command'}
            </OsButton>
            <OsButton onClick={() => void pairing.reset()}>New code</OsButton>
          </>
        ) : (
          <OsButton
            variant="primary"
            onClick={() => void pairing.start()}
            disabled={pairing.status === 'loading'}
          >
            {pairing.status === 'loading' ? 'Minting…' : 'Get a code'}
          </OsButton>
        )}
        {onChangeCli ? <OsButton onClick={onChangeCli}>Change CLI</OsButton> : null}
        {pairing.status === 'online' && onContinue ? (
          <OsButton variant="primary" onClick={onContinue}>
            Open desktop →
          </OsButton>
        ) : null}
      </div>
    </div>
  )
}
