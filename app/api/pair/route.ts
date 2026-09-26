import { relayFetch, relayPhoneHeaders, requireSameOrigin } from '@/lib/server/relay'

// Vercel: a hard ceiling on this function's wall time. Everything in this file
// is one short round-trip (relay, database, or a rendered string), so 60s is a
// cap that should never be approached — it exists to stop a hung upstream from
// billing a full timeout.
export const maxDuration = 60

export async function POST(request: Request) {
  const blocked = requireSameOrigin(request)
  if (blocked) return blocked
  return relayFetch('/v1/pairs', {
    method: 'POST',
    headers: { 'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '' },
  })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code') ?? ''
  return relayFetch(`/v1/pairs/status?code=${encodeURIComponent(code)}`, {
    headers: relayPhoneHeaders(request),
  })
}
