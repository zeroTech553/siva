// Laptop bridge modules. The installer downloads each of these into
// ~/.forge/ on the user's machine (see fetch_bridge() in
// lib/server/install-script.ts). Source of truth: bridge/*.py.
//
// Short URLs — /bridge.py resolves to forge_bridge.py via next.config.mjs —
// stay stable so old installers keep working.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'

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
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
