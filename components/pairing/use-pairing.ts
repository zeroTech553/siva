'use client'

/**
 * use-pairing.ts — the pairing state machine, with no UI in it.
 *
 *   start()   POST /api/pair  → { code, phoneSecret, expiresAt } in localStorage
 *   poll      GET  /api/pair?code=… (before claim) or /api/devices/{id} (after)
 *   reset()   DELETE the device, forget the code, mint a new one
 *
 * Polling goes through lib/client/polite-polling.ts, so a visitor who switches
 * tabs while the laptop installs costs zero serverless invocations, and the
 * interval backs off while nothing changes.
 *
 * `pair-panel.tsx` renders this; `console-frame.tsx` never sees a pairing code
 * at all (it only reads the resulting session via use-paired-machine.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { startPolitePolling } from '@/lib/client/polite-polling'
import {
  clearForgeSession,
  readForgeSession,
  writeForgeSession,
  writeConsolePrefs,
  type ForgeSession,
} from '@/lib/client/forge-session'
import { saveMachineToAccount, useAccount } from '@/lib/client/account'
import { playDing, playError } from '@/lib/client/zero-sound'
import { hostOf, installOrigin, isPrivateHost } from '@/lib/shared/app-origin'

const APP_ORIGIN = installOrigin(process.env.NEXT_PUBLIC_APP_URL)

export type PairStatus = 'idle' | 'loading' | 'waiting' | 'claimed' | 'online' | 'error'
export type LaptopPlatform = 'windows' | 'unix'

export type Pairing = {
  status: PairStatus
  error: string
  code: string
  hostname: string
  deviceId: string
  session: ForgeSession | null
  platform: LaptopPlatform
  /** Override the detected platform (Windows / macOS+Linux command). */
  setPlatform(platform: LaptopPlatform): void
  appOrigin: string
  /** The command the visitor runs on their laptop. */
  command: string
  /** True when the preview host is not publicly reachable. */
  privateOrigin: boolean
  copied: boolean
  start(): Promise<void>
  reset(): Promise<void>
  copy(): Promise<void>
}

type WorkerDevice = { id?: string; name?: string; online?: boolean; daemonOnline?: boolean }

class PairError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function isExpired(session: ForgeSession) {
  if (!session.expiresAt) return false
  const expiresAt = Date.parse(session.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= Date.now()
}

export function usePairing({
  cli = 'claude',
  autoStart = false,
  onOnline,
}: {
  /** Chosen CLI id — it goes on the end of the install command. */
  cli?: string
  /** Mint a code as soon as the hook mounts (the console does not want that). */
  autoStart?: boolean
  onOnline?: (session: ForgeSession) => void
} = {}): Pairing {
  const [session, setSession] = useState<ForgeSession | null>(null)
  const [status, setStatus] = useState<PairStatus>('idle')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [platform, setPlatform] = useState<LaptopPlatform>('unix')
  const account = useAccount()
  const onOnlineRef = useRef(onOnline)
  onOnlineRef.current = onOnline
  const cliRef = useRef(cli)
  cliRef.current = cli

  // -- environment + stored session -------------------------------------------
  useEffect(() => {
    setPlatform(/Windows/i.test(navigator.userAgent) ? 'windows' : 'unix')
    const existing = readForgeSession()
    if (existing?.code && existing.phoneSecret && !isExpired(existing)) {
      setSession(existing)
      setStatus(existing.deviceId ? 'claimed' : 'waiting')
      return
    }
    clearForgeSession()
    if (autoStart) void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const response = await fetch('/api/pair', { method: 'POST', cache: 'no-store' })
      const data = (await response.json().catch(() => ({}))) as { code?: string; phoneSecret?: string; expiresAt?: string; error?: string }
      if (!response.ok || !data.code || !data.phoneSecret) {
        throw new Error(data.error || 'Could not create a pairing code')
      }
      const next: ForgeSession = { code: data.code, phoneSecret: data.phoneSecret, expiresAt: data.expiresAt }
      writeForgeSession(next)
      writeConsolePrefs({ provider: cliRef.current })
      setSession(next)
      setStatus('waiting')
    } catch (cause) {
      setStatus('error')
      setError(cause instanceof Error ? cause.message : 'Could not start pairing')
      void playError()
    }
  }, [])

