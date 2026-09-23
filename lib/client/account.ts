'use client'

// Account state for the browser: who is signed in, and the machines saved to
// that account. In device-only mode (no Supabase keys) `enabled` is false and
// everything else stays inert — the app falls back to localStorage pairing.

import { useCallback, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'

import { supabaseBrowser } from '@/lib/supabase/client'

export type Machine = {
  id: string
  device_id: string
  phone_secret: string
  name: string
  platform: string
  created_at: string
  last_seen_at: string | null
}

export function useAccount() {
  const supabase = supabaseBrowser()
  const enabled = supabase !== null
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(enabled)

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    void supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) {
        setUser(data.user ?? null)
        setLoading(false)
      }
    })
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => {
      cancelled = true
      subscription.subscription.unsubscribe()
    }
  }, [supabase])

  const signInWithEmail = useCallback(
    async (email: string) => {
      if (!supabase) throw new Error('Accounts are not configured')
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      })
      if (error) throw new Error(error.message)
    },
    [supabase],
  )

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut()
  }, [supabase])

  return { enabled, loading, user, signInWithEmail, signOut }
}

/** Save the current pairing to the signed-in account (no-op when signed out). */
export async function saveMachineToAccount(machine: {
  deviceId: string
  phoneSecret: string
  name?: string
  platform?: string
}): Promise<boolean> {
  const response = await fetch('/api/machines', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(machine),
    cache: 'no-store',
  })
  return response.ok
}

/** Machines saved to the signed-in account, oldest first. */
export async function loadAccountMachines(): Promise<Machine[]> {
  const response = await fetch('/api/machines', { cache: 'no-store' })
  if (!response.ok) return []
  const data = (await response.json().catch(() => ({}))) as { machines?: Machine[] }
  return data.machines ?? []
}
