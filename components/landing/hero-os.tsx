'use client'

/**
 * hero-os.tsx — the app list for the Zero OS desktop in the landing hero.
 *
 * The hero computer is small, so it runs four windows and nothing else:
 *
 *   Terminal   the demo shell — or the REAL PTY on your laptop once it is paired
 *   Connect    the real pairing flow (code + install command), see pairing/
 *   Agent      which CLI is selected, and a jump to the prompt composer
 *   About      what this machine is, and how to drive it
 *
 * `landing-page.tsx` owns the state (machine, pairing, CLI selection); this file
 * only turns it into `OsApp[]` for `components/computer/os/zero-os.tsx`.
 */

import { useRouter } from 'next/navigation'

import { ZeroOs, useOsApp, type OsApp } from '@/components/computer/os/zero-os'
import { OsButton, OsNote, OsPill } from '@/components/computer/os/os-ui'
import type { Machine } from '@/components/computer/hardware/use-machine'
import { DemoTerminal } from '@/components/terminal/demo-terminal'
import { MachineTerminal } from '@/components/terminal/machine-terminal'
import { PairPanel } from '@/components/pairing/pair-panel'
import type { Pairing } from '@/components/pairing/use-pairing'
import type { PairedMachine } from '@/lib/client/use-paired-machine'
import type { CliSelection } from '@/lib/client/use-cli-selection'

export function HeroOs({
  machine,
  pairing,
  paired,
  selection,
  onJump,
}: {
  machine: Machine
  pairing: Pairing
  paired: PairedMachine
  selection: CliSelection
  onJump(section: string): void
}) {
  const apps: OsApp[] = [
    {
      id: 'terminal',
      title: 'Terminal',
      short: 'Terminal',
      sprite: 'terminal',
      autostart: true,
      rect: { x: 16, y: 8, w: 76, h: 74 },
      status: paired.online ? `live · ${paired.hostname}` : 'demo shell',
      body: <HeroTerminal paired={paired} pairing={pairing} onJump={onJump} />,
    },
    {
      id: 'connect',
      title: 'Connect a laptop',
      short: 'Connect',
      sprite: 'connect',
      rect: { x: 10, y: 12, w: 80, h: 72 },
      status: pairing.status,
      body: (
        <PairPanel
          pairing={pairing}
          cliName={selection.profile.name}
          compact
          onChangeCli={() => onJump('agent')}
          onContinue={() => onJump('terminal')}
        />
      ),
    },
    {
      id: 'agent',
      title: `Agent — ${selection.profile.name}`,
      short: 'Agent',
      sprite: 'agent',
      rect: { x: 22, y: 14, w: 70, h: 66 },
      status: selection.deepResearch ? 'deep research on' : selection.profile.binary,
      body: <HeroAgent selection={selection} paired={paired} onJump={onJump} />,
    },
    {
      id: 'about',
      title: 'About Zero OS',
      short: 'About',
      sprite: 'computer',
      rect: { x: 12, y: 10, w: 74, h: 76 },
      body: <HeroAbout machine={machine} />,
    },
  ]

  return (
    <ZeroOs
      apps={apps}
      hostname={paired.online ? paired.hostname : 'ZERO-PC'}
      onShutdown={machine.actions.shutdown}
      onRestart={machine.actions.restart}
      onNotice={machine.actions.say}
      tray={
        <OsPill tone={paired.online ? 'good' : 'idle'}>{paired.online ? 'online' : 'demo'}</OsPill>
      }
    />
  )
}

function HeroTerminal({
  paired,
  pairing,
  onJump,
}: {
  paired: PairedMachine
  pairing: Pairing
  onJump(section: string): void
}) {
  const os = useOsApp()
  if (paired.hasSession && paired.online) {
    return (
      <MachineTerminal
        deviceId={paired.deviceId}
        phoneSecret={paired.phoneSecret}
        hostname={paired.hostname}
      />
    )
  }
  return (
    <DemoTerminal
      hostname="zero-os"
      installCommand={pairing.command}
      onPair={() => {
        os?.openApp('connect')
        onJump('pair')
      }}
      onOpenApp={(appId) => os?.openApp(appId)}
    />
  )
}

function HeroAgent({
  selection,
  paired,
  onJump,
}: {
  selection: CliSelection
  paired: PairedMachine
  onJump(section: string): void
}) {
  const router = useRouter()
  const os = useOsApp()
  return (
    <div className="os-pane">
      <div className="hero-agent-head">
        <img src={selection.profile.logo} alt="" width={22} height={22} />
        <div>
          <strong>{selection.profile.name}</strong>
          <OsNote>
            {selection.profile.binary}
            {selection.model ? ` · ${selection.model}` : ' · default model'}
          </OsNote>
        </div>
        {selection.deepResearch ? <OsPill tone="good">research</OsPill> : null}
      </div>
      <OsNote>
        Pick the CLI, the model and the flags downstairs — then type what you want in plain English and it
        goes straight to that CLI on your laptop.
      </OsNote>
      <div className="os-actions">
        <OsButton
          variant="primary"
          onClick={() => {
            os?.closeApp('agent')
            onJump('prompt')
          }}
        >
          Send a prompt ↓
        </OsButton>
        <OsButton
          onClick={() => {
            os?.closeApp('agent')
            onJump('agent')
          }}
        >
          Change CLI
        </OsButton>
        {paired.hasSession ? (
          <OsButton onClick={() => router.push('/console')}>Full desktop →</OsButton>
        ) : (
          <OsButton
            onClick={() => {
              os?.openApp('connect')
            }}
          >
            Connect…
          </OsButton>
        )}
      </div>
    </div>
  )
}

function HeroAbout({ machine }: { machine: Machine }) {
  return (
    <div className="os-pane">
      <p className="about-title">Zero OS 1.0</p>
      <OsNote>
        A 90s operating shell around a very modern idea: the laptop you already own does the work, and
        this screen is only a remote control for it.
      </OsNote>
      <ul className="about-list">
        <li>
          <strong>Power</strong> ⏻ boots the machine, or shuts it down with the classic safe-to-power-off
          screen. <strong>RST</strong> cold reboots.
        </li>
        <li>
          <strong>Keyboard</strong> every cap works: Shift and Caps latch, ENTER submits, and typing on a
          real keyboard lights the caps here.
        </li>
        <li>
          <strong>Mouse</strong> drag it to move the pointer, left button clicks, right button opens the
          desktop menu, the wheel scrolls. Tap the glass directly on a phone.
        </li>
        <li>
          <strong>Windows</strong> drag the title bar, □ maximizes, _ minimizes, ✕ closes. Start ▸ Arrange
          cascades them. Pointer is in {machine.pointerMode === 'direct' ? 'direct' : 'trackpad'} mode.
        </li>
      </ul>
      <OsNote>Everything here is state: no video, no canvas, no images of an interface.</OsNote>
    </div>
  )
}
