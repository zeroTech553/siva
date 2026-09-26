'use client'

/**
 * hero-section.tsx — the top of the landing page.
 *
 * A neutral pegboard (#e9ecec, the specified frame colour) with the SMALL,
 * FRONT-VIEW Zero OS machine mounted on it, and the pitch beside it. No lime,
 * no gradients, no hero video: the machine itself is the hero, and it is live —
 * it boots, its windows drag, its keyboard types.
 */

import { ZeroComputer } from '@/components/computer/zero-computer'
import { ZeroLogo } from '@/components/computer/zero-logo'
import { OsButton } from '@/components/computer/os/os-ui'
import { HeroOs } from '@/components/landing/hero-os'
import type { Pairing } from '@/components/pairing/use-pairing'
import type { PairedMachine } from '@/lib/client/use-paired-machine'
import type { CliSelection } from '@/lib/client/use-cli-selection'

const POINTS = [
  {
    title: 'A real terminal',
    body: 'A live PTY on your laptop, streamed over an end-to-end encrypted socket. The relay only ever sees ciphertext.',
  },
  {
    title: 'Six coding CLIs',
    body: 'Claude Code, Codex, Cursor, OpenCode, Copilot and Antigravity — one prompt box, per-CLI models and flags.',
  },
  {
    title: 'Nothing inbound',
    body: 'The laptop makes one outbound connection. No tunnel binary, no open port, no cloud VM to pay for.',
  },
]

export function HeroSection({
  pairing,
  paired,
  selection,
  onJump,
}: {
  pairing: Pairing
  paired: PairedMachine
  selection: CliSelection
  onJump(section: string): void
}) {
  return (
    <section className="land-hero" id="top">
      <div className="land-pegboard">
        <span className="land-screw land-screw-a" aria-hidden="true" />
        <span className="land-screw land-screw-b" aria-hidden="true" />
        <span className="land-screw land-screw-c" aria-hidden="true" />
        <span className="land-screw land-screw-d" aria-hidden="true" />

        <div className="land-hero-grid">
          <div className="land-hero-copy">
            <p className="land-kicker">
              <ZeroLogo scale={1} />
              <span className="land-kicker-tag">build 1.0</span>
            </p>
            <h1 className="land-title">
              Your computer,
              <br />
              in your pocket.
            </h1>
            <p className="land-lede">
              Pair a laptop once. From any browser you then get its real terminal, its files, and its
              coding agents — running on hardware you already own.
            </p>

            <ul className="land-points">
              {POINTS.map((point) => (
                <li key={point.title}>
                  <span className="land-point-dot" aria-hidden="true" />
                  <div className="land-point-text">
                    <strong>{point.title}</strong>
                    <span>{point.body}</span>
                  </div>
                </li>
              ))}
            </ul>

            <div className="land-cta-row">
              <OsButton variant="primary" onClick={() => onJump('prompt')}>
                Send a prompt
              </OsButton>
              <OsButton onClick={() => onJump('pair')}>
                {paired.hasSession ? 'Pair another laptop' : 'Pair a laptop'}
              </OsButton>
              <OsButton onClick={() => onJump('terminal')}>See the terminal</OsButton>
            </div>
          </div>

          <div className="land-hero-machine">
            <ZeroComputer size="sm" busy={false}>
              {(machine) => (
                <HeroOs machine={machine} pairing={pairing} paired={paired} selection={selection} onJump={onJump} />
              )}
            </ZeroComputer>
            <p className="land-machine-note">
              That is not a picture. Press ⏻ to boot it, drag the mouse, tap the keys, right-click the
              desktop.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
