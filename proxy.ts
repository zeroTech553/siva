// Refreshes the Supabase session cookie on every request so server
// components always see a valid token. A no-op in device-only mode.
// (Next 16 proxy convention — the successor to middleware.ts. Per
// @supabase/ssr docs this is the only place that can both read and write
// cookies reliably across the app.)

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseConfigured } from '@/lib/supabase/config'

export async function proxy(request: NextRequest) {
  if (!supabaseConfigured) return NextResponse.next()

  let response = NextResponse.next({ request })
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  // Touch the session so expired tokens are rotated in the cookie.
  await supabase.auth.getUser()
  return response
}

export const config = {
  matcher: [
    // Everything except static assets and the installer/bridge downloads,
    // which must stay cacheable and cookie-free for curl.
    '/((?!_next/static|_next/image|fonts|ar|favicon|install|bridge\\.py|api/install|api/bridge|api/forge).*)',
  ],
}
