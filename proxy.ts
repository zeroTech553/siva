// proxy.ts — the Next 16 proxy (successor to middleware.ts).
//
// ONE job: keep the Supabase session cookie fresh for the only route handlers
// that read it (`/api/machines*`, via lib/supabase/server.ts). It is a no-op in
// device-only mode, when Supabase is not configured at all.
//
// ── Why the matcher is two entries and not "everything" ─────────────────────
// On Vercel, every path the proxy matches is served by the serverless/edge
// runtime instead of the CDN. A catch-all matcher means:
//
//   • the landing page and /console can never be served as the static HTML the
//     build already produced — one invocation per page view, forever;
//   • every sprite, logo, font and installer download pays for a function boot
//     to have a cookie refreshed that it will never read;
//   • the device proxy and the relay-facing APIs get an extra hop.
//
// No page in this app reads the session on the server: the browser talks to
// Supabase directly (lib/supabase/client.ts refreshes its own tokens), and the
// only cookie consumer is the machines API. So the matcher lists exactly that,
// and the pages stay static CDN hits. If you add a server component that calls
// `supabaseServer()` or `currentUser()`, add its page route here too — that is
// the whole contract.

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseConfigured } from '@/lib/supabase/config'

/** Supabase names its auth cookies `sb-<project-ref>-auth-token`. */
function hasSessionCookie(request: NextRequest) {
  return request.cookies.getAll().some((cookie) => cookie.name.startsWith('sb-'))
}

export async function proxy(request: NextRequest) {
  if (!supabaseConfigured) return NextResponse.next()
  // No cookie to rotate: skip building a client and skip the upstream call to
  // Supabase entirely. Anonymous visitors cost one cheap pass-through.
  if (!hasSessionCookie(request)) return NextResponse.next()

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
  // Page routes are deliberately absent — see the comment at the top.
  matcher: ['/api/machines', '/api/machines/:path*'],
}