  const reset = useCallback(async () => {
    const current = session
    if (current?.deviceId && current.phoneSecret) {
      await fetch(`/api/devices/${encodeURIComponent(current.deviceId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${current.phoneSecret}` },
        cache: 'no-store',
      }).catch(() => undefined)
    }
    clearForgeSession()
    setSession(null)
    await start()
  }, [session, start])

  // -- polite presence polling -------------------------------------------------
  useEffect(() => {
    if (!session?.code || !session.phoneSecret) return
    let finished = false

    const applyDevice = (device: WorkerDevice | undefined, claimed: boolean) => {
      const next: ForgeSession = {
        ...session,
        deviceId: device?.id || session.deviceId,
        hostname: device?.name || session.hostname,
        daemonOnline: Boolean(device?.daemonOnline),
      }
      if (JSON.stringify(next) !== JSON.stringify(session)) {
        writeForgeSession(next)
        setSession(next)
      }
      if (device?.online) {
        if (finished) return
        finished = true
        setStatus('online')
        void playDing()
        if (account.enabled && account.user) {
          void saveMachineToAccount({
            deviceId: next.deviceId || '',
            phoneSecret: next.phoneSecret,
            name: next.hostname,
            platform,
          })
        }
        onOnlineRef.current?.(next)
        return
      }
      setStatus(device?.id || claimed ? 'claimed' : 'waiting')
    }

    const poll = startPolitePolling<{ device?: WorkerDevice; status?: string }>({
      name: 'pairing',
      schedule: { baseMs: 1200, maxMs: 8000, backoff: 1.5, idleRounds: 3 },
      run: async () => {
        const url = session.deviceId
          ? `/api/devices/${encodeURIComponent(session.deviceId)}`
          : `/api/pair?code=${encodeURIComponent(session.code)}`
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${session.phoneSecret}` },
          cache: 'no-store',
        })
        const data = (await response.json().catch(() => ({}))) as {
          device?: WorkerDevice
          status?: string
          error?: string
        }
        if (!response.ok) throw new PairError(data.error || 'Pairing status is unavailable', response.status)
        return data
      },
      onValue: (data) => {
        if (finished) return
        if (data.status === 'expired') {
          finished = true
          clearForgeSession()
          setSession(null)
          void start()
          return
        }
        applyDevice(data.device, data.status === 'claimed')
      },
      onError: (cause) => {
        if (finished) return
        if (cause instanceof PairError && [401, 404, 409, 410].includes(cause.status)) {
          finished = true
          clearForgeSession()
          setSession(null)
          void start()
          return
        }
        if (cause instanceof PairError && cause.status >= 500) return // transient: back off and retry
        setStatus('error')
        setError(cause instanceof Error ? cause.message : 'Could not reach the relay')
      },
    })

    return () => {
      finished = true
      poll.stop()
    }
    // `session` identity changes only when the code or the device id changes,
    // which is exactly when the poll needs a new URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.code, session?.deviceId, session?.phoneSecret])

  const copy = useCallback(async () => {
    const text = buildCommand(platform, session?.code, cliRef.current)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    setCopied(true)
    void playDing()
    window.setTimeout(() => setCopied(false), 1600)
  }, [platform, session?.code])

  const command = useMemo(() => buildCommand(platform, session?.code, cli), [platform, session?.code, cli])

  return {
    status,
    error,
    code: session?.code ?? '',
    hostname: session?.hostname ?? '',
    deviceId: session?.deviceId ?? '',
    session,
    platform,
    setPlatform,
    appOrigin: APP_ORIGIN,
    command,
    privateOrigin: isPrivateHost(hostOf(APP_ORIGIN)),
    copied,
    start,
    reset,
    copy,
  }
}

function buildCommand(platform: LaptopPlatform, code: string | undefined, cli: string) {
  if (!code) return ''
  if (platform === 'windows') {
    return `curl.exe -fsSL ${APP_ORIGIN}/install.cmd -o "%TEMP%\\forge-install.cmd" && call "%TEMP%\\forge-install.cmd" ${code} ${cli}`
  }
  return `curl -fsSL ${APP_ORIGIN}/install | bash -s -- ${code} ${cli}`
}
