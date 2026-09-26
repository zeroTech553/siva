'use client'

/**
 * use-paired-machine.ts — "do I have a laptop, and is it awake?"
 *
 * One hook, used by both /console and the landing page, so presence is polled
 * in exactly one way everywhere:
 *
 *   1. read the session from localStorage (`forge.v1`)
 *   2. no session + signed in?  restore the first machine from the account
 *   3. poll GET /api/devices/{id} through lib/client/polite-polling.ts
 *      (paused while the tab is hidden, backing off while nothing changes,
 *       ticking immediately when the visitor comes back)
 *
 * Pairing a NEW laptop is `components/pairing/use-pairing.ts`; this hook only
 * reads the session that pairing produced.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { loadAccountMachines } from '@/lib/client/account'
import {
  FORGE_SESSION_KEY,
  clearForgeSession,
  readForgeSession,
  writeForgeSession,
  type ForgeSession,
} from '@/lib/client/forge-session'
import { startPolitePolling } from '@/lib/client/polite-polling'
import { supabaseBrowser } from '@/lib/supabase/client'
import { PRESENCE_POLL_SCHEDULE } from '@/lib/shared/poll-schedule'

type DeviceStatus = {
  device?: { name?: string; online?: boolean; daemonOnline?: boolean }
}

export type PairedMachine = {
  /** True once the session lookup finished (with or without a machine). */
  ready: boolean
  hasSession: boolean
  deviceId: string
  phoneSecret: string
  hostname: string
  online: boolean
  daemonOnline: boolean
  /**
   * Re-read the stored session and ask again right now.
   *
   * This is how the page notices a laptop that was paired *after* this hook
   * mounted — `usePairing` writes the session to localStorage, and a same-tab
   * write fires no `storage` event, so the caller has to say "look again".
   */
  refresh(): void
  /** Forget this browser's credential. */
  forget(): void
}

export function usePairedMachine({
  restoreFromAccount = true,
  poll = true,
  onConnected,
  onNoMachine,
}: {
  /** Signed-in visitors get their machine back on a fresh browser. */
  restoreFromAccount?: boolean
  poll?: boolean
  onConnected?: (session: ForgeSession) => void
  onNoMachine?: () => void
} = {}): PairedMachine {
  const [session, setSession] = useState<ForgeSession | null>(null)
  const [ready, setReady] = useState(false)
  const [online, setOnline] = useState(false)
  const [daemonOnline, setDaemonOnline] = useState(false)
  const [hostname, setHostname] = useState('')
  const pollRef = useRef<{ tick(): void } | null>(null)
  const callbacks = useRef({ onConnected, onNoMachine })
  callbacks.current = { onConnected, onNoMachine }

  // -- restore ----------------------------------------------------------------
  useEffect(() => {
    const existing = readForgeSession()
    if (existing?.deviceId && existing.phoneSecret) {
      setSession(existing)
      setHostname(existing.hostname || '')
      setOnline(Boolean(existing.daemonOnline))
      setReady(true)
      return
    }
    // In device-only mode there is no account to restore from, so do not spend
    // a serverless invocation on /api/machines just to be told "not configured".
    if (!restoreFromAccount || supabaseBrowser() === null) {
      setReady(true)
      callbacks.current.onNoMachine?.()
      return
    }
    let cancelled = false
    void loadAccountMachines().then((machines) => {
      if (cancelled) return
      const machine = machines[0]
      setReady(true)
      if (!machine) {
        callbacks.current.onNoMachine?.()
        return
      }
      const restored: ForgeSession = {
        code: '',
        phoneSecret: machine.phone_secret,
        deviceId: machine.device_id,
        hostname: machine.name,
      }
      writeForgeSession(restored)
      setSession(restored)
      setHostname(machine.name || '')
    })
    return () => {
      cancelled = true
    }
  }, [restoreFromAccount])

  // -- presence ---------------------------------------------------------------
  useEffect(() => {
    const deviceId = session?.deviceId
    const phoneSecret = session?.phoneSecret
    if (!poll || !deviceId || !phoneSecret) return

    let wasOnline = false
    const handle = startPolitePolling<DeviceStatus>({
      name: 'device-presence',
      schedule: PRESENCE_POLL_SCHEDULE,
      run: async () => {
        const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
          headers: { Authorization: `Bearer ${phoneSecret}` },
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(`device status ${response.status}`)
        return (await response.json()) as DeviceStatus
      },
      onValue: (data) => {
        const nextOnline = Boolean(data.device?.online)
        const nextDaemon = Boolean(data.device?.daemonOnline)
        setOnline(nextOnline)
        setDaemonOnline(nextDaemon)
        if (data.device?.name) {
          setHostname(data.device.name)
          writeForgeSession({ ...session!, hostname: data.device.name, daemonOnline: nextDaemon })
        }
        if (nextOnline && !wasOnline) {
          wasOnline = true
          callbacks.current.onConnected?.(session!)
        }
      },
      onError: () => {
        setOnline(false)
        setDaemonOnline(false)
      },
    })
    pollRef.current = handle
    return () => {
      pollRef.current = null
      handle.stop()
    }
  }, [poll, session])

  const refresh = useCallback(() => {
    // Adopt a session that appeared since mount (pairing finished in this tab).
    const stored = readForgeSession()
    if (stored?.deviceId && stored.phoneSecret) {
      setSession((current) =>
        current?.deviceId === stored.deviceId && current?.phoneSecret === stored.phoneSecret
          ? current
          : stored,
      )
      if (stored.hostname) setHostname(stored.hostname)
      setReady(true)
    }
    // If the session changed, the presence effect re-runs and its first tick is
    // immediate; ticking the old handle in the meantime is harmless.
    pollRef.current?.tick()
  }, [])

  // Pairing finished in ANOTHER tab of the same browser: adopt it too.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== FORGE_SESSION_KEY) return
      refresh()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [refresh])

  const forget = useCallback(() => {
    const current = session
    if (current?.deviceId && current.phoneSecret) {
      void fetch(`/api/devices/${encodeURIComponent(current.deviceId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${current.phoneSecret}` },
        cache: 'no-store',
      }).catch(() => undefined)
    }
    clearForgeSession()
    setSession(null)
    setOnline(false)
    setDaemonOnline(false)
    setHostname('')
  }, [session])

  return {
    ready,
    hasSession: Boolean(session?.deviceId && session?.phoneSecret),
    deviceId: session?.deviceId ?? '',
    phoneSecret: session?.phoneSecret ?? '',
    hostname: hostname || 'your laptop',
    online,
    daemonOnline,
    refresh,
    forget,
  }
}
