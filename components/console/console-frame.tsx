'use client'

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { CdPlayer } from '@/components/desk/cd-player'
import { ConsoleTranscript } from '@/components/agent/console-transcript'
import { DeskComputer } from '@/components/desk/desk-computer'
import { FileBrowser } from '@/components/files/file-browser'
import { MachineTerminal } from '@/components/terminal/machine-terminal'
import { Win95Button, Win95Desktop, Win95Icons, Win95Menu, Win95Taskbar, Win95Window } from '@/components/os/win95'
import { cliOption } from '@/lib/shared/cli-catalog'
import { playDing, playError, playRecycle } from '@/lib/client/desk-sound'
import {
  PERMISSION_MODES,
  cliSetupMessage,
  jobIsActive,
  optionLabel,
  pickReadyProvider,
  pingProviders,
  providerLabel,
  readyProviders,
  questionLabel,
  type DaemonQuestion,
  type JobEvent,
  type JobSnapshot,
  type PingResponse,
  type Project,
} from '@/lib/shared/daemon'
import { DeviceRpcError, deviceRpc } from '@/lib/client/device-rpc'
import { loadAccountMachines } from '@/lib/client/account'
import {
  clearForgeSession,
  readConsolePrefs,
  readForgeSession,
  writeConsolePrefs,
  writeForgeSession,
  type ForgeSession,
} from '@/lib/client/forge-session'

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
  const [ping, setPing] = useState<PingResponse | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [cwd, setCwd] = useState('')
  const [provider, setProvider] = useState('')
  const [permissionMode, setPermissionMode] = useState('bypassPermissions')
  const [cliMessage, setCliMessage] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [jobId, setJobId] = useState('')
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [events, setEvents] = useState<JobEvent[]>([])
  const [error, setError] = useState('')
  const [answering, setAnswering] = useState(false)
  const [deskApp, setDeskApp] = useState<'desktop' | 'agent' | 'terminal' | 'files' | 'player' | 'setup' | 'computer'>('desktop')
  const [startOpen, setStartOpen] = useState(false)
  const [clock, setClock] = useState('--:--')
  const [recycleNote, setRecycleNote] = useState('')
  const seqRef = useRef(0)
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    tick()
    const timer = window.setInterval(tick, 10000)
    return () => window.clearInterval(timer)
  }, [])

  const deviceId = session?.deviceId || ''
  const phoneSecret = session?.phoneSecret || ''

  useEffect(() => {
    const apply = (existing: ForgeSession) => {
      const prefs = readConsolePrefs()
      setSession(existing)
      setHostname(existing.hostname || 'Laptop')
      if (prefs.cwd) setCwd(prefs.cwd)
      if (prefs.provider) setProvider(prefs.provider)
      if (prefs.sessionId) setSessionId(prefs.sessionId)
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

  useEffect(() => {
    if (!deviceId || !phoneSecret || !daemonOnline) return
    let cancelled = false
    const load = async () => {
      try {
        const nextPing = await deviceRpc<PingResponse>(deviceId, phoneSecret, '/api/ping')
        if (cancelled) return
        setPing(nextPing)
        const nextProvider = pickReadyProvider(nextPing)
        const chosenProvider = readConsolePrefs().provider || nextProvider
        setProvider((current) => current || nextProvider)
        setCliMessage(cliSetupMessage(nextPing, chosenProvider))
        const projectData = await deviceRpc<{ projects?: Project[] }>(deviceId, phoneSecret, '/api/projects')
        if (cancelled) return
        const home = await resolveLaptopHome(deviceId, phoneSecret)
        if (cancelled) return
        const listed = projectData.projects ?? []
        const machine: Project = {
          id: 'laptop-home',
          cwd: home,
          name: 'This laptop',
        }
        const nextProjects = home
          ? [machine, ...listed.filter((project) => normalizePath(project.cwd) !== normalizePath(home))]
          : listed
        setProjects(nextProjects)
        setCwd((current) => current || home || nextProjects[0]?.cwd || '')
        setError('')
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof DeviceRpcError ? cause.message : 'Could not reach the local daemon.')
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [daemonOnline, deviceId, phoneSecret])

  useEffect(() => {
    if (!deviceId || !phoneSecret || !jobId) return
    let cancelled = false
    let timer = 0
    const stop = () => {
      cancelled = true
      window.clearInterval(timer)
    }
    const tick = async () => {
      try {
        const snapshot = await deviceRpc<JobSnapshot>(
          deviceId,
          phoneSecret,
          `/api/jobs/${encodeURIComponent(jobId)}?since=${seqRef.current}`,
        )
        if (cancelled) return
        if (snapshot.events?.length) {
          setEvents((current) => mergeEvents(current, snapshot.events))
        }
        seqRef.current = snapshot.next_seq ?? seqRef.current
        setJob(snapshot)
        const nextSessionId = snapshot.new_session_id || snapshot.session_id
        if (nextSessionId) {
          setSessionId(nextSessionId)
          writeConsolePrefs({ cwd, provider, sessionId: nextSessionId })
        }
        if (!jobIsActive(snapshot.status)) {
          if (snapshot.error) setError(snapshot.error)
          stop()
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof DeviceRpcError ? cause.message : 'Job status is unavailable.')
          if (cause instanceof DeviceRpcError && cause.status === 404) stop()
        }
      }
    }
    timer = window.setInterval(() => void tick(), 250)
    void tick()
    return stop
  }, [cwd, deviceId, jobId, phoneSecret, provider])

  useEffect(() => {
    const node = transcriptRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [events, job?.pending_permission, job?.pending_question])

  function updateCwd(next: string) {
    setCwd(next)
    setSessionId('')
    writeConsolePrefs({ cwd: next, provider, sessionId: '' })
  }

  async function sendPrompt() {
    const text = prompt.trim()
    if (!text || sending || !deviceId || !phoneSecret) return
    if (!online) {
      setError('Laptop is offline. Keep the Forge bridge running on that machine.')
      return
    }
    if (!daemonOnline) {
      setError('The laptop is online, but the local agent daemon did not answer. Re-run the install command so the daemon and bridge restart.')
      return
    }
    const workingDir = cwd.trim()
    if (!workingDir) {
      setError('The laptop home directory is not available yet. Wait for Daemon ready, then send again.')
      return
    }
    setSending(true)
    setError('')
    setEvents((current) => [...current, { seq: -Date.now(), kind: 'user', text }])
    try {
      let nextPing = ping
      try {
        nextPing = await deviceRpc<PingResponse>(deviceId, phoneSecret, '/api/ping')
        setPing(nextPing)
      } catch {
        // Use the last ping if a fresh scan fails.
      }
      const candidates = readyProviders(nextPing)
      const selected = provider && candidates.includes(provider) ? provider : pickReadyProvider(nextPing)
      const queue = selected
        ? [selected, ...candidates.filter((name) => name !== selected)]
        : candidates
      if (!queue.length) {
        setError('No coding CLI is available on this laptop yet. Re-run pairing and pick a CLI.')
        return
      }
      setCliMessage(cliSetupMessage(nextPing, queue[0]))
      const mode = permissionMode || 'bypassPermissions'
      let lastError = ''
      for (const name of queue) {
        try {
          let result: { job_id?: string }
          if (sessionId && name === selected) {
            result = await deviceRpc<{ job_id?: string }>(
              deviceId,
              phoneSecret,
              `/api/sessions/${encodeURIComponent(sessionId)}/continue`,
              { method: 'POST', body: JSON.stringify({ prompt: text, permission_mode: mode }) },
            )
          } else {
            result = await deviceRpc<{ job_id?: string }>(deviceId, phoneSecret, '/api/sessions/new', {
              method: 'POST',
              body: JSON.stringify({
                prompt: text,
                cwd: workingDir,
                permission_mode: mode,
                provider: name,
              }),
            })
          }
          if (!result.job_id) throw new Error('The daemon did not return a job id.')
          setProvider(name)
          setPrompt('')
          seqRef.current = 0
          setJob(null)
          setJobId(result.job_id)
          writeConsolePrefs({ cwd: workingDir, provider: name, sessionId: name === selected ? sessionId : '' })
          if (name !== selected) setSessionId('')
          return
        } catch (cause) {
          const message = cause instanceof DeviceRpcError ? cause.message : 'Could not send the prompt to the laptop.'
          lastError = `${providerLabel(name)}: ${message}`
          const missing = /failed to launch|not found|WinError 2|cannot find|missing/i.test(message)
          if (!missing && !(cause instanceof DeviceRpcError && cause.status === 404)) {
            setError(lastError)
            return
          }
        }
      }
      setError(lastError || 'No installed CLI could start this prompt.')
      void playError()
    } finally {
      setSending(false)
    }
  }

  async function stopJob() {
    if (!jobId || !deviceId || !phoneSecret) return
    try {
      await deviceRpc(deviceId, phoneSecret, `/api/jobs/${encodeURIComponent(jobId)}/stop`, {
        method: 'POST',
        body: '{}',
      })
    } catch (cause) {
      setError(cause instanceof DeviceRpcError ? cause.message : 'Could not stop the job.')
    }
  }

  async function answerPermission(allow: boolean) {
    const pending = job?.pending_permission
    if (!pending || !jobId || answering) return
    setAnswering(true)
    try {
      await deviceRpc(deviceId, phoneSecret, `/api/jobs/${encodeURIComponent(jobId)}/permission`, {
        method: 'POST',
        body: JSON.stringify({ request_id: pending.request_id, allow }),
      })
    } catch (cause) {
      setError(cause instanceof DeviceRpcError ? cause.message : 'Could not answer the permission prompt.')
    } finally {
      setAnswering(false)
    }
  }

  async function answerQuestion(question: DaemonQuestion, label: string) {
    const pending = job?.pending_question
    if (!pending || !jobId || answering) return
    setAnswering(true)
    try {
      const answers = (pending.questions || [question]).map((item) =>
        item === question ? [label] : [optionLabel((item.options || [])[0] || 'Skip')],
      )
      await deviceRpc(deviceId, phoneSecret, `/api/jobs/${encodeURIComponent(jobId)}/question`, {
        method: 'POST',
        body: JSON.stringify({ request_id: pending.request_id, answers }),
      })
    } catch (cause) {
      setError(cause instanceof DeviceRpcError ? cause.message : 'Could not answer the agent question.')
    } finally {
      setAnswering(false)
    }
  }

  async function cancelQuestion() {
    const pending = job?.pending_question
    if (!pending || !jobId || answering) return
    setAnswering(true)
    try {
      await deviceRpc(deviceId, phoneSecret, `/api/jobs/${encodeURIComponent(jobId)}/question`, {
        method: 'POST',
        body: JSON.stringify({ request_id: pending.request_id, cancel: true }),
      })
    } catch (cause) {
      setError(cause instanceof DeviceRpcError ? cause.message : 'Could not cancel the question.')
    } finally {
      setAnswering(false)
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    void sendPrompt()
  }

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

  function startNewChat() {
    setSessionId('')
    setJobId('')
    setJob(null)
    setEvents([])
    seqRef.current = 0
    writeConsolePrefs({ cwd, provider, sessionId: '' })
  }

  if (!ready) {
    return (
      <DeskComputer phosphor caption="Booting Forge OS">
        <p className="crt-boot-cursor p-3">Loading desktop...</p>
      </DeskComputer>
    )
  }

  const running = jobIsActive(job?.status)
  const working = sending || running || Boolean(jobId && (!job || jobIsActive(job.status)))
  const providers = pingProviders(ping)
  const selected = cliOption(provider)
  const emptyHint = !online
    ? 'Laptop is offline. Keep this tab open and the Forge bridge running on that machine.'
    : !daemonOnline
      ? 'Bridge is connected, but the local agent daemon is not ready yet. Re-run the install command if this stays unavailable.'
      : cliMessage
        ? cliMessage
        : `Ask ${selected.name}. Terminal is a real shell on this laptop.`
  const statusLine = `${online ? 'Online' : 'Offline'} · ${daemonOnline ? 'ready' : 'no daemon'} · ${selected.name}`

  function openApp(next: typeof deskApp) {
    setDeskApp(next)
    setStartOpen(false)
  }

  return (
    <DeskComputer
      wallpaper
      busy={working}
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
            <div className="flex h-full min-h-0 flex-col">
              <div ref={transcriptRef} className="forge-work-log">
                <ConsoleTranscript events={events} emptyHint={emptyHint} />
                {job?.pending_permission ? (
                  <section className="forge-ask">
                    <p>
                      Allow {job.pending_permission.tool_name || 'this tool'}
                      {job.pending_permission.detail ? ` — ${job.pending_permission.detail}` : ''}?
                    </p>
                    <div>
                      <Win95Button onClick={() => void answerPermission(true)}>Allow</Win95Button>
                      <Win95Button onClick={() => void answerPermission(false)}>Deny</Win95Button>
                    </div>
                  </section>
                ) : null}
                {job?.pending_question?.questions?.length ? (
                  <section className="forge-ask">
                    {job.pending_question.questions.map((question, index) => (
                      <div key={`${job.pending_question?.request_id}-${index}`}>
                        <p>{questionLabel(question)}</p>
                        <div>
                          {(question.options || []).map((option) => {
                            const label = optionLabel(option)
                            return (
                              <Win95Button key={label} onClick={() => void answerQuestion(question, label)}>
                                {label}
                              </Win95Button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                    <Win95Button onClick={() => void cancelQuestion()}>Skip</Win95Button>
                  </section>
                ) : null}
              </div>
              {error ? <p className="forge-work-error">{error}</p> : null}
              <form
                className="forge-prompt"
                onSubmit={(event) => {
                  event.preventDefault()
                  void sendPrompt()
                }}
              >
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder={daemonOnline ? `Ask ${selected.name}…` : 'Waiting for the laptop daemon…'}
                  disabled={!online}
                  aria-label="Prompt"
                />
                {working ? (
                  <Win95Button onClick={() => void stopJob()}>Stop</Win95Button>
                ) : (
                  <Win95Button type="submit">Send</Win95Button>
                )}
              </form>
            </div>
          </Win95Window>
        ) : null}
        {deskApp === 'terminal' && deviceId && phoneSecret ? (
          <Win95Window title="Terminal" status={cwd || hostname} onClose={() => openApp('desktop')}>
            <MachineTerminal deviceId={deviceId} phoneSecret={phoneSecret} cwd={cwd} hostname={hostname} />
          </Win95Window>
        ) : null}
        {deskApp === 'files' && deviceId && phoneSecret ? (
          <Win95Window title="File Manager" status={hostname} onClose={() => openApp('desktop')}>
            <FileBrowser deviceId={deviceId} phoneSecret={phoneSecret} initialPath={cwd || undefined} />
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
              <p>{cwd || 'Waiting for laptop home directory.'}</p>
              {recycleNote ? <p>{recycleNote}</p> : null}
            </div>
          </Win95Window>
        ) : null}
        {deskApp === 'setup' ? (
          <Win95Window title="Control Panel" status={statusLine} onClose={() => openApp('desktop')}>
            <div className="os-pane">
              <label>
                CLI
                <select
                  value={provider}
                  onChange={(event) => {
                    const next = event.target.value
                    setProvider(next)
                    setCliMessage(cliSetupMessage(ping, next))
                    writeConsolePrefs({ cwd, provider: next, sessionId })
                  }}
                >
                  {(providers.length ? providers : [selected.id]).map((name) => (
                    <option key={name} value={name}>
                      {providerLabel(name)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Project
                <select value={cwd} onChange={(event) => updateCwd(event.target.value)}>
                  {projects.map((project) => (
                    <option key={project.id} value={project.cwd}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Directory
                <input value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label="Working directory" />
              </label>
              <label>
                Mode
                <select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value)}>
                  {PERMISSION_MODES.map((mode) => (
                    <option key={mode.id || 'default'} value={mode.id}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>
              {cliMessage ? <p>{cliMessage}</p> : null}
              <div className="os-actions">
                <Win95Button onClick={startNewChat}>New chat</Win95Button>
                <Win95Button onClick={() => void resetPairing()}>Reset pairing</Win95Button>
              </div>
            </div>
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

function mergeEvents(current: JobEvent[], incoming: JobEvent[]) {
  const seen = new Set(current.map((event) => `${event.seq}:${event.kind}:${event.text || event.name || ''}`))
  const next = [...current]
  for (const event of incoming) {
    const key = `${event.seq}:${event.kind}:${event.text || event.name || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    next.push(event)
  }
  return next
}

function normalizePath(value: string) {
  return value.replace(/[\\/]+$/, '').toLowerCase()
}

function looksLikeHome(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/error|traceback|not recognized|cannot find/i.test(trimmed)) return false
  return trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)
}

async function resolveLaptopHome(deviceId: string, phoneSecret: string) {
  const commands = [
    'python -c "import os; print(os.path.expanduser(chr(126)))"',
    'py -3 -c "import os; print(os.path.expanduser(chr(126)))"',
    'echo %USERPROFILE%',
    'printf %s "$HOME"',
  ]
  for (const command of commands) {
    try {
      const result = await deviceRpc<{ output?: string }>(deviceId, phoneSecret, '/api/shell', {
        method: 'POST',
        body: JSON.stringify({ command }),
      })
      const line = (result.output || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
        .pop()
      if (line && looksLikeHome(line)) return line
    } catch {
      // Try the next home-detection command.
    }
  }
  return ''
}
