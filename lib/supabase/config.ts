// Supabase is optional until keys are pasted into .env.local:
//
//   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
//
// Without them every account feature quietly steps aside and Forge runs in
// device-only mode (pairing state lives in localStorage, exactly as before).
// Nothing else in the app is allowed to read these env vars directly.

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
