'use client'

// The console: a Win95 desktop on the CRT, one window per app.
//
//   Agent          — prompt the coding CLI on the laptop (agent/agent-window)
//   Terminal       — the real PTY over the encrypted relay (terminal/machine-terminal)
//   File Manager   — the laptop's disk (files/file-browser)
//   Control Panel  — CLI / project / mode settings (console/control-panel)
//
// This file owns only session bootstrap, device presence polling and which
// window is open. Everything with real behaviour lives in the pieces above.

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { AgentWindow } from '@/components/agent/agent-window'
import { useAgentConsole } from '@/components/agent/use-agent-console'
import { CdPlayer } from '@/components/desk/cd-player'
import { DeskComputer } from '@/components/desk/desk-computer'
import { ControlPanel } from '@/components/console/control-panel'
import { FileBrowser } from '@/components/files/file-browser'
import { MachineTerminal } from '@/components/terminal/machine-terminal'
import { Win95Desktop, Win95Icons, Win95Menu, Win95Taskbar, Win95Window } from '@/components/os/win95'
import { loadAccountMachines } from '@/lib/client/account'
import { playDing, playRecycle } from '@/lib/client/desk-sound'
import {
  clearForgeSession,
  readForgeSession,
  writeForgeSession,
  type ForgeSession,
} from '@/lib/client/forge-session'
import { cliOption } from '@/lib/shared/cli-catalog'

type DeskApp = 'desktop' | 'agent' | 'terminal' | 'files' | 'player' | 'setup' | 'computer'

type DeviceStatus = {
  device?: {
    name?: string
    online?: boolean
    daemonOnline?: boolean
  }
}

