import { relayFetch, relayPhoneHeaders, requireSameOrigin } from '@/lib/server/relay'

// Vercel: a hard ceiling on this function's wall time. Everything in this file
// is one short round-trip (relay, database, or a rendered string), so 60s is a
// cap that should never be approached — it exists to stop a hung upstream from
// billing a full timeout.
export const maxDuration = 60

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Context) {
  const { id } = await params
  return relayFetch(`/v1/devices/${encodeURIComponent(id)}`, {
    headers: relayPhoneHeaders(request),
  })
}

export async function DELETE(request: Request, { params }: Context) {
  const blocked = requireSameOrigin(request)
  if (blocked) return blocked
  const { id } = await params
  return relayFetch(`/v1/devices/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: relayPhoneHeaders(request),
  })
}
