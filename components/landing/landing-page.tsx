'use client'

/**
 * landing-page.tsx — the whole landing page, and the only place that owns its
 * state. Three hooks feed every section:
 *
 *   useCliSelection()   which CLI / model / flags the visitor wants
 *   usePairedMachine()  is a laptop already paired with THIS browser?
 *   usePairing()        mint a code, watch it get claimed, watch it come online
 *
 * Sections, in order:
 *   01 hero     the small front-view Zero OS machine on a neutral pegboard
 *   02 agent    CLI selector that behaves like a model selector, with flags
 *   03 terminal real PTY when paired, demo shell when not
 *   04 pair     the install command and exactly what it touches
 *   05 prompt   the last section: plain English straight to the CLI
 *
 * Everything below the hero is ordinary document flow — no canvas, no video, no
 * parallax. The machine is the only "special" thing on the page.
 */

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { OsButton } from '@/components/computer/os/os-ui'
import { AgentSection } from '@/components/landing/agent-section'
import { HeroSection } from '@/components/landing/hero-section'
import { PairSection } from '@/components/landing/pair-section'
import { PromptSection } from '@/components/landing/prompt-section'
import { SiteFooter, SiteNav } from '@/components/landing/site-chrome'
import { TerminalSection } from '@/components/landing/terminal-section'
import { useCliSelection } from '@/lib/client/use-cli-selection'
import { usePairedMachine } from '@/lib/client/use-paired-machine'
import { usePairing } from '@/components/pairing/use-pairing'

export function LandingPage() {
  const router = useRouter()
  const selection = useCliSelection()
  const paired = usePairedMachine()
  const [justConnected, setJustConnected] = useState(false)

  const pairing = usePairing({
    cli: selection.cli,
    // Minting a code costs a serverless call, so only do it when the visitor
    // actually asks (scrolling to / clicking "Pair a laptop").
    autoStart: false,
    onOnline: () => {
      paired.refresh() // the terminal + prompt sections switch to live
      setJustConnected(true)
    },
  })

  // Refs so onJump can read the newest pairing/paired state without re-creating
  // (and without re-rendering the hero machine on every scroll).
  const pairingRef = useRef(pairing)
  pairingRef.current = pairing
  const onJump = useCallback((section: string) => {
    const node = document.getElementById(section)
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (section === 'pair' && pairingRef.current.status === 'idle') {
      void pairingRef.current.start()
    }
  }, [])

  return (
    <div className="land">
      <a className="land-skip" href="#prompt">
        Skip to “Send a prompt”
      </a>
      <SiteNav paired={paired} onJump={onJump} />

      <main className="land-main">
        <HeroSection pairing={pairing} paired={paired} selection={selection} onJump={onJump} />
        <AgentSection selection={selection} />
        <TerminalSection paired={paired} pairing={pairing} onJump={onJump} />
        <PairSection pairing={pairing} selection={selection} onJump={onJump} />
        <PromptSection paired={paired} pairing={pairing} selection={selection} onJump={onJump} />
      </main>

      <SiteFooter />

      {justConnected ? (
        <div className="land-connected" role="status">
          <span className="land-connected-led" aria-hidden="true" />
          <div className="land-connected-text">
            <strong>{pairing.hostname || 'Your laptop'} is connected.</strong>
            <span>The terminal below is now the real PTY. The console has files, agents and the CD tray.</span>
          </div>
          <div className="land-connected-actions">
            <OsButton variant="primary" onClick={() => router.push('/console')}>
              Open console →
            </OsButton>
            <OsButton onClick={() => setJustConnected(false)}>Stay here</OsButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}