export function ConsoleFrame() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<ForgeSession | null>(null)
  const [online, setOnline] = useState(false)
  const [daemonOnline, setDaemonOnline] = useState(false)
  const [hostname, setHostname] = useState('Laptop')
  const [deskApp, setDeskApp] = useState<DeskApp>('desktop')
  const [startOpen, setStartOpen] = useState(false)
  const [clock, setClock] = useState('--:--')
  const [recycleNote, setRecycleNote] = useState('')

  const deviceId = session?.deviceId || ''
  const phoneSecret = session?.phoneSecret || ''

  const agent = useAgentConsole({ deviceId, phoneSecret, online, daemonOnline })

  // -- clock ------------------------------------------------------------------
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    tick()
    const timer = window.setInterval(tick, 10000)
    return () => window.clearInterval(timer)
  }, [])

  // -- session bootstrap: localStorage first, then the account ------------------
  useEffect(() => {
    const apply = (existing: ForgeSession) => {
      setSession(existing)
      setHostname(existing.hostname || 'Laptop')
      setReady(true)
    }
    const existing = readForgeSession()
    if (existing?.deviceId && existing.phoneSecret) {
      apply(existing)
      return
    }
    // New browser, signed-in user: restore the machine from the account.
    void loadAccountMachines().then((machines) => {
      const machine = machines[0]
      if (!machine) {
        router.replace('/')
        return
      }
      const restored: ForgeSession = {
        code: '',
        phoneSecret: machine.phone_secret,
        deviceId: machine.device_id,
        hostname: machine.name,
      }
      writeForgeSession(restored)
      apply(restored)
    })
  }, [router])

  // -- device presence ----------------------------------------------------------
  const refreshDevice = useCallback(async (active: ForgeSession) => {
    if (!active.deviceId || !active.phoneSecret) return
    try {
      const response = await fetch(`/api/devices/${active.deviceId}`, {
        headers: { Authorization: `Bearer ${active.phoneSecret}` },
        cache: 'no-store',
      })
      if (!response.ok) {
        setOnline(false)
        setDaemonOnline(false)
        return
      }
      const data = (await response.json()) as DeviceStatus
      setOnline(Boolean(data.device?.online))
      setDaemonOnline(Boolean(data.device?.daemonOnline))
      if (data.device?.name) {
        setHostname(data.device.name)
        writeForgeSession({ ...active, hostname: data.device.name, daemonOnline: Boolean(data.device.daemonOnline) })
      }
    } catch {
      setOnline(false)
      setDaemonOnline(false)
    }
  }, [])

  useEffect(() => {
    if (!session?.deviceId) return
    void refreshDevice(session)
    const timer = window.setInterval(() => void refreshDevice(session), 2500)
    return () => window.clearInterval(timer)
  }, [refreshDevice, session])

  // -- actions -------------------------------------------------------------------
  async function resetPairing() {
    try {
      if (session?.deviceId && session.phoneSecret) {
        await fetch(`/api/devices/${encodeURIComponent(session.deviceId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session.phoneSecret}` },
        })
      }
    } catch {
      // Local cleanup still prevents this browser from reusing the credential.
    }
    clearForgeSession()
    localStorage.removeItem('agentremote.profiles')
    router.replace('/')
  }

  function openApp(next: DeskApp) {
    setDeskApp(next)
    setStartOpen(false)
  }

  if (!ready) {
    return (
      <DeskComputer phosphor caption="Booting Forge OS">
        <p className="crt-boot-cursor p-3">Loading desktop...</p>
      </DeskComputer>
    )
  }

  const selected = cliOption(agent.provider)
  const emptyHint = !online
    ? 'Laptop is offline. Keep this tab open and the Forge bridge running on that machine.'
    : !daemonOnline
      ? 'Bridge is connected, but the local agent daemon is not ready yet. Re-run the install command if this stays unavailable.'
      : agent.cliMessage
        ? agent.cliMessage
        : `Ask ${selected.name}. Terminal is a real shell on this laptop.`
  const statusLine = `${online ? 'Online' : 'Offline'} · ${daemonOnline ? 'ready' : 'no daemon'} · ${selected.name}`

  return (
    <DeskComputer
      wallpaper
      busy={agent.working}
      caption="Your computer, in your pocket."
      onCd={() => openApp('player')}
      onReset={() => openApp('desktop')}
    >
      <Win95Desktop>
        {deskApp === 'desktop' ? (
          <Win95Icons
            items={[
              { id: 'agent', label: selected.name, icon: selected.logo, onClick: () => openApp('agent') },
              { id: 'terminal', label: 'Terminal', onClick: () => openApp('terminal') },
              { id: 'files', label: 'File Manager', onClick: () => openApp('files') },
              { id: 'player', label: 'CD Player', onClick: () => openApp('player') },
              { id: 'computer', label: 'My Computer', onClick: () => openApp('computer') },
              {
                id: 'recycle',
                label: 'Recycle Bin',
                onClick: () => {
                  void playRecycle()
                  setRecycleNote('Recycle Bin is empty.')
                  void playDing()
                },
              },
              { id: 'setup', label: 'Control Panel', onClick: () => openApp('setup') },
            ]}
          />
        ) : null}
        {deskApp === 'agent' ? (
          <Win95Window title={`${selected.name} — Agent`} status={statusLine} onClose={() => openApp('desktop')}>
            <AgentWindow
              agent={agent}
              agentName={selected.name}
              online={online}
              daemonOnline={daemonOnline}
              emptyHint={emptyHint}
            />
          </Win95Window>
        ) : null}
        {deskApp === 'terminal' && deviceId && phoneSecret ? (
          <Win95Window title="Terminal" status={agent.cwd || hostname} onClose={() => openApp('desktop')}>
            <MachineTerminal deviceId={deviceId} phoneSecret={phoneSecret} cwd={agent.cwd} hostname={hostname} />
          </Win95Window>
        ) : null}
        {deskApp === 'files' && deviceId && phoneSecret ? (
          <Win95Window title="File Manager" status={hostname} onClose={() => openApp('desktop')}>
            <FileBrowser deviceId={deviceId} phoneSecret={phoneSecret} initialPath={agent.cwd || undefined} />
          </Win95Window>
        ) : null}
        {deskApp === 'player' ? (
          <Win95Window title="CD Player" status="MIDI" onClose={() => openApp('desktop')}>
            <CdPlayer />
          </Win95Window>
        ) : null}
        {deskApp === 'computer' ? (
          <Win95Window title="My Computer" status={hostname} onClose={() => openApp('desktop')}>
            <div className="os-pane">
              <p>{hostname}</p>
              <p>{statusLine}</p>
              <p>{agent.cwd || 'Waiting for laptop home directory.'}</p>
              {recycleNote ? <p>{recycleNote}</p> : null}
            </div>
          </Win95Window>
        ) : null}
        {deskApp === 'setup' ? (
          <Win95Window title="Control Panel" status={statusLine} onClose={() => openApp('desktop')}>
            <ControlPanel agent={agent} fallbackProvider={selected.id} onResetPairing={() => void resetPairing()} />
          </Win95Window>
        ) : null}
        {startOpen ? (
          <Win95Menu
            items={[
              { id: 'agent', label: selected.name, onClick: () => openApp('agent') },
              { id: 'terminal', label: 'Terminal', onClick: () => openApp('terminal') },
              { id: 'files', label: 'File Manager', onClick: () => openApp('files') },
              { id: 'player', label: 'CD Player', onClick: () => openApp('player') },
              { id: 'setup', label: 'Control Panel', onClick: () => openApp('setup') },
              { id: 'desktop', label: 'Desktop', onClick: () => openApp('desktop') },
            ]}
          />
        ) : null}
        <Win95Taskbar
          startOpen={startOpen}
          onToggleStart={() => setStartOpen((open) => !open)}
          clock={clock}
          items={[
            { id: 'agent', label: 'Agent', active: deskApp === 'agent', onClick: () => openApp('agent') },
            { id: 'terminal', label: 'Terminal', active: deskApp === 'terminal', onClick: () => openApp('terminal') },
            { id: 'files', label: 'Files', active: deskApp === 'files', onClick: () => openApp('files') },
            { id: 'player', label: 'CD', active: deskApp === 'player', onClick: () => openApp('player') },
          ]}
        />
      </Win95Desktop>
    </DeskComputer>
  )
}
