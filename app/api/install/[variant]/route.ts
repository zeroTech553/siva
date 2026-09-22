import { publicAppOrigin } from '@/lib/server/app-origin'
import {
  pythonInstallScript,
  unixInstallScript,
  windowsCmdInstallScript,
} from '@/lib/server/install-script'

export const runtime = 'nodejs'

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
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
