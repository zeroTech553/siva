'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DeskComputer } from '@/components/desk-computer'
import { Win95Button, Win95Desktop, Win95Window } from '@/components/win95'
import { CLI_CATALOG, cliOption } from '@/lib/cli-catalog'
import { PUBLISHED_APP_ORIGIN, isPrivateHost } from '@/lib/app-origin'
import { playClick } from '@/lib/desk-sound'
import { writeConsolePrefs } from '@/lib/forge-session'

const SESSION_KEY = 'forge.v1'
const APP_ORIGIN_OVERRIDE = (process.env.NEXT_PUBLIC_APP_URL || PUBLISHED_APP_ORIGIN).replace(/\/+$/, '')

type LaptopPlatform = 'windows' | 'unix'
type PairStatus = 'loading' | 'waiting' | 'claimed' | 'online' | 'expired' | 'error'

type PairSession = {
  code: string
  phoneSecret: string
  expiresAt?: string
  deviceId?: string
  hostname?: string
  daemonOnline?: boolean
}

type WorkerDevice = {
  id?: string
  name?: string
  online?: boolean
  daemonOnline?: boolean
}

export function PairingScreen() {
  const router = useRouter()
  const [session, setSession] = useState<PairSession | null>(null)
  const [status, setStatus] = useState<PairStatus>('loading')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [appOrigin, setAppOrigin] = useState('')
  const [platform, setPlatform] = useState<LaptopPlatform>('unix')
  const [introStep, setIntroStep] = useState(0)
  const [selectedCli, setSelectedCli] = useState('claude')

  const chosenCli = cliOption(selectedCli)

  useEffect(() => {
    setAppOrigin(APP_ORIGIN_OVERRIDE)
    setPlatform(/Windows/i.test(navigator.userAgent) ? 'windows' : 'unix')
    const existing = readSession()
    if (existing?.code && existing.phoneSecret && !isSessionExpired(existing)) {
      setSession(existing)
      return
    }
    localStorage.removeItem(SESSION_KEY)
    void createPair()
  }, [])

  useEffect(() => {
    if (status === 'online' && session?.deviceId) {
      router.push('/console')
    }
  }, [status, session?.deviceId, router])

  useEffect(() => {
    if (!session?.code || !session.phoneSecret) return
    let cancelled = false

    const tick = async () => {
      const url = session.deviceId
        ? `/api/devices/${encodeURIComponent(session.deviceId)}`
        : `/api/pair?code=${encodeURIComponent(session.code)}`
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${session.phoneSecret}` },
          cache: 'no-store',
        })
        const data = await response.json()
        if (cancelled) return
        if (!response.ok) {
          if ([401, 404, 409, 410].includes(response.status)) {
            localStorage.removeItem(SESSION_KEY)
            setSession(null)
            await createPair()
            return
          }
          if (response.status >= 500) return
          setStatus('error')
          setError(data.error || 'Pairing status is unavailable')
          return
        }
        if (data.status === 'expired') {
          localStorage.removeItem(SESSION_KEY)
          setSession(null)
          await createPair()
          return
        }
        const device = data.device as WorkerDevice | undefined
        const next: PairSession = {
          ...session,
          deviceId: device?.id || session.deviceId,
          hostname: device?.name || session.hostname,
          daemonOnline: Boolean(device?.daemonOnline),
        }
        if (JSON.stringify(next) !== JSON.stringify(session)) {
          writeSession(next)
          setSession(next)
        }
        if (device?.online) setStatus('online')
        else if (device?.id || data.status === 'claimed') setStatus('claimed')
        else setStatus('waiting')
      } catch {
        if (!cancelled) {
          setStatus('error')
          setError('Could not reach the Forge relay')
        }
      }
    }

    void tick()
    const timer = window.setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session])

  async function createPair() {
    setStatus('loading')
    setError('')
    try {
      const response = await fetch('/api/pair', { method: 'POST', cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not create a pairing code')
      const next = {
        code: data.code as string,
        phoneSecret: data.phoneSecret as string,
        expiresAt: data.expiresAt as string | undefined,
      }
      writeSession(next)
      setSession(next)
      setStatus('waiting')
    } catch (cause) {
      setStatus('error')
      setError(cause instanceof Error ? cause.message : 'Could not start pairing')
    }
  }

  async function resetPairing() {
    if (session?.deviceId && session.phoneSecret) {
      await fetch(`/api/devices/${encodeURIComponent(session.deviceId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.phoneSecret}` },
      }).catch(() => undefined)
    }
    localStorage.removeItem(SESSION_KEY)
    setSession(null)
    await createPair()
  }

  const command = useMemo(() => {
    if (!appOrigin || !session?.code) return ''
    if (platform === 'windows') {
      return `curl.exe -fsSL ${appOrigin}/install.cmd -o "%TEMP%\\forge-install.cmd" && call "%TEMP%\\forge-install.cmd" ${session.code} ${selectedCli}`
    }
    return `curl -fsSL ${appOrigin}/install | bash -s -- ${session.code} ${selectedCli}`
  }, [appOrigin, platform, selectedCli, session?.code])

  async function copyCommand() {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const privateOrigin = Boolean(appOrigin) && isPrivateHost(originHost(appOrigin))
  const statusLabel =
    status === 'online'
      ? 'Connected'
      : status === 'claimed'
        ? 'Claimed'
        : status === 'error'
          ? 'Error'
          : 'Waiting'

  return (
    <DeskComputer
      phosphor={introStep === 0}
      caption={introStep === 0 ? 'Slide the mouse, then click to boot' : 'Forge desk'}
      onMouseClick={() => {
        if (introStep === 0) setIntroStep(1)
      }}
    >
      {introStep === 0 ? (
        <button type="button" className="crt-boot" onClick={() => setIntroStep(1)}>
          <p>FORGE BIOS 4.86</p>
          <p>640K OK</p>
          <p>Detecting coding CLIs...</p>
          <p className="crt-boot-cursor">Click or slide the mouse to continue_</p>
        </button>
      ) : (
        <Win95Desktop>
          {introStep === 1 ? (
            <Win95Window title="Program Manager" status="Pick the CLI this laptop should run">
              <div className="cli-icon-grid">
                {CLI_CATALOG.map((cli) => (
                  <button
                    key={cli.id}
                    type="button"
                    className={selectedCli === cli.id ? 'cli-icon cli-icon-selected' : 'cli-icon'}
                    onClick={() => {
                      void playClick()
                      setSelectedCli(cli.id)
                      writeConsolePrefs({ provider: cli.id })
                      setIntroStep(2)
                    }}
                  >
                    <img src={cli.logo} alt="" width={28} height={28} />
                    <span>{cli.name}</span>
                  </button>
                ))}
              </div>
              <p className="win95-note">
                Logos from theSVG.org. Review each brand&apos;s trademark policy before commercial use.
              </p>
            </Win95Window>
          ) : (
            <Win95Window
              title={`Forge Setup — ${chosenCli.name}`}
              status={`${statusLabel}${session?.hostname ? ` · ${session.hostname}` : ''}`}
            >
              <div className="pair-pane">
                <p className="pair-kicker">Pairing code</p>
                <p className="pair-code">{session?.code || '————-————'}</p>
                <p className="win95-note">
                  Run this on the laptop. Forge launches {chosenCli.name} for prompts from this phone.
                </p>
                {privateOrigin ? (
                  <p className="win95-note">
                    This preview host is private. The laptop must be able to reach {appOrigin}.
                  </p>
                ) : null}
                {error ? <p className="win95-note">{error}</p> : null}
                <pre className="pair-command">{command || 'Creating pairing code...'}</pre>
                <div className="pair-actions">
                  <Win95Button onClick={() => void copyCommand()}>{copied ? 'Copied' : 'Copy command'}</Win95Button>
                  <Win95Button onClick={() => setIntroStep(1)}>Change CLI</Win95Button>
                  <Win95Button onClick={() => void resetPairing()}>New code</Win95Button>
                </div>
              </div>
            </Win95Window>
          )}
        </Win95Desktop>
      )}
    </DeskComputer>
  )
}

function originHost(origin: string) {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

function isSessionExpired(session: PairSession) {
  if (!session.expiresAt) return false
  const expiresAt = Date.parse(session.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= Date.now()
}

function readSession(): PairSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as PairSession) : null
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
}

function writeSession(session: PairSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}
