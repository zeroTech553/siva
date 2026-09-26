// The signed-in user's machines.
//
//   GET   list machines saved to the account
//   POST  attach the machine from the current pairing to the account
//
// Requires Supabase (503 in device-only mode) and a signed-in user (401).
// RLS enforces per-user isolation; these handlers never touch other rows.

import { json, readJson } from '@/lib/server/http'
import { requireSameOrigin } from '@/lib/server/relay'
import { currentUser, supabaseServer } from '@/lib/supabase/server'

// Vercel: a hard ceiling on this function's wall time. Everything in this file
// is one short round-trip (relay, database, or a rendered string), so 60s is a
// cap that should never be approached — it exists to stop a hung upstream from
// billing a full timeout.
export const maxDuration = 60

export async function GET() {
  const supabase = await supabaseServer()
  if (!supabase) return json({ error: 'Accounts are not configured', code: 'NO_SUPABASE' }, 503)
  const user = await currentUser()
  if (!user) return json({ error: 'Sign in first', code: 'NOT_SIGNED_IN' }, 401)

  const { data, error } = await supabase
    .from('machines')
    .select('id, device_id, phone_secret, name, platform, created_at, last_seen_at')
    .order('created_at', { ascending: true })
  if (error) return json({ error: error.message }, 500)
  return json({ machines: data ?? [] })
}

export async function POST(request: Request) {
  const blocked = requireSameOrigin(request)
  if (blocked) return blocked
  const supabase = await supabaseServer()
  if (!supabase) return json({ error: 'Accounts are not configured', code: 'NO_SUPABASE' }, 503)
  const user = await currentUser()
  if (!user) return json({ error: 'Sign in first', code: 'NOT_SIGNED_IN' }, 401)

  const body = await readJson<{
    deviceId?: string
    phoneSecret?: string
    name?: string
    platform?: string
  }>(request)
  const deviceId = String(body?.deviceId ?? '')
  const phoneSecret = String(body?.phoneSecret ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(deviceId) || !phoneSecret) {
    return json({ error: 'deviceId and phoneSecret are required' }, 400)
  }

  const { data, error } = await supabase
    .from('machines')
    .upsert(
      {
        user_id: user.id,
        device_id: deviceId,
        phone_secret: phoneSecret,
        name: String(body?.name ?? 'Laptop').slice(0, 120),
        platform: String(body?.platform ?? 'unknown').slice(0, 40),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,device_id' },
    )
    .select('id, device_id, name, platform')
    .single()
  if (error) return json({ error: error.message }, 500)
  return json({ machine: data }, 201)
}
