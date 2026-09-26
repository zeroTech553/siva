// Laptop bridge modules. The installer downloads each of these into
// ~/.forge/ on the user's machine (see fetch_bridge() in
// lib/server/install-script.ts). Source of truth: bridge/*.py.
//
// Short URLs — /bridge.py resolves to forge_bridge.py via next.config.mjs —
// stay stable so old installers keep working.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'

// Vercel: a hard ceiling on this function's wall time. Everything in this file
// is one short round-trip (relay, database, or a rendered string), so 60s is a
// cap that should never be approached — it exists to stop a hung upstream from
// billing a full timeout.
export const maxDuration = 60

const BRIDGE_DIR = join(process.cwd(), 'bridge')

const BRIDGE_FILES = new Set([
  'forge_bridge.py',
  'forge_pty.py',
  'forge_crypto.py',
  'forge_files.py',
  'forge_frames.py',
  'forge_audit.py',
])

type Context = { params: Promise<{ name: string }> }

export async function GET(_request: Request, { params }: Context) {
  const { name } = await params
  if (!BRIDGE_FILES.has(name)) {
    return new Response('not found\n', { status: 404 })
  }

  const body = await readFile(join(BRIDGE_DIR, name), 'utf8')
  return new Response(body, {
    headers: {
      'Content-Type': 'text/x-python; charset=utf-8',
      // Deliberately no-store: these are protocol-critical Python modules that
      // the installer writes into ~/.forge/. A stale copy paired against a new
      // relay would break in confusing ways, and installs are rare enough that
      // the invocations are not worth the risk.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
