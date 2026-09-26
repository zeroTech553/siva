/**
 * lib/server/env.ts — every environment variable this app reads, in one place.
 *
 * The rule it exists to enforce: no other file touches `process.env` for
 * configuration. That gives one place to document a variable, one place to
 * validate it, and one place for `pnpm doctor` to check — instead of a value
 * being read in three files and failing in the one nobody tested.
 *
 * Nothing here throws at import time. A missing variable has to degrade, not
 * take the whole deployment down: without the relay Forge still renders, it
 * just cannot pair. `checkEnv()` reports what is missing and what that costs,
 * and `pnpm doctor` prints it.
 */

/** What a variable is for, and what happens when it is absent. */
export type EnvVar = {
  name: string
  /** Required to pair a laptop at all. */
  required: boolean
  /** One plain-English sentence: what this variable does. */
  purpose: string
  /** What breaks without it. Empty when nothing does. */
  without: string
  /** Where to get the value. */
  source?: string
  /** Set for values that must never reach the browser. */
  secret?: boolean
  current?: string
}

export const ENV_VARS: readonly EnvVar[] = [
  {
    name: 'CLOUDFLARE_WORKER_URL',
    required: true,
    purpose: 'Where the relay lives: the browser and the laptop both dial it.',
    without: 'Pairing returns RELAY_NOT_CONFIGURED (503). No laptop can connect.',
    source: '`cd relay/worker && pnpm deploy` prints the Worker URL, or use http://127.0.0.1:8787 with `pnpm relay:dev`',
  },
  {
    name: 'WORKER_PROXY_SECRET',
    required: true,
    purpose: 'Shared secret this app sends to the relay so only it can mint pairing codes.',
    without: 'Pairing returns RELAY_NOT_CONFIGURED (503).',
    source: '`openssl rand -hex 32` — the same value goes in the Worker’s secrets and the Node relay’s env',
    secret: true,
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    required: false,
    purpose: 'Supabase project URL for accounts (machines follow you between browsers).',
    without: 'Forge runs in device-only mode: pairing works, machines live in localStorage only.',
    source: 'Supabase dashboard → Project settings → API',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    required: false,
    purpose: 'Supabase anonymous key. Safe to expose; row-level security is what protects data.',
    without: 'Same as above — device-only mode.',
    source: 'Supabase dashboard → Project settings → API',
  },
  {
    name: 'APP_URL',
    required: false,
    purpose: 'The public URL of this deployment, when it differs from the request host.',
    without: 'Installers fall back to the published origin (lib/shared/app-origin.ts).',
    source: 'https://your-domain.com',
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    required: false,
    purpose: 'The same URL, for code that also runs in the browser.',
    without: 'Falls back to APP_URL, then to the published origin.',
  },
  {
    name: 'ALLOWED_ORIGINS',
    required: false,
    purpose: 'Comma-separated extra origins allowed to call the write APIs (CSRF allowlist).',
    without: 'Only this deployment’s own origin, its Vercel previews and localhost are accepted.',
    source: 'https://staging.example.com,https://example.com',
  },
]

function read(name: string) {
  return (process.env[name] ?? '').trim()
}

/**
 * Everything that is set, missing, or set to something that cannot work.
 * `pnpm doctor` prints this; nothing else needs it.
 */
export function checkEnv(): { ok: boolean; missing: EnvVar[]; set: EnvVar[]; problems: string[] } {
  const missing: EnvVar[] = []
  const set: EnvVar[] = []
  const problems: string[] = []

  for (const variable of ENV_VARS) {
    const value = read(variable.name)
    const entry = { ...variable, current: value || undefined }
    if (!value) {
      if (variable.required) missing.push(entry)
      continue
    }
    set.push(entry)

    if (variable.name.includes('URL') && !/^https?:\/\//.test(value)) {
      problems.push(`${variable.name} must start with http:// or https:// (got "${value}")`)
    }
    if (variable.name.includes('URL') && value.includes('your-project')) {
      problems.push(`${variable.name} still holds the placeholder from .env.example`)
    }
    if (variable.name === 'WORKER_PROXY_SECRET' && value.length < 16) {
      problems.push('WORKER_PROXY_SECRET is shorter than 16 characters — use `openssl rand -hex 32`')
    }
  }

  if (set.some((entry) => entry.name === 'NEXT_PUBLIC_SUPABASE_URL') !==
      set.some((entry) => entry.name === 'NEXT_PUBLIC_SUPABASE_ANON_KEY')) {
    problems.push('Supabase needs BOTH the URL and the anon key; one alone leaves accounts half-configured')
  }

  return { ok: missing.length === 0 && problems.length === 0, missing, set, problems }
}

/** True when the relay is configured — the one thing pairing cannot work without. */
export function relayConfigured() {
  return Boolean(relayUrl() && proxySecret())
}

export function relayUrl() {
  return read('CLOUDFLARE_WORKER_URL').replace(/\/+$/, '')
}

export function proxySecret() {
  return read('WORKER_PROXY_SECRET')
}

/** The deployment's own URL, when one is configured. */
export function appUrl() {
  return read('NEXT_PUBLIC_APP_URL') || read('APP_URL')
}

/** Extra origins trusted for CSRF purposes, trimmed and de-duplicated. */
export function allowedOrigins(): string[] {
  const out = new Set<string>()
  for (const piece of read('ALLOWED_ORIGINS').split(',')) {
    const trimmed = piece.trim().replace(/\/+$/, '')
    if (trimmed) out.add(trimmed)
  }
  for (const extra of [read('APP_URL'), read('NEXT_PUBLIC_APP_URL')]) {
    if (extra) out.add(extra.replace(/\/+$/, ''))
  }
  return [...out]
}
