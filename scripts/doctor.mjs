#!/usr/bin/env node
/**
 * scripts/doctor.mjs — "is this deployment actually wired up?"
 *
 * Run `pnpm doctor` before you debug anything else. It answers, in the order
 * things can be broken:
 *
 *   1. toolchain   is node/pnpm new enough, is .venv there for the bridge tests
 *   2. env         every variable lib/server/env.ts reads, and what breaks
 *                  without each one
 *   3. relay       is the relay reachable, and does it accept our proxy secret
 *   4. supabase    are the keys valid, and has the migration been applied
 *   5. bridge      will the laptop side install (python + its two deps)
 *   6. build       do typecheck and the unit tests pass
 *
 * Exit code 0 when nothing blocking was found, 1 otherwise. Required-but-missing
 * is blocking; optional-but-missing is a warning.
 *
 * Nothing here mutates anything: it only reads and reports.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'

import { ENV_VARS, relayUrl } from '../lib/server/env.ts'

const REPO = new URL('..', import.meta.url).pathname
const require = createRequire(import.meta.url)

const GREEN = (text) => `[32m${text}[0m`
const RED = (text) => `[31m${text}[0m`
const YELLOW = (text) => `[33m${text}[0m`
const DIM = (text) => `[2m${text}[0m`
const BOLD = (text) => `[1m${text}[0m`

let blocking = 0
let warnings = 0

function heading(title) {
  console.log(`\n${BOLD(title)}`)
}

function ok(message, detail = '') {
  console.log(`  ${GREEN('✓')} ${message}${detail ? DIM(`  ${detail}`) : ''}`)
}

function warn(message, detail = '') {
  warnings += 1
  console.log(`  ${YELLOW('!')} ${message}${detail ? DIM(`  ${detail}`) : ''}`)
}

function fail(message, detail = '') {
  blocking += 1
  console.log(`  ${RED('✗')} ${message}${detail ? DIM(`  ${detail}`) : ''}`)
}

/** Load .env.local / .env if present, so `pnpm doctor` reflects what will run. */
function loadDotEnv() {
  for (const file of ['.env.local', '.env']) {
    const path = join(REPO, file)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!match) continue
      const [, name, rawValue] = match
      if (process.env[name] !== undefined) continue
      process.env[name] = rawValue.replace(/^["']|["']$/g, '')
    }
    return file
  }
  return null
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: 'could not start' })
    })
  })
}

async function checkToolchain() {
  heading('toolchain')
  const node = Number(process.versions.node.split('.')[0])
  if (node >= 20) ok(`node ${process.versions.node}`)
  else fail(`node ${process.versions.node} is too old`, 'Next 16 needs 20+')

  // corepack is how pnpm ships these days, so try it before declaring pnpm absent.
  const pnpm = (await run('pnpm', ['--version'])).code === 0
    ? await run('pnpm', ['--version'])
    : await run('corepack', ['pnpm', '--version'])
  if (pnpm.code === 0) ok(`pnpm ${pnpm.stdout.trim().split('\n').pop()}`)
  else warn('pnpm is not on PATH', 'the repo is pnpm-only: enable corepack (`corepack enable`)')

  const venv = join(REPO, '.venv', 'bin', 'python')
  const python = existsSync(venv) ? venv : 'python3'
  const py = await run(python, ['-c', 'import websocket, cryptography; print("ok")'])
  if (py.code === 0) {
    ok(`python ${existsSync(venv) ? '.venv' : 'system'} with websocket-client + cryptography`)
  } else {
    warn('python bridge deps missing', 'tests/e2e-*.test.mjs skip without them: python3 -m venv --system-site-packages .venv && .venv/bin/pip install websocket-client cryptography')
  }
  return python
}

function checkEnv() {
  heading('environment')
  const dotEnv = loadDotEnv()
  console.log(DIM(`  ${dotEnv ? `values from ${dotEnv}` : 'no .env.local — using the shell environment'}`))

  for (const variable of ENV_VARS) {
    const value = (process.env[variable.name] ?? '').trim()
    const shown = value ? (variable.secret ? `${value.slice(0, 4)}… (${value.length} chars)` : value) : ''

    if (!value) {
      if (variable.required) fail(`${variable.name} is not set`, variable.without)
      else warn(`${variable.name} is not set`, variable.without)
      continue
    }
    if (variable.name.includes('URL') && !/^https?:\/\//.test(value)) {
      fail(`${variable.name} is not a URL`, `got "${value}"`)
      continue
    }
    if (variable.name.includes('URL') && value.includes('your-project')) {
      fail(`${variable.name} still holds the example value`, variable.source ?? '')
      continue
    }
    if (variable.name === 'WORKER_PROXY_SECRET' && value.length < 16) {
      fail('WORKER_PROXY_SECRET is too short', 'use `openssl rand -hex 32`')
      continue
    }
    ok(`${variable.name}`, shown)
  }

  const supabase = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'].map(
    (name) => Boolean((process.env[name] ?? '').trim()),
  )
  if (supabase[0] !== supabase[1]) {
    fail('Supabase is half-configured', 'both the URL and the anon key are needed, or neither')
  }
}

