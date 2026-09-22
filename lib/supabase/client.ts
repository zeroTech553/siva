// Browser-side Supabase client. One instance per tab, or null when the
// project keys are not configured (device-only mode).

'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseConfigured } from '@/lib/supabase/config'

let client: SupabaseClient | null = null

export function supabaseBrowser(): SupabaseClient | null {
  if (!supabaseConfigured) return null
  if (!client) client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  return client
}
