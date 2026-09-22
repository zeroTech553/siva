// Mint a single-use terminal ticket (relay/PROTOCOL.md §Connections).
//
// The browser never talks to the relay directly for authentication: it asks
// this route, which proves ownership of the device with the phone secret and
// gets back a 60-second, single-use WebSocket URL. Reconnects mint new
// tickets; a replayed ticket closes with 4001.

import { readJson } from '@/lib/server/http'
import { relayFetch, relayPhoneHeaders, requireSameOrigin } from '@/lib/server/relay'

type Context = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Context) {
  const blocked = requireSameOrigin(request)
  if (blocked) return blocked
  const { id } = await params
  const body = await readJson<{ clientId?: string }>(request)
  const headers = relayPhoneHeaders(request)
  headers.set('content-type', 'application/json')
  return relayFetch(`/v1/devices/${encodeURIComponent(id)}/term-ticket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: body?.clientId ?? '' }),
  })
}
