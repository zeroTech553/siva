/**
 * lib/server/app-origin.ts — node-only origin helpers.
 *
 * Constants and pure predicates are re-exported from lib/shared/app-origin.ts so
 * the browser and the server can never disagree about what a private host is.
 * What stays here needs `process.env` or a `Request`.
 */

import { appUrl } from '@/lib/server/env'
import { PUBLISHED_APP_ORIGIN, isPrivateHost } from '@/lib/shared/app-origin'

export { PUBLISHED_APP_ORIGIN, isPrivateHost }
export { hostOf, installOrigin } from '@/lib/shared/app-origin'

export function configuredAppOrigin() {
  return (appUrl() || PUBLISHED_APP_ORIGIN).replace(/\/+$/, '')
}

/**
 * The origin to print in an installer: the real host when this deployment has
 * one, otherwise the published URL (a laptop cannot reach a preview host).
 */
export function publicAppOrigin(request: Request) {
  const configured = configuredAppOrigin()
  const proto = request.headers.get('x-forwarded-proto') || 'https'
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host') ||
    new URL(request.url).host
  const hostname = host.split(':')[0] || ''
  if (isPrivateHost(hostname)) return configured
  return `${proto}://${host}`
}
