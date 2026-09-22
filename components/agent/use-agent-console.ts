'use client'

// All agent-console state and actions for one paired machine: daemon ping,
// providers, projects, the running job, its event stream, and the pending
// permission / question prompts. The UI for it lives in agent-window.tsx;
// console-frame.tsx only decides *when* the window is shown.

import { useEffect, useRef, useState } from 'react'

import { DeviceRpcError, deviceRpc } from '@/lib/client/device-rpc'
import { readConsolePrefs, writeConsolePrefs } from '@/lib/client/forge-session'
import { playError } from '@/lib/client/desk-sound'
import {
  cliSetupMessage,
  jobIsActive,
  optionLabel,
  pickReadyProvider,
  providerLabel,
  readyProviders,
  type DaemonQuestion,
  type JobEvent,
  type JobSnapshot,
  type PingResponse,
  type Project,
} from '@/lib/shared/daemon'

export type AgentConsole = ReturnType<typeof useAgentConsole>

export function useAgentConsole({
  deviceId,
  phoneSecret,
  online,
  daemonOnline,
}: {
  deviceId: string
  phoneSecret: string
  online: boolean
  daemonOnline: boolean
}) {
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
  const seqRef = useRef(0)

  // Restore saved preferences once.
  useEffect(() => {
    const prefs = readConsolePrefs()
    if (prefs.cwd) setCwd(prefs.cwd)
    if (prefs.provider) setProvider(prefs.provider)
    if (prefs.sessionId) setSessionId(prefs.sessionId)
  }, [])

  // Scan the daemon when it comes up: providers, projects, home directory.
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
        const machine: Project = { id: 'laptop-home', cwd: home, name: 'This laptop' }
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

  // Poll the running job for events and pending prompts.
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

  function updateCwd(next: string) {
    setCwd(next)
    setSessionId('')
    writeConsolePrefs({ cwd: next, provider, sessionId: '' })
  }

  function updateProvider(next: string) {
    setProvider(next)
    setCliMessage(cliSetupMessage(ping, next))
    writeConsolePrefs({ cwd, provider: next, sessionId })
  }

  function startNewChat() {
    setSessionId('')
    setJobId('')
    setJob(null)
    setEvents([])
    seqRef.current = 0
    writeConsolePrefs({ cwd, provider, sessionId: '' })
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
      const queue = selected ? [selected, ...candidates.filter((name) => name !== selected)] : candidates
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
              body: JSON.stringify({ prompt: text, cwd: workingDir, permission_mode: mode, provider: name }),
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

  const running = jobIsActive(job?.status)
  const working = sending || running || Boolean(jobId && (!job || jobIsActive(job.status)))

  return {
    // state
    ping,
    projects,
    cwd,
    provider,
    permissionMode,
    cliMessage,
    sessionId,
    prompt,
    job,
    events,
    error,
    working,
    // actions
    setPrompt,
    setCwd,
    setPermissionMode,
    updateCwd,
    updateProvider,
    startNewChat,
    sendPrompt,
    stopJob,
    answerPermission,
    answerQuestion,
    cancelQuestion,
  }
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
  // The bridge answers this directly (no shell involved) on current installs.
  try {
    const roots = await deviceRpc<{ home?: string }>(deviceId, phoneSecret, '/api/fs/roots', {
      method: 'POST',
      body: '{}',
    })
    if (roots.home && looksLikeHome(roots.home)) return roots.home
  } catch {
    // Older bridge without the files API; probe through the daemon shell.
  }
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
