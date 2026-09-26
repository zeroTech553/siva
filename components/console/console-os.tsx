'use client'

/**
 * console-os.tsx — the desktop you get at /console once a laptop is paired.
 *
 * Six windows, one per thing you can actually do with the machine:
 *
 *   Terminal      the real PTY over the encrypted relay
 *   Agent         the CLI conversation: transcript, permissions, questions
 *   Files         the laptop's disk (read, open, download)
 *   Prompt        plain English → the CLI of your choice, with model + flags
 *   Control Panel CLI / folder / permission mode, and unpair
 *   CD Player     the tray on the front of the computer (Start ▸ Programs)
 *
 * console-frame.tsx owns the session and the agent state; this file only turns
 * them into `OsApp[]` for the window manager.
 */

import { ZeroOs, useOsApp, type OsApp } from '@/components/computer/os/zero-os'
import { OsNote, OsPill } from '@/components/computer/os/os-ui'
import { AgentWindow } from '@/components/agent/agent-window'
import type { AgentConsole } from '@/components/agent/use-agent-console'
import type { Machine } from '@/components/computer/hardware/use-machine'
import { CdPlayer } from '@/components/console/cd-player'
import { ControlPanel } from '@/components/console/control-panel'
import { PromptComposer } from '@/components/cli/prompt-composer'
import { FileBrowser } from '@/components/files/file-browser'
import { MachineTerminal } from '@/components/terminal/machine-terminal'
import type { CliSelection } from '@/lib/client/use-cli-selection'
import type { PairedMachine } from '@/lib/client/use-paired-machine'
import { cliProfile } from '@/lib/shared/cli-flags'

export function ConsoleOs({
  machine,
  paired,
  agent,
  selection,
  onUnpair,
}: {
  machine: Machine
  paired: PairedMachine
  agent: AgentConsole
  selection: CliSelection
  /** DELETE the device on the relay, clear local state, back to the landing page. */
  onUnpair(): void
}) {
  const selected = cliProfile(agent.provider || selection.cli)
  const statusLine = `${paired.online ? 'online' : 'offline'} · ${paired.daemonOnline ? 'daemon ready' : 'no daemon'} · ${selected.name}`

  const emptyHint = !paired.online
    ? 'The laptop is offline. Keep this tab open and the Forge bridge running on that machine.'
    : !paired.daemonOnline
      ? 'The bridge is connected but the local agent daemon is not answering yet. Re-run the install command if this stays unavailable.'
      : agent.cliMessage || `Ask ${selected.name}. The Terminal window is a real shell on that laptop.`

  const apps: OsApp[] = [
    {
      id: 'terminal',
      title: `Terminal — ${paired.hostname || 'laptop'}`,
      short: 'Terminal',
      sprite: 'terminal',
      autostart: true,
      rect: { x: 10, y: 6, w: 72, h: 78 },
      status: agent.cwd || statusLine,
      body: (
        <MachineTerminal
          deviceId={paired.deviceId}
          phoneSecret={paired.phoneSecret}
          cwd={agent.cwd}
          hostname={paired.hostname}
        />
      ),
    },
    {
      id: 'agent',
      title: `${selected.name} — Agent`,
      short: 'Agent',
      sprite: 'agent',
      autostart: true,
      rect: { x: 24, y: 14, w: 70, h: 74 },
      status: statusLine,
      body: (
        <AgentWindow
          agent={agent}
          agentName={selected.name}
          online={paired.online}
          daemonOnline={paired.daemonOnline}
          emptyHint={emptyHint}
        />
      ),
    },
    {
      id: 'files',
      title: 'File Manager',
      short: 'Files',
      sprite: 'files',
      rect: { x: 16, y: 10, w: 76, h: 76 },
      status: paired.hostname || 'laptop disk',
      body: (
        <FileBrowser
          deviceId={paired.deviceId}
          phoneSecret={paired.phoneSecret}
          initialPath={agent.cwd || undefined}
        />
      ),
    },
    {
      id: 'prompt',
      title: 'Send a prompt',
      short: 'Prompt',
      sprite: 'research',
      rect: { x: 18, y: 16, w: 78, h: 72 },
      status: `${selection.profile.name}${selection.deepResearch ? ' · research' : ''}`,
      body: <ConsolePrompt paired={paired} selection={selection} agent={agent} />,
    },
    {
      id: 'setup',
      title: 'Control Panel',
      short: 'Setup',
      sprite: 'setup',
      rect: { x: 26, y: 18, w: 66, h: 68 },
      status: statusLine,
      body: <ControlPanel agent={agent} fallbackProvider={selected.id} onResetPairing={onUnpair} />,
    },
    {
      id: 'player',
      title: 'CD Player',
      short: 'CD',
      sprite: 'player',
      desktopIcon: false,
      rect: { x: 30, y: 22, w: 58, h: 54 },
      status: 'MIDI',
      body: <CdPlayer />,
    },
  ]

  return (
    <ZeroOs
      apps={apps}
      hostname={paired.online ? paired.hostname : 'ZERO-PC'}
      tray={
        <>
          <OsPill tone={paired.online ? 'good' : 'bad'}>{paired.online ? 'laptop online' : 'laptop offline'}</OsPill>
          <OsPill tone={paired.daemonOnline ? 'good' : 'warn'}>
            {paired.daemonOnline ? 'daemon ready' : 'no daemon'}
          </OsPill>
          {agent.working ? <OsPill tone="warn">working</OsPill> : null}
        </>
      }
      onShutdown={machine.actions.shutdown}
      onRestart={machine.actions.restart}
      onNotice={machine.actions.say}
    />
  )
}

/**
 * The Prompt window shares the console's agent instance (so the laptop is never
 * polled twice) and points "no laptop" at the Control Panel instead of at the
 * landing page's pairing section.
 */
function ConsolePrompt({
  paired,
  selection,
  agent,
}: {
  paired: PairedMachine
  selection: CliSelection
  agent: AgentConsole
}) {
  const os = useOsApp()
  return (
    <div className="console-prompt">
      <PromptComposer
        paired={paired}
        selection={selection}
        agent={agent}
        compact
        onNeedMachine={() => os?.openApp('setup')}
      />
      <OsNote>
        Enter sends, Shift+Enter makes a new line. The Agent window shows the same conversation with the
        full transcript, permission prompts and questions.
      </OsNote>
    </div>
  )
}
