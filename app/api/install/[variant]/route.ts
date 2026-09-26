import { publicAppOrigin } from '@/lib/server/app-origin'
import {
  pythonInstallScript,
  unixInstallScript,
  windowsCmdInstallScript,
} from '@/lib/server/install-script'

export const runtime = 'nodejs'

// Vercel: a hard ceiling on this function's wall time. Everything in this file
// is one short round-trip (relay, database, or a rendered string), so 60s is a
// cap that should never be approached — it exists to stop a hung upstream from
// billing a full timeout.
export const maxDuration = 60

/**
 * One route, three installer flavours. The public URLs stay the short ones
 * users copy (`/install`, `/install.py`, `/install.cmd`) — `next.config.mjs`
 * rewrites them here so the route tree stays readable.
 *
 *   /install      → sh   (bash stub that downloads /install.py and runs it)
 *   /install.py   → py   (the real installer: venv, daemon, bridge, autostart)
 *   /install.cmd  → cmd  (Windows wrapper around the same /install.py)
 */
const VARIANTS = {
  sh: {
    render: unixInstallScript,
    contentType: 'text/x-shellscript; charset=utf-8',
    filename: 'forge-install.sh',
  },
  py: {
    render: pythonInstallScript,
    contentType: 'text/x-python; charset=utf-8',
    filename: 'forge-install.py',
  },
  cmd: {
    render: windowsCmdInstallScript,
    contentType: 'application/x-bat; charset=utf-8',
    filename: 'forge-install.cmd',
  },
} as const

type Variant = keyof typeof VARIANTS

type Context = { params: Promise<{ variant: string }> }

export async function GET(request: Request, { params }: Context) {
  const { variant } = await params
  const entry = VARIANTS[variant as Variant]
  if (!entry) {
    return new Response(`Unknown installer variant: ${variant}\n`, { status: 404 })
  }

  return new Response(entry.render(publicAppOrigin(request)), {
    headers: {
      'Content-Type': entry.contentType,
      'Content-Disposition': `inline; filename="${entry.filename}"`,
      // CDN-cacheable: the script is templated with the request's own origin
      // and Vercel keys the cache per host, so a 10-minute edge cache is safe
      // and turns repeat/parallel installs into zero invocations.
      'Cache-Control': 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
