import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'

/**
 * Daemon overlay files. The installer downloads these and drops them into the
 * vendored `agentremoted` checkout on the laptop, which is how Forge adds the
 * Cursor / Antigravity / OpenCode / Copilot providers and the CLI launcher hook
 * without forking the daemon (see `overlay_daemon()` in
 * `lib/server/install-script.ts`).
 *
 * Source of truth: `bridge/overlay/`. They are deliberately *not* in `public/`
 * — `public/` is static web assets, these are laptop-side Python.
 */
const OVERLAY_DIR = join(process.cwd(), 'bridge', 'overlay')

const OVERLAY_FILES = new Set([
  'cli_launch.py',
  'cli_provider.py',
  'cursor.py',
  'antigravity.py',
  'opencode.py',
  'copilot.py',
  'forge_hook.py',
])

type Context = { params: Promise<{ name: string }> }

export async function GET(_request: Request, { params }: Context) {
  const { name } = await params
  if (!OVERLAY_FILES.has(name)) {
    return new Response('not found\n', { status: 404 })
  }

  const body = await readFile(join(OVERLAY_DIR, name), 'utf8')
  return new Response(body, {
    headers: {
      'Content-Type': 'text/x-python; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
