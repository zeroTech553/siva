/**
 * lib/shared/app-origin.ts — origin facts that both the server and the browser
 * need. No `process.env`, no `Request`: this file must stay importable from a
 * 'use client' component (see docs/repo-layout.md — lib/server is node-only).
 *
 * The server-only half (reading APP_URL, honouring x-forwarded-host) lives in
 * lib/server/app-origin.ts and re-exports these.
 */

/** Where the app is published. Install commands point here, never at a preview. */
export const PUBLISHED_APP_ORIGIN = 'https://clone-github-repository-olive.vercel.app'

/** Hosts a visitor's laptop cannot possibly reach. */
const PRIVATE_SUFFIXES = [
  '.local',
  '.v0.build',
  '.v0.app',
  '.vercel.run',
  '.e2b.app',
  '.ngrok-free.app',
  '.ngrok.io',
]

export function isPrivateHost(hostname: string) {
  if (!hostname) return false
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return true
  return PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
}

export function hostOf(origin: string) {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

/** The origin a visitor should copy into their laptop's terminal. */
export function installOrigin(envOrigin?: string) {
  return (envOrigin || PUBLISHED_APP_ORIGIN).replace(/\/+$/, '')
}
