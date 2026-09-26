import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'

// Vercel: a hard ceiling on this function's wall time. Everything in this file
// is one short round-trip (relay, database, or a rendered string), so 60s is a
// cap that should never be approached — it exists to stop a hung upstream from
// billing a full timeout.
export const maxDuration = 60

/**
 * Daemon overlay files. The installer downloads these and drops them into the
 * vendored `agentremoted` checkout on the laptop, which is how Forge adds the
 * Cursor / Antigravity / OpenCode / Copilot providers, the codex permission
 * wrapper and the CLI launcher hook
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
  'codex_mode.py',
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
      // Deliberately no-store: these are protocol-critical Python modules that
      // the installer writes into ~/.forge/. A stale copy paired against a new
      // relay would break in confusing ways, and installs are rare enough that
      // the invocations are not worth the risk.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
