import { relayFetch } from '@/lib/server/relay'

// Vercel: a hard ceiling on this function's wall time. Everything in this file
// is one short round-trip (relay, database, or a rendered string), so 60s is a
// cap that should never be approached — it exists to stop a hung upstream from
// billing a full timeout.
export const maxDuration = 60

export async function POST(request: Request) {
  const body = await request.arrayBuffer()
  return relayFetch('/v1/pairs/claim', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
    },
    body,
  })
}
