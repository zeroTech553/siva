// One machine on the account: rename or detach.
// RLS scopes every statement to the signed-in user.

import { json, readJson } from '@/lib/server/http'
import { requireSameOrigin } from '@/lib/server/relay'
import { currentUser, supabaseServer } from '@/lib/supabase/server'

type Context = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Context) {
  const blocked = requireSameOrigin(request)
  if (blocked) return blocked
  const supabase = await supabaseServer()
  if (!supabase) return json({ error: 'Accounts are not configured', code: 'NO_SUPABASE' }, 503)
  const user = await currentUser()
  if (!user) return json({ error: 'Sign in first', code: 'NOT_SIGNED_IN' }, 401)

  const { id } = await params
  const body = await readJson<{ name?: string }>(request)
  const name = String(body?.name ?? '').slice(0, 120)
  if (!name) return json({ error: 'name is required' }, 400)

  const { data, error } = await supabase
    .from('machines')
    .update({ name })
    .eq('id', id)
    .select('id, device_id, name')
    .single()
  if (error) return json({ error: error.message }, 500)
  return json({ machine: data })
}

export async function DELETE(request: Request, { params }: Context) {
  const blocked = requireSameOrigin(request)
  if (blocked) return blocked
  const supabase = await supabaseServer()
  if (!supabase) return json({ error: 'Accounts are not configured', code: 'NO_SUPABASE' }, 503)
  const user = await currentUser()
  if (!user) return json({ error: 'Sign in first', code: 'NOT_SIGNED_IN' }, 401)

  const { id } = await params
  const { error } = await supabase.from('machines').delete().eq('id', id)
  if (error) return json({ error: error.message }, 500)
  return json({ removed: true })
}
