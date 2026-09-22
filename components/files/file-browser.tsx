'use client'

// Files on the paired machine, browsed live over the relay.
//
//   browser → /d/{deviceId}/api/fs/*  → relay RPC → bridge → real disk
//
// The bridge refuses paths outside its configured roots (FS_OUTSIDE_ROOT),
// so this component can navigate freely and just render what comes back.

import { useCallback, useEffect, useState } from 'react'

import { Win95Button } from '@/components/os/win95'
import { DeviceRpcError, deviceRpc } from '@/lib/client/device-rpc'

type Entry = {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  hidden: boolean
}

type Listing = {
  path: string
  parent: string | null
  entries: Entry[]
  truncated: boolean
  root: string
}

type ReadResult = {
  path: string
  encoding: string // 'binary' for files the bridge will not render as text
  lines: { number: number; text: string }[]
  totalLines: number
  truncated: boolean
}

type RootsResult = { roots: { path: string; name: string; home: boolean }[] }

export function FileBrowser({
  deviceId,
  phoneSecret,
  initialPath,
}: {
  deviceId: string
  phoneSecret: string
  initialPath?: string
}) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [file, setFile] = useState<ReadResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fs = useCallback(
    <T,>(endpoint: string, body: Record<string, unknown>) =>
      deviceRpc<T>(deviceId, phoneSecret, `/api/fs/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    [deviceId, phoneSecret],
  )

  const openDir = useCallback(
    async (path: string) => {
      setLoading(true)
      setError('')
      setFile(null)
      try {
        setListing(await fs<Listing>('list', { path }))
      } catch (cause) {
        setError(cause instanceof DeviceRpcError ? cause.message : 'Could not list that folder.')
      } finally {
        setLoading(false)
      }
    },
    [fs],
  )

  const openFile = useCallback(
    async (path: string) => {
      setLoading(true)
      setError('')
      try {
        setFile(await fs<ReadResult>('read', { path }))
      } catch (cause) {
        setError(cause instanceof DeviceRpcError ? cause.message : 'Could not read that file.')
      } finally {
        setLoading(false)
      }
    },
    [fs],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (initialPath) {
          if (!cancelled) await openDir(initialPath)
          return
        }
        const { roots } = await fs<RootsResult>('roots', {})
        if (!cancelled) await openDir(roots[0]?.path ?? '')
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof DeviceRpcError ? cause.message : 'The laptop did not answer.')
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fs, openDir, initialPath])

  const crumb = file?.path ?? listing?.path ?? ''

  return (
    <section className="file-browser">
      <header className="file-browser-bar">
        {listing?.parent && !file ? (
          <Win95Button onClick={() => void openDir(listing.parent!)}>Up</Win95Button>
        ) : null}
        {file ? <Win95Button onClick={() => setFile(null)}>Back</Win95Button> : null}
        <span className="file-browser-path" title={crumb}>
          {crumb || '…'}
        </span>
      </header>

      {error ? <p className="file-browser-error">{error}</p> : null}
      {loading ? <p className="file-browser-note">Reading from the laptop…</p> : null}

      {!loading && !file && listing ? (
        <ul className="file-browser-list">
          {listing.entries.length === 0 ? <li className="file-browser-note">Empty folder.</li> : null}
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={`file-browser-entry file-browser-entry--${entry.type}`}
                onClick={() => void (entry.type === 'dir' ? openDir(entry.path) : openFile(entry.path))}
              >
                <span className="file-browser-glyph" aria-hidden>
                  {entry.type === 'dir' ? '▸' : '·'}
                </span>
                <span className="file-browser-name">{entry.name}</span>
                {entry.type === 'file' ? (
                  <span className="file-browser-size">{formatSize(entry.size)}</span>
                ) : null}
              </button>
            </li>
          ))}
          {listing.truncated ? <li className="file-browser-note">Listing truncated.</li> : null}
        </ul>
      ) : null}

      {!loading && file ? (
        file.encoding === 'binary' ? (
          <p className="file-browser-note">Binary file — {file.path.split('/').pop()}.</p>
        ) : (
          <pre className="file-browser-view">
            {file.lines.map((line) => (
              <span key={line.number} className="file-browser-line">
                <span className="file-browser-lineno">{line.number}</span>
                {line.text}
                {'\n'}
              </span>
            ))}
            {file.truncated ? '… (truncated)\n' : ''}
          </pre>
        )
      ) : null}
    </section>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