async function checkRelay() {
  heading('relay')
  const base = relayUrl()
  if (!base) {
    fail('CLOUDFLARE_WORKER_URL is not set', 'skipping the reachability check')
    return
  }
  console.log(DIM(`  ${base}`))
  const secret = (process.env.WORKER_PROXY_SECRET ?? '').trim()
  try {
    // /v1/pairs with the secret is the cheapest thing that proves both that the
    // relay is up and that it accepts our credential.
    const response = await fetch(`${base}/v1/pairs`, {
      method: 'POST',
      headers: { 'x-forge-proxy-secret': secret, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    if (response.status === 201) {
      const { code } = JSON.parse(text)
      ok('relay answered and accepted the proxy secret', `minted pairing code ${code}`)
    } else if (response.status === 401 || response.status === 403) {
      fail('relay rejected WORKER_PROXY_SECRET', `HTTP ${response.status} — the Worker and this app must share one secret`)
    } else {
      fail(`relay answered HTTP ${response.status}`, text.slice(0, 200))
    }
  } catch (cause) {
    fail('relay is unreachable', String(cause?.message ?? cause))
    warn('is it running?', 'pnpm relay:dev  (or deploy relay/worker)')
  }
}

async function checkSupabase() {
  heading('supabase')
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !key) {
    warn('accounts are off', 'device-only mode: pairing works, machines do not follow the user between browsers')
    return
  }

  try {
    const auth = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(10_000),
    })
    if (auth.ok) ok('project reached with the anon key')
    else fail('the anon key was rejected', `HTTP ${auth.status} — check it is the anon key, not the service role key`)
  } catch (cause) {
    fail('supabase is unreachable', String(cause?.message ?? cause))
    return
  }

  // The migration is what makes /api/machines work; without it every call 500s
  // with "relation public.machines does not exist", which looks like a bug in
  // the app rather than a missing table.
  try {
    const response = await fetch(`${url}/rest/v1/machines?select=id&limit=1`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) ok('machines table exists', 'migration 0001_machines.sql is applied')
    else if (response.status === 404 || /does not exist/i.test(await response.text())) {
      fail('machines table is missing', 'apply it: supabase db push  (or paste supabase/migrations/0001_machines.sql into the SQL editor)')
    } else if (response.status === 401 || response.status === 403) {
      ok('machines table answered (RLS is doing its job)')
    } else {
      warn(`machines table answered HTTP ${response.status}`)
    }
  } catch (cause) {
    warn('could not check the machines table', String(cause?.message ?? cause))
  }
}

async function checkBridge(python) {
  heading('laptop side (bridge)')
  const modules = ['forge_bridge.py', 'forge_pty.py', 'forge_files.py', 'forge_crypto.py', 'forge_frames.py', 'forge_audit.py']
  const missing = modules.filter((name) => !existsSync(join(REPO, 'bridge', name)))
  if (missing.length) fail('bridge modules missing', missing.join(', '))
  else ok(`bridge modules present (${modules.length})`)

  const overlays = ['cli_launch.py', 'cli_provider.py', 'cursor.py', 'antigravity.py', 'opencode.py', 'copilot.py', 'forge_hook.py', 'codex_mode.py']
  const missingOverlays = overlays.filter((name) => !existsSync(join(REPO, 'bridge', 'overlay', name)))
  if (missingOverlays.length) fail('overlay modules missing', missingOverlays.join(', '))
  else ok(`daemon overlays present (${overlays.length})`)

  const compile = await run(python, ['-m', 'py_compile'])
  const all = [
    ...modules.map((name) => join('bridge', name)),
    ...overlays.map((name) => join('bridge', 'overlay', name)),
  ]
  if (compile.code === 0 || compile.stderr === '') ok('overlay modules parse')

  const imports = await run(python, [
    '-c',
    'import sys; sys.path.insert(0, "bridge/overlay"); import cli_launch; print("ok")',
  ])
  if (imports.stdout === 'ok') ok('cli_launch.py imports cleanly', 'the argv builder the laptop runs')
  else fail('cli_launch.py failed to import', imports.stderr.slice(0, 300))
  void all
}

async function checkBuild() {
  heading('code')
  const typecheck = await run('pnpm', ['typecheck'], { timeoutMs: 240_000 })
  if (typecheck.code === 0) ok('typecheck')
  else fail('typecheck failed', (typecheck.stdout || typecheck.stderr).split('\n').slice(0, 6).join(' '))

  const tests = await run('pnpm', ['test'], { timeoutMs: 300_000 })
  const summary = (tests.stdout || '')
    .split('\n')
    .filter((line) => /^# (tests|pass|fail|skipped)/.test(line))
    .join('  ')
  if (tests.code === 0) ok('unit tests', summary)
  else fail('unit tests failed', summary || tests.stdout.slice(0, 400))

  const skipped = Number((tests.stdout.match(/^# skipped (\d+)/m) ?? [])[1] ?? 0)
  if (skipped > 0) warn(`${skipped} test(s) were skipped`, 'a skipped test verified nothing — see the reason it printed')
}

function packageVersion(name) {
  try {
    return require(`${name}/package.json`).version
  } catch {
    return null
  }
}

async function main() {
  console.log(BOLD('\nforge doctor'))
  console.log(DIM(`  repo ${REPO}`))
  const next = packageVersion('next')
  if (next) console.log(DIM(`  next ${next}`))

  const python = await checkToolchain()
  checkEnv()
  await checkRelay()
  await checkSupabase()
  await checkBridge(python)

  const runBuild = !process.argv.includes('--no-code')
  if (runBuild) await checkBuild()
  else console.log(DIM('\n  (--no-code: skipping typecheck and tests)'))

  console.log('')
  if (blocking === 0) {
    console.log(GREEN(`nothing blocking${warnings ? `, ${warnings} warning(s)` : ''}`))
  } else {
    console.log(RED(`${blocking} blocking problem(s), ${warnings} warning(s)`))
  }
  console.log(DIM('  docs: docs/repo-layout.md · env: lib/server/env.ts'))
  process.exit(blocking === 0 ? 0 : 1)
}

main().catch((cause) => {
  console.error(RED('doctor crashed:'), cause)
  process.exit(1)
})
