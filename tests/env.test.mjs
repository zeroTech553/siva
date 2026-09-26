// Tests for lib/server/env.ts — the one place configuration is read.
//
// These are small on purpose. Their job is not to check that `process.env`
// works; it is to pin down the *validation* that `pnpm doctor` reports and that
// relayFetch relies on: an empty or malformed value must be reported as
// misconfigured, never silently turned into a request that fails somewhere else.
//
// (A refactor once left `relayFetch` building its URL from the `relayUrl`
// function object instead of calling it. Typecheck was happy — a template
// literal accepts anything — and the only thing that noticed was
// tests/e2e-prompt.test.mjs, which got a 502. Hence the URL guard below.)

import assert from 'node:assert/strict';
import test from 'node:test';

import { ENV_VARS, allowedOrigins, checkEnv, relayConfigured, relayUrl } from '../lib/server/env.ts';

const SAVED = { ...process.env };

function withEnv(values, run) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NEXT_PUBLIC_') || ['CLOUDFLARE_WORKER_URL', 'WORKER_PROXY_SECRET', 'APP_URL', 'ALLOWED_ORIGINS'].includes(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in SAVED)) delete process.env[key];
    }
    Object.assign(process.env, SAVED);
  }
}

test('every documented variable says what breaks without it', () => {
  assert.ok(ENV_VARS.length >= 5);
  for (const variable of ENV_VARS) {
    assert.ok(variable.name, 'a name');
    assert.ok(variable.purpose.length > 20, `${variable.name} explains itself`);
    assert.ok(variable.without.length > 10, `${variable.name} says what breaks without it`);
    assert.equal(typeof variable.required, 'boolean');
  }
  // Pairing depends on exactly these two, and the report must say so.
  const required = ENV_VARS.filter((variable) => variable.required).map((variable) => variable.name);
  assert.deepEqual(required, ['CLOUDFLARE_WORKER_URL', 'WORKER_PROXY_SECRET']);
  // Secrets are marked, so nothing prints them in full.
  assert.ok(ENV_VARS.find((variable) => variable.name === 'WORKER_PROXY_SECRET')?.secret);
});

test('a missing required variable is blocking; a missing optional one is not', () => {
  withEnv({}, () => {
    const report = checkEnv();
    assert.equal(report.ok, false);
    assert.deepEqual(report.missing.map((entry) => entry.name), ['CLOUDFLARE_WORKER_URL', 'WORKER_PROXY_SECRET']);
    assert.equal(relayConfigured(), false);
  });

  withEnv({ CLOUDFLARE_WORKER_URL: 'https://relay.example.com', WORKER_PROXY_SECRET: 'a'.repeat(32) }, () => {
    const report = checkEnv();
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.missing.length, 0);
    assert.equal(report.problems.length, 0);
    assert.equal(relayConfigured(), true);
  });
});

test('a malformed value is reported, not passed through', () => {
  withEnv({ CLOUDFLARE_WORKER_URL: 'relay.example.com', WORKER_PROXY_SECRET: 'x'.repeat(32) }, () => {
    const report = checkEnv();
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => /must start with http/.test(problem)));
  });

  // The placeholder left in .env.example is a classic copy-paste failure.
  withEnv(
    { CLOUDFLARE_WORKER_URL: 'https://your-project.supabase.co', WORKER_PROXY_SECRET: 'x'.repeat(32) },
    () => {
      const report = checkEnv();
      assert.ok(report.problems.some((problem) => /placeholder/.test(problem)));
    },
  );

  withEnv({ CLOUDFLARE_WORKER_URL: 'https://relay.example.com', WORKER_PROXY_SECRET: 'short' }, () => {
    const report = checkEnv();
    assert.ok(report.problems.some((problem) => /16 characters/.test(problem)));
  });
});

test('half-configured Supabase is flagged', () => {
  withEnv(
    {
      CLOUDFLARE_WORKER_URL: 'https://relay.example.com',
      WORKER_PROXY_SECRET: 'x'.repeat(32),
      NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
    },
    () => {
      const report = checkEnv();
      assert.equal(report.ok, false);
      assert.ok(report.problems.some((problem) => /BOTH/.test(problem)));
    },
  );
});

test('relayUrl has no trailing slash, so paths never double up', () => {
  withEnv({ CLOUDFLARE_WORKER_URL: 'https://relay.example.com///' }, () => {
    assert.equal(relayUrl(), 'https://relay.example.com');
    assert.equal(`${relayUrl()}/v1/pairs`, 'https://relay.example.com/v1/pairs');
  });
  withEnv({}, () => assert.equal(relayUrl(), ''));
});

test('ALLOWED_ORIGINS is split, trimmed and de-duplicated', () => {
  withEnv(
    { ALLOWED_ORIGINS: ' https://a.example.com/ , , https://b.example.com ', APP_URL: 'https://a.example.com' },
    () => {
      assert.deepEqual(allowedOrigins().sort(), ['https://a.example.com', 'https://b.example.com']);
    },
  );
  withEnv({}, () => assert.deepEqual(allowedOrigins(), []));
});
