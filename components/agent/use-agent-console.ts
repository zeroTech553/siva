'use client'

// All agent-console state and actions for one paired machine: daemon ping,
// providers, projects, the running job, its event stream, and the pending
// permission / question prompts. The UI for it lives in agent-window.tsx;
// console-frame.tsx only decides *when* the window is shown.

import { useEffect, useRef, useState } from 'react'

import { DeviceRpcError, deviceRpc } from '@/lib/client/device-rpc'
import { readConsolePrefs, writeConsolePrefs } from '@/lib/client/forge-session'
import { startPolitePolling } from '@/lib/client/polite-polling'
import { playError } from '@/lib/client/zero-sound'
import { cliProfile } from '@/lib/shared/cli-flags'
import { JOB_POLL_SCHEDULE } from '@/lib/shared/poll-schedule'
import {
  cliSetupMessage,
  jobIsActive,
  optionLabel,
  pickReadyProvider,
  providerLabel,
  readyProviders,
  wirePermissionMode,
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
  // The job poll writes prefs, but must not restart when cwd/provider change
  // (restarting would lose the event cursor), so it reads them from a ref.
  const prefsRef = useRef({ cwd: '', provider: '' })
  prefsRef.current = { cwd, provider }

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

  // Stream the running job. This used to be a 250ms setInterval — four
  // serverless invocations a second, running even with the tab in the
  // background. It now goes through startPolitePolling: adaptive backoff while
  // the CLI is thinking, zero requests while hidden, an immediate tick on
  // refocus, and no overlapping requests.
  useEffect(() => {
    if (!deviceId || !phoneSecret || !jobId) return
    const poll = startPolitePolling<JobSnapshot>({
      name: `job ${jobId}`,
      schedule: JOB_POLL_SCHEDULE,
      run: () =>
        deviceRpc<JobSnapshot>(
          deviceId,
          phoneSecret,
          `/api/jobs/${encodeURIComponent(jobId)}?since=${seqRef.current}`,
        ),
      // A change is "more events" or "different status"; otherwise back off.
      changed: (previous, next) =>
        !previous ||
        (previous.next_seq ?? 0) !== (next.next_seq ?? 0) ||
        previous.status !== next.status ||
        Boolean(next.pending_permission) !== Boolean(previous.pending_permission) ||
        Boolean(next.pending_question) !== Boolean(previous.pending_question),
      onValue: (snapshot) => {
        if (snapshot.events?.length) {
          setEvents((current) => mergeEvents(current, snapshot.events))
        }
        seqRef.current = snapshot.next_seq ?? seqRef.current
        setJob(snapshot)
        const nextSessionId = snapshot.new_session_id || snapshot.session_id
        // Remembering a session the CLI cannot resume would make the next
        // prompt look like a continuation that never happens.
        if (nextSessionId && cliProfile(prefsRef.current.provider).canResume) {
          setSessionId(nextSessionId)
          writeConsolePrefs({ cwd: prefsRef.current.cwd, provider: prefsRef.current.provider, sessionId: nextSessionId })
        }
        if (!jobIsActive(snapshot.status)) {
          if (snapshot.error) setError(snapshot.error)
          poll.stop() // job finished: stop spending invocations
        }
      },
      onError: (cause) => {
        setError(cause instanceof DeviceRpcError ? cause.message : 'Job status is unavailable.')
        if (cause instanceof DeviceRpcError && cause.status === 404) poll.stop()
      },
    })
    return () => poll.stop()
  }, [deviceId, jobId, phoneSecret])

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

  /**
   * Send one turn to the laptop.
   *
   * `overrides` exists for callers that build a prompt somewhere else (the
   * landing page's "Send a prompt" section): React state updates are async, so
   * a caller that just did setCwd()/setPermissionMode() would otherwise send
   * the previous values. Pass what you mean, explicitly.
   */
  async function sendPrompt(overrides?: {
    text?: string
    cwd?: string
    permissionMode?: string
    provider?: string
    /**
     * The model the visitor picked (lib/client/use-cli-selection.ts). The daemon
     * accepts it on both job routes and hands it to the CLI (`--model` / `-m`);
     * without it every job ran the CLI's own default, whatever the picker said.
     */
    model?: string
  }) {
    const text = (overrides?.text ?? prompt).trim()
    if (!text || sending || !deviceId || !phoneSecret) return
    if (!online) {
      setError('Laptop is offline. Keep the Forge bridge running on that machine.')
      return
    }
    if (!daemonOnline) {
      setError('The laptop is online, but the local agent daemon did not answer. Re-run the install command so the daemon and bridge restart.')
      return
    }
    const workingDir = (overrides?.cwd ?? cwd).trim()
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
      const requested = overrides?.provider || provider
      const candidates = readyProviders(nextPing)
      const selected = requested && candidates.includes(requested) ? requested : pickReadyProvider(nextPing)
      const queue = selected ? [selected, ...candidates.filter((name) => name !== selected)] : candidates
      if (!queue.length) {
        setError('No coding CLI is available on this laptop yet. Re-run pairing and pick a CLI.')
        return
      }
      setCliMessage(cliSetupMessage(nextPing, queue[0]))
      // 'default' on the wire, never '': an empty mode means "use this laptop's
      // config default" to the daemon, which is not what the visitor picked.
      const mode = wirePermissionMode(overrides?.permissionMode || permissionMode)
      // Sent on every attempt: the model belongs to the CLI the visitor picked,
      // and the fallback loop below may land on a different one, whose own
      // default is then the honest answer (an unknown id is ignored upstream).
      const model = (overrides?.model || '').trim()
      let lastError = ''
      for (const name of queue) {
        try {
          let result: { job_id?: string }
          // Only a CLI that can actually resume gets the /continue route: for
          // copilot and antigravity the daemon would drop the session id and
          // silently start a new conversation.
          if (sessionId && name === selected && cliProfile(name).canResume) {
            result = await deviceRpc<{ job_id?: string }>(
              deviceId,
              phoneSecret,
              `/api/sessions/${encodeURIComponent(sessionId)}/continue`,
              { method: 'POST', body: JSON.stringify({ prompt: text, permission_mode: mode, model }) },
            )
          } else {
            result = await deviceRpc<{ job_id?: string }>(deviceId, phoneSecret, '/api/sessions/new', {
              method: 'POST',
              body: JSON.stringify({ prompt: text, cwd: workingDir, permission_mode: mode, provider: name, model }),
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
