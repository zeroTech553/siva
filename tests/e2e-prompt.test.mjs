// Full-stack test of "send a prompt" — the product's whole reason to exist.
//
//   this test (as the browser, plain fetch)
//        │ HTTP
//   the REAL Next.js app (next dev, spawned here)
//        │ app/d/[deviceId]/[...path] → lib/server/relay.ts
//   relay/node (real server, ephemeral port)
//        │ WSS (outbound from the "laptop")
//   bridge/forge_bridge.py (the real Python bridge, spawned here)
//        │ HTTP + X-Auth-Token injected from ~/.agentremoted/token
//   tests/fixtures/stub_daemon.py (the daemon's API contract)
//        │ subprocess, argv from bridge/overlay/cli_launch.build_headless_cmd
//   tests/fixtures/fake-cli (a stand-in coding agent)
//
// Nothing in the data path is mocked except the CLI binary and the daemon's
// HTTP surface: the argv that runs and the job events that come back are
// produced by the production overlay code (cli_launch.py) and travel through
// the production bridge, relay and Next.js route.
//
// It proves:
//   1. pairing through the real app mints a code the bridge can claim;
//   2. the bridge comes online and reports the daemon reachable;
//   3. /api/ping and /api/projects reach the daemon through the whole pipe;
//   4. a prompt sent from the browser is exec'd by a real process with the
//      argv the overlay builds, and the prompt text arrives byte-identical;
//   5. the CLI's stream-json output is parsed into job events the browser reads;
//   6. the flags panel's permission_mode is what decides --dangerously-skip-
//      permissions vs --permission-mode plan (parity with lib/shared/cli-flags);
//   7. a second prompt in the same session resumes it (--resume <session_id>);
//   8. the daemon token is injected by the bridge and never needed by the browser;
//   9. /internal is blocked, a wrong phone secret is rejected, and a dead
//      bridge surfaces as LAPTOP_OFFLINE instead of hanging.
//
// Requires python3 with websocket-client + cryptography (the repo's .venv) and
// node_modules/next. Skips with a reason if either is missing.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildCliCommand, defaultFlagState, cliProfile, permissionModeFor } from '../lib/shared/cli-flags.ts';
import { createRelay } from '../relay/node/src/server.mjs';

const REPO = new URL('..', import.meta.url).pathname;
const PYTHON = join(REPO, '.venv', 'bin', 'python');
const NEXT_BIN = join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next');
const PROXY_SECRET = 'test-proxy-secret';
const DAEMON_TOKEN = 'test-daemon-token';

const HAVE_PYTHON = existsSync(PYTHON);
const HAVE_NEXT = existsSync(NEXT_BIN);
const SKIP = !HAVE_PYTHON
  ? 'python venv missing (.venv/bin/python) — run: python3 -m venv --system-site-packages .venv'
  : !HAVE_NEXT
    ? 'node_modules missing — run: pnpm install'
    : false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** SIGKILL a child *and* its children (next dev spawns turbopack workers). */
function killTree(proc) {
  if (!proc || proc.killed) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Start a child process and collect its output for failure messages.
 * `detached` puts it in its own process group so killTree can take the whole
 * tree down — a surviving grandchild holding the stdout pipe open would
 * otherwise keep `node --test` alive long after the assertions passed.
 */
function start(command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...options });
  let log = '';
  const collect = (chunk) => {
    log += chunk.toString();
    if (log.length > 200_000) log = log.slice(-100_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', (code) => {
    log += `\n[exited ${code}]`;
  });
  return { child, log: () => log };
}

async function waitFor(check, timeoutMs, label, detail = () => '') {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout waiting for ${label}\n${detail()}`);
    await sleep(150);
  }
}

test('send a prompt: browser → Next.js → relay → bridge → daemon → CLI → back', { skip: SKIP, timeout: 300_000 }, async (t) => {
  // -- 1. relay ---------------------------------------------------------------
  const { server: relay } = createRelay({ statePath: '', proxySecret: PROXY_SECRET });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const relayPort = relay.address().port;
  const relayBase = `http://127.0.0.1:${relayPort}`;

  // -- 2. the "laptop" --------------------------------------------------------
  const home = mkdtempSync(join(tmpdir(), 'forge-prompt-home-'));
  const project = join(home, 'projects', 'api-server');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# api-server\n');
  mkdirSync(join(home, '.agentremoted'), { recursive: true });
  writeFileSync(join(home, '.agentremoted', 'token'), DAEMON_TOKEN);

  const cliLog = join(home, 'cli-argv.log');
  const daemonLog = join(home, 'daemon-requests.log');
  let bridgeProc = null;

  const daemon = start(PYTHON, [join(REPO, 'tests', 'fixtures', 'stub_daemon.py'), '0'], {
    cwd: REPO,
    env: {
      ...process.env,
      HOME: home,
      FAKE_DAEMON_TOKEN: DAEMON_TOKEN,
      FAKE_CLI_LOG: cliLog,
      FAKE_DAEMON_LOG: daemonLog,
      FAKE_PROJECT_DIR: project,
    },
  });
  const daemonPort = await waitFor(
    async () => {
      const match = daemon.log().match(/LISTENING (\d+)/);
      return match ? Number(match[1]) : null;
    },
    30_000,
    'the stub daemon to listen',
    daemon.log,
  );

  // -- 3. the real Next.js app, pointed at this relay --------------------------
  const nextPort = await freePort();
  const nextBase = `http://127.0.0.1:${nextPort}`;
  const app = start('node', [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(nextPort)], {
    cwd: REPO,
    env: {
      ...process.env,
      CLOUDFLARE_WORKER_URL: relayBase,
      WORKER_PROXY_SECRET: PROXY_SECRET,
      NODE_ENV: 'development',
    },
  });

  t.after(() => {
    for (const proc of [bridgeProc, daemon.child, app.child]) killTree(proc);
    relay.closeAllConnections?.();
    relay.close();
    rmSync(home, { recursive: true, force: true });
    // The dev server's scratch build directory; leaving it speeds the next run
    // up, but it is disposable and must never be committed (see .gitignore).
    rmSync(join(REPO, '.next-e2e'), { recursive: true, force: true });
  });

  await waitFor(
    async () => {
      try {
        const response = await fetch(`${nextBase}/api/pair`, {
          method: 'POST',
          headers: { origin: nextBase },
        });
        return response.status === 201;
      } catch {
        return false;
      }
    },
    120_000,
    'Next.js to serve /api/pair',
    app.log,
  );

  /** A browser request to the app, with the origin a real browser would send. */
  async function appFetch(path, { method = 'GET', body, secret, origin = nextBase } = {}) {
    const headers = { origin };
    if (secret) headers.authorization = `Bearer ${secret}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${nextBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 400) };
    }
    return { status: response.status, json };
  }

  // -- 4. pairing through the real app ----------------------------------------
  const pair = await appFetch('/api/pair', { method: 'POST' });
  assert.equal(pair.status, 201, `pairing failed: ${JSON.stringify(pair.json)}\n${app.log()}`);
  const { code, phoneSecret } = pair.json;
  assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/, 'a pairing code is 3×3 unambiguous characters');
  assert.ok(phoneSecret?.length >= 32, 'the phone secret is a real random token');

  // A cross-origin page cannot mint codes (CSRF).
  const csrf = await appFetch('/api/pair', { method: 'POST', origin: 'https://evil.example' });
  assert.equal(csrf.status, 403, 'cross-origin pairing must be blocked');

  const claim = await appFetch('/api/pair/claim', {
    method: 'POST',
    body: { code, name: 'prompt-laptop', platform: 'linux' },
  });
  assert.equal(claim.status, 201, `claim failed: ${JSON.stringify(claim.json)}`);
  const { deviceId, deviceToken, workerWebSocketUrl } = claim.json;
  assert.ok(deviceId && deviceToken && workerWebSocketUrl, 'claim returns the laptop credentials');

  const reuse = await appFetch('/api/pair/claim', {
    method: 'POST',
    body: { code, name: 'attacker', platform: 'linux' },
  });
  assert.equal(reuse.status, 409, 'a pairing code is single-use');

  // -- 5. the real bridge dials out -------------------------------------------
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      deviceId,
      deviceToken,
      workerWebSocketUrl,
      roots: [project],
      daemonUrl: `http://127.0.0.1:${daemonPort}`,
    }),
  );
  const bridge = start(PYTHON, [join(REPO, 'bridge', 'forge_bridge.py')], {
    cwd: join(REPO, 'bridge'),
    env: {
      ...process.env,
      FORGE_HOME: home,
      FORGE_CONFIG: join(home, 'config.json'),
      FORGE_KEYS: join(home, 'keys.json'),
      FORGE_CLIENTS: join(home, 'clients.json'),
      FORGE_AUDIT_LOG: join(home, 'audit.log'),
      FORGE_LOCK_PORT: String(28500 + (daemonPort % 100)),
      HOME: home,
      SHELL: '/bin/sh',
    },
  });
  bridgeProc = bridge.child;

  const deviceStatus = async () =>
    appFetch(`/api/devices/${encodeURIComponent(deviceId)}`, { secret: phoneSecret });

  const online = await waitFor(
    async () => {
      const status = await deviceStatus();
      return status.json?.device?.online ? status.json.device : null;
    },
    60_000,
    'the bridge to come online',
    () => `${bridge.log()}\n${app.log()}`,
  );
  assert.equal(online.caps?.term, true, 'the bridge advertises a real terminal');
  assert.equal(online.daemonOnline, true, `the bridge must reach the daemon with the injected token\n${bridge.log()}`);

  // A wrong phone secret is refused — the device is not world-readable.
  const wrongSecret = await appFetch(`/api/devices/${encodeURIComponent(deviceId)}`, { secret: 'not-the-secret' });
  assert.notEqual(wrongSecret.json?.device?.online, true, 'a stolen device id alone must not reveal the laptop');

  // -- 6. daemon RPC through the whole pipe -----------------------------------
  const rpc = (path, init) => appFetch(`/d/${encodeURIComponent(deviceId)}${path}`, { secret: phoneSecret, ...init });

  const ping = await rpc('/api/ping');
  assert.equal(ping.status, 200, `ping failed: ${JSON.stringify(ping.json)}\n${app.log()}`);
  assert.deepEqual(ping.json.providers?.slice(0, 3), ['claude', 'codex', 'cursor']);
  assert.equal(ping.json.auth?.status, 'ok');

  const projects = await rpc('/api/projects');
  assert.equal(projects.status, 200);
  assert.equal(projects.json.projects?.[0]?.cwd, project, 'the daemon reports the real project path');

  // /internal is never proxied, whatever the laptop serves there.
  const internal = await rpc('/internal/secrets');
  assert.equal(internal.status, 403, '/internal must be blocked at the edge route');

  // -- 7. send the prompt -----------------------------------------------------
  const PROMPT = 'Fix the retry helper in src/http/retry.py so it re-raises the timeout.';
  const build = { cli: 'claude', prompt: PROMPT, model: '', flags: defaultFlagState(cliProfile('claude')) };
  const preview = buildCliCommand(build);
  const mode = permissionModeFor({ ...build, deepResearch: false });
  assert.ok(['acceptEdits', 'bypassPermissions', 'plan', ''].includes(mode));

  const started = await rpc('/api/sessions/new', {
    method: 'POST',
    // `model` is what the model picker chose; the daemon hands it to the CLI.
    body: { prompt: PROMPT, cwd: project, permission_mode: mode, provider: 'claude', model: 'opus' },
  });
  assert.equal(started.status, 200, `sessions/new failed: ${JSON.stringify(started.json)}`);
  const jobId = started.json.job_id;
  assert.ok(jobId, 'the daemon returns a job id');

  const finished = await waitFor(
    async () => {
      const snapshot = await rpc(`/api/jobs/${encodeURIComponent(jobId)}?since=0`);
      if (snapshot.status !== 200) return null;
      return snapshot.json.status === 'running' ? null : snapshot.json;
    },
    60_000,
    'the job to finish',
    () => `${daemon.log()}\n${bridge.log()}`,
  );

  assert.equal(finished.status, 'completed', `job did not complete: ${JSON.stringify(finished)}`);
  const kinds = finished.events.map((event) => event.kind);
  assert.ok(kinds.includes('init'), 'the CLI init line became an event');
  assert.ok(kinds.includes('text'), 'the assistant text became an event');
  assert.ok(kinds.includes('tool'), 'the tool_use block became an event');
  const texts = finished.events.filter((event) => event.kind === 'text').map((event) => event.text).join('\n');
  assert.match(texts, /Reading the project/, 'the browser sees the CLI output');
  assert.equal(finished.events.find((event) => event.name === 'Read')?.kind, 'tool');
  assert.ok(finished.new_session_id, 'the CLI session id is captured so the next prompt can resume it');

  // -- 8. what actually exec'd on the laptop ----------------------------------
  const argvLog = readFileSync(cliLog, 'utf8');
  const argsLine = argvLog.split('\n').find((line) => line.startsWith('ARGS=')) ?? '';
  const executed = [...argsLine.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]);
  assert.ok(executed.length >= 2, `the CLI never ran. log:\n${argvLog}\n${daemon.log()}`);
  assert.equal(executed.at(-1), PROMPT, 'the prompt reaches the CLI byte-identical, as the last argument');
  assert.ok(executed.includes('--print'), 'claude runs headless (--print)');
  assert.ok(executed.includes('stream-json'), 'claude streams json so events can be parsed');
  assert.ok(argvLog.includes(`CWD=${project}`), 'the CLI runs inside the chosen project');
  assert.ok(executed.includes('--model'), 'the model the visitor picked reaches the CLI');
  assert.equal(executed[executed.indexOf('--model') + 1], 'opus');

  if (mode === 'acceptEdits' || mode === 'bypassPermissions' || mode === '') {
    assert.ok(
      executed.includes('--dangerously-skip-permissions'),
      `permission_mode ${mode || '(ask)'} must map to --dangerously-skip-permissions`,
    );
  }
  // The browser preview and the laptop agree on the shape of the command: same
  // headless flag family, same prompt last, same permission story.
  assert.equal(preview.argv.at(-1), PROMPT);
  assert.ok(
    preview.argv.includes('-p') || preview.argv.includes('--print'),
    'the preview shows the headless flag the laptop used',
  );
  assert.ok(
    preview.explain.length > 0,
    'every flag the visitor picked is explained in plain English',
  );

  // -- 9. plan mode must NOT skip permissions ---------------------------------
  const planJob = await rpc('/api/sessions/new', {
    method: 'POST',
    body: { prompt: 'Explain the retry bug only, do not edit.', cwd: project, permission_mode: 'plan', provider: 'claude' },
  });
  assert.equal(planJob.status, 200);
  await waitFor(
    async () => {
      const snapshot = await rpc(`/api/jobs/${planJob.json.job_id}?since=0`);
      return snapshot.json?.status !== 'running' ? snapshot.json : null;
    },
    60_000,
    'the plan job to finish',
    daemon.log,
  );
  const planArgs = [...readFileSync(cliLog, 'utf8').split('\n').filter((line) => line.startsWith('ARGS=')).at(-1).matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(planArgs.includes('--permission-mode'), 'plan mode is passed through as --permission-mode');
  assert.ok(planArgs.includes('plan'));
  assert.ok(!planArgs.includes('--dangerously-skip-permissions'), 'plan mode must never skip permissions');
  const planMode = permissionModeFor({ ...build, deepResearch: true });
  assert.equal(planMode, 'plan', 'deep research maps to plan mode in the browser too');

  // -- 10. a follow-up prompt resumes the session ------------------------------
  const followUp = await rpc('/api/sessions/new', {
    method: 'POST',
    body: {
      prompt: 'Now add a regression test for it.',
      cwd: project,
      permission_mode: 'acceptEdits',
      provider: 'claude',
      session_id: finished.new_session_id,
    },
  });
  assert.equal(followUp.status, 200);
  await waitFor(
    async () => {
      const snapshot = await rpc(`/api/jobs/${followUp.json.job_id}?since=0`);
      return snapshot.json?.status !== 'running' ? snapshot.json : null;
    },
    60_000,
    'the follow-up job to finish',
    daemon.log,
  );
  const resumeArgs = [...readFileSync(cliLog, 'utf8').split('\n').filter((line) => line.startsWith('ARGS=')).at(-1).matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(resumeArgs.includes('--resume'), 'a second prompt in the same session resumes it');
  assert.ok(resumeArgs.includes(finished.new_session_id), 'and resumes the exact session the CLI reported');

  // -- 11. the daemon token never travels from the browser ---------------------
  const daemonRequests = readFileSync(daemonLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(daemonRequests.length >= 4, 'the daemon saw the RPC traffic');
  assert.ok(daemonRequests.every((entry) => entry.authed), 'every request carried the injected daemon token');
  const newSessions = daemonRequests.filter((entry) => entry.body?.prompt);
  assert.ok(newSessions.length >= 3, 'three prompts were dispatched');
  assert.equal(newSessions[0].body.model, 'opus', 'the browser sent the picked model to the daemon');
  assert.ok(
    daemonRequests.every((entry) => !JSON.stringify(entry.body).includes(DAEMON_TOKEN)),
    'the daemon token is never inside a request body from the browser',
  );

  // -- 12. the traffic really went through the Next.js app ---------------------
  // Next dev logs one line per request; this is the receipt that the browser
  // calls above were served by the real app (and its /d/[deviceId] proxy), not
  // by something standing in for it.
  const appLog = app.log().replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(appLog, /POST \/api\/pair 201/, 'the real Next.js app minted the pairing code');
  assert.match(appLog, /POST \/api\/pair\/claim 201/, 'the real Next.js app served the claim');
  assert.match(
    appLog,
    /POST \/d\/[^ ]*\/api\/sessions\/new 200/,
    'the real Next.js app proxied the prompt to the laptop',
  );
  assert.match(appLog, /GET \/d\/[^ ]*\/api\/jobs\/[^ ]* 200/, 'and streamed the job back');

  // -- 13. a dead laptop degrades to a clear error, not a hang -----------------
  killTree(bridge.child);
  const offline = await waitFor(
    async () => {
      const result = await rpc('/api/ping');
      return result.status >= 500 ? result : null;
    },
    60_000,
    'the offline laptop to be reported',
    () => `${bridge.log()}\n${app.log()}`,
  );
  assert.ok(
    offline.status === 503 || offline.status === 504,
    `an offline laptop must be 503/504, got ${offline.status}`,
  );
  assert.ok(
    /offline|OFFLINE|timeout/i.test(JSON.stringify(offline.json)),
    `the error must say the laptop is offline: ${JSON.stringify(offline.json)}`,
  );
});
