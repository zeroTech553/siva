// End-to-end test of the whole pipe with no fakes in the data path:
//
//   this test (as the browser, @noble + WebCrypto)
//        │ WSS + HTTP
//   relay/node (real server on an ephemeral port)
//        │ WSS (outbound from the laptop)
//   bridge/forge_bridge.py (the real Python bridge, spawned as a subprocess)
//        │ pty.fork()
//   /bin/sh (a real shell)
//
// It proves: pairing → claim → device socket → ticket → browser socket →
// E2E handshake → term_open → encrypted keystrokes → encrypted PTY output →
// scrollback replay on re-attach → encrypted file RPC. If any layer drifts
// from relay/PROTOCOL.md, this fails.
//
// Requires python3 with websocket-client + cryptography (the repo's .venv).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import WebSocket from 'ws';

import { createRelay } from '../relay/node/src/server.mjs';

const REPO = new URL('..', import.meta.url).pathname;
const PYTHON = join(REPO, '.venv', 'bin', 'python');
const PROXY_SECRET = 'test-proxy-secret';

const HAVE_PYTHON = existsSync(PYTHON);
const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// ---------------------------------------------------------------------------
// Browser-side crypto: identical to lib/client (X25519 + HKDF + AES-GCM counters).
// ---------------------------------------------------------------------------
class BrowserChannel {
  constructor() {
    this.secret = x25519.utils.randomSecretKey();
    this.publicKey = x25519.getPublicKey(this.secret);
    this.salt = crypto.getRandomValues(new Uint8Array(4));
    this.sendCounter = 0;
    this.recvCounter = 0;
  }

  async finish(deviceId, clientId, devicePubB64, deviceSaltB64) {
    const shared = x25519.getSharedSecret(this.secret, unb64(devicePubB64));
    const raw = hkdf(
      sha256,
      shared,
      sha256(utf8(deviceId)),
      utf8(`forge-e2e-v2:${deviceId}:${clientId}`),
      32,
    );
    this.key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    this.deviceSalt = unb64(deviceSaltB64);
  }

  nonce(salt, counter) {
    const out = new Uint8Array(12);
    out.set(salt.subarray(0, 4), 0);
    new DataView(out.buffer).setBigUint64(4, BigInt(counter), false);
    return out;
  }

  async seal(plaintext) {
    const iv = this.nonce(this.salt, this.sendCounter);
    this.sendCounter += 1;
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plaintext);
    return new Uint8Array([...iv, ...new Uint8Array(ct)]);
  }

  async open(sealed) {
    const iv = sealed.subarray(0, 12);
    const expected = this.nonce(this.deviceSalt, this.recvCounter);
    assert.deepEqual(Buffer.from(iv), Buffer.from(expected), 'nonce counter must match');
    this.recvCounter += 1;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.key,
      sealed.subarray(12),
    );
    return new Uint8Array(pt);
  }
}

function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function packTerminal(sessionId, clientId, sealed) {
  return Buffer.concat([Buffer.from([0x01]), uuidBytes(sessionId), uuidBytes(clientId), sealed]);
}

function unpackTerminal(buffer) {
  const hex = (part) => Buffer.from(part).toString('hex');
  const dash = (h) =>
    `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return {
    kind: buffer[0],
    sessionId: dash(hex(buffer.subarray(1, 17))),
    clientId: dash(hex(buffer.subarray(17, 33))),
    sealed: new Uint8Array(buffer.subarray(33)),
  };
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
function waitFor(check, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const value = check();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 25);
  });
}

async function proxyFetch(base, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'x-forge-proxy-secret': PROXY_SECRET,
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

test('full pipe: pair → bridge → ticket → encrypted terminal → files', { skip: !HAVE_PYTHON && 'python venv missing', timeout: 120_000 }, async (t) => {
  // 1. relay on an ephemeral port -------------------------------------------------
  const { server } = createRelay({ statePath: '', proxySecret: PROXY_SECRET });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const home = mkdtempSync(join(tmpdir(), 'forge-e2e-'));
  let bridge;
  t.after(() => {
    bridge?.kill('SIGKILL');
    // Graceful close would wait forever on live sockets; drop them.
    server.closeAllConnections?.();
    server.close();
    rmSync(home, { recursive: true, force: true });
  });

  // 2. pairing: phone mints, "installer" claims ----------------------------------
  const pair = await proxyFetch(base, '/v1/pairs', { method: 'POST' });
  assert.equal(pair.status, 201);
  const { code, phoneSecret } = pair.json;
  assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);

  const claim = await proxyFetch(base, '/v1/pairs/claim', {
    method: 'POST',
    body: { code, name: 'e2e-laptop', platform: 'linux' },
  });
  assert.equal(claim.status, 201);
  const { deviceId, deviceToken, workerWebSocketUrl } = claim.json;

  const secondClaim = await proxyFetch(base, '/v1/pairs/claim', {
    method: 'POST',
    body: { code, name: 'attacker', platform: 'linux' },
  });
  assert.equal(secondClaim.status, 409, 'pairing codes are single-use');

  // 3. the real Python bridge dials out ------------------------------------------
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ deviceId, deviceToken, workerWebSocketUrl, roots: [home] }),
  );
  bridge = spawn(PYTHON, [join(REPO, 'bridge', 'forge_bridge.py')], {
    cwd: join(REPO, 'bridge'),
    env: {
      ...process.env,
      FORGE_HOME: home,
      FORGE_CONFIG: join(home, 'config.json'),
      FORGE_KEYS: join(home, 'keys.json'),
      FORGE_CLIENTS: join(home, 'clients.json'),
      FORGE_AUDIT_LOG: join(home, 'audit.log'),
      FORGE_LOCK_PORT: '28473', // beside, not instead of, any real bridge
      HOME: home,
      SHELL: '/bin/sh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeLog = '';
  bridge.stdout.on('data', (d) => {
    bridgeLog += d.toString();
  });
  bridge.stderr.on('data', (d) => {
    bridgeLog += d.toString();
  });

  const online = async () =>
    (
      await proxyFetch(base, `/v1/devices/${deviceId}`, {
        headers: { 'x-forge-phone-secret': phoneSecret },
      })
    ).json.device?.online;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !(await online())) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(await online(), `bridge never came online. log:\n${bridgeLog}`);

  const statusNow = await proxyFetch(base, `/v1/devices/${deviceId}`, {
    headers: { 'x-forge-phone-secret': phoneSecret },
  });
  assert.equal(statusNow.json.device.caps?.term, true, 'bridge must advertise caps.term');
  assert.equal(statusNow.json.device.caps?.e2e, true, 'bridge must advertise caps.e2e');

  // 4. terminal ticket + browser socket ------------------------------------------
  const clientId = randomUUID();
  const ticket = await proxyFetch(base, `/v1/devices/${deviceId}/term-ticket`, {
    method: 'POST',
    headers: { 'x-forge-phone-secret': phoneSecret },
    body: { clientId, userId: 'user-e2e' },
  });
  assert.equal(ticket.status, 201);

  const ws = new WebSocket(ticket.json.url);
  ws.binaryType = 'arraybuffer';
  const control = [];
  const binary = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) binary.push(Buffer.from(data));
    else control.push(JSON.parse(data.toString()));
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  t.after(() => ws.close());

  // A burned ticket cannot be reused.
  const replayWs = new WebSocket(ticket.json.url);
  const replayClose = await new Promise((resolve) => {
    replayWs.once('close', (codeNum) => resolve(codeNum));
    replayWs.once('error', () => {});
  });
  assert.equal(replayClose, 4001, 'reused tickets must close with 4001');

  // 5. E2E handshake + term_open ---------------------------------------------------
  const channel = new BrowserChannel();
  ws.send(
    JSON.stringify({
      type: 'term_open',
      cols: 100,
      rows: 30,
      clientId: 'spoof-should-be-overwritten',
      clientPub: b64(channel.publicKey),
      clientSalt: b64(channel.salt),
      shell: '/bin/sh',
    }),
  );

  const termKey = await waitFor(
    () => control.find((f) => f.type === 'term_key'),
    15_000,
    'term_key',
  );
  assert.equal(termKey.clientId, clientId, 'the relay stamps the real clientId');
  await channel.finish(deviceId, clientId, termKey.devicePub, termKey.deviceSalt);

  const ready = await waitFor(
    () => control.find((f) => f.type === 'term_ready'),
    15_000,
    'term_ready',
  );
  assert.equal(ready.pty, true, 'must be a real PTY on POSIX');
  assert.equal(ready.backend, 'posix');
  const sessionId = ready.sessionId;

  // 6. encrypted keystrokes → encrypted PTY output ---------------------------------
  ws.send(packTerminal(sessionId, clientId, await channel.seal(utf8('echo FORGE_E2E_$((40+2))\n'))));

  const outputs = [];
  const sawMarker = async () => {
    while (binary.length) {
      const frame = unpackTerminal(binary.shift());
      assert.equal(frame.sessionId, sessionId);
      assert.equal(frame.clientId, clientId);
      outputs.push(Buffer.from(await channel.open(frame.sealed)).toString('utf8'));
    }
    return outputs.join('').includes('FORGE_E2E_42');
  };
  const outputDeadline = Date.now() + 15_000;
  while (Date.now() < outputDeadline && !(await sawMarker())) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(outputs.join('').includes('FORGE_E2E_42'), `no marker in: ${outputs.join('')}`);

  // The ciphertext on the wire must not contain the plaintext.
  assert.ok(!bridgeLog.includes('FORGE_E2E_42'), 'bridge log must not leak terminal output');

  // 7. tty check: it is a real terminal --------------------------------------------
  ws.send(packTerminal(sessionId, clientId, await channel.seal(utf8('tty\n'))));
  const ttyDeadline = Date.now() + 10_000;
  while (Date.now() < ttyDeadline && !outputs.join('').includes('/dev/')) {
    while (binary.length) {
      const frame = unpackTerminal(binary.shift());
      outputs.push(Buffer.from(await channel.open(frame.sealed)).toString('utf8'));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(outputs.join(''), /\/dev\/(pts|tty)/, 'tty must report a real terminal device');

  // 8. resize propagates -------------------------------------------------------------
  ws.send(JSON.stringify({ type: 'term_resize', sessionId, cols: 66, rows: 22 }));
  ws.send(packTerminal(sessionId, clientId, await channel.seal(utf8('stty size\n'))));
  const sizeDeadline = Date.now() + 10_000;
  while (Date.now() < sizeDeadline && !outputs.join('').includes('22 66')) {
    while (binary.length) {
      const frame = unpackTerminal(binary.shift());
      outputs.push(Buffer.from(await channel.open(frame.sealed)).toString('utf8'));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(outputs.join('').includes('22 66'), `stty did not follow resize: ${outputs.join('').slice(-300)}`);

  // 9. file RPC through the same relay (plaintext variant) --------------------------
  writeFileSync(join(home, 'hello.txt'), 'first line\nsecond line\n');
  const listing = await proxyFetch(base, `/v1/devices/${deviceId}/rpc`, {
    method: 'POST',
    headers: { 'x-forge-phone-secret': phoneSecret },
    body: {
      method: 'POST',
      path: '/api/fs/list',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(JSON.stringify({ path: home })).toString('base64'),
    },
  });
  assert.equal(listing.status, 200, JSON.stringify(listing.json).slice(0, 300));
  const names = listing.json.entries.map((entry) => entry.name);
  assert.ok(names.includes('hello.txt'), `hello.txt missing from ${names}`);

  const read = await proxyFetch(base, `/v1/devices/${deviceId}/rpc`, {
    method: 'POST',
    headers: { 'x-forge-phone-secret': phoneSecret },
    body: {
      method: 'POST',
      path: '/api/fs/read',
      bodyBase64: Buffer.from(JSON.stringify({ path: join(home, 'hello.txt') })).toString('base64'),
    },
  });
  assert.equal(read.json.lines[0].text, 'first line');
  assert.equal(read.json.lines[0].number, 1);

  // Containment through the whole stack: escaping the root is a 403.
  const escape = await proxyFetch(base, `/v1/devices/${deviceId}/rpc`, {
    method: 'POST',
    headers: { 'x-forge-phone-secret': phoneSecret },
    body: {
      method: 'POST',
      path: '/api/fs/read',
      bodyBase64: Buffer.from(JSON.stringify({ path: '/etc/passwd' })).toString('base64'),
    },
  });
  assert.equal(escape.status, 403, JSON.stringify(escape.json));
  assert.equal(escape.json.code, 'FS_OUTSIDE_ROOT');

  // 10. detach, reconnect with a new ticket, replay restores the screen -------------
  ws.send(JSON.stringify({ type: 'term_detach', sessionId }));
  ws.close();

  const ticket2 = await proxyFetch(base, `/v1/devices/${deviceId}/term-ticket`, {
    method: 'POST',
    headers: { 'x-forge-phone-secret': phoneSecret },
    body: { clientId, userId: 'user-e2e' },
  });
  const ws2 = new WebSocket(ticket2.json.url);
  const control2 = [];
  const binary2 = [];
  ws2.on('message', (data, isBinary) => {
    if (isBinary) binary2.push(Buffer.from(data));
    else control2.push(JSON.parse(data.toString()));
  });
  await new Promise((resolve, reject) => {
    ws2.once('open', resolve);
    ws2.once('error', reject);
  });
  t.after(() => ws2.close());

  const channel2 = new BrowserChannel();
  ws2.send(
    JSON.stringify({
      type: 'term_attach',
      sessionId,
      clientPub: b64(channel2.publicKey),
      clientSalt: b64(channel2.salt),
    }),
  );
  const key2 = await waitFor(() => control2.find((f) => f.type === 'term_key'), 15_000, 'term_key #2');
  await channel2.finish(deviceId, clientId, key2.devicePub, key2.deviceSalt);
  const ready2 = await waitFor(
    () => control2.find((f) => f.type === 'term_ready'),
    15_000,
    'term_ready #2',
  );
  assert.equal(ready2.resumed, true, 'the session must survive the tab');
  assert.ok(ready2.replayBytes > 0, 'replay buffer must not be empty');

  const replayed = [];
  const replayDeadline = Date.now() + 10_000;
  while (Date.now() < replayDeadline && !replayed.join('').includes('FORGE_E2E_42')) {
    while (binary2.length) {
      const frame = unpackTerminal(binary2.shift());
      replayed.push(Buffer.from(await channel2.open(frame.sealed)).toString('utf8'));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(
    replayed.join('').includes('FORGE_E2E_42'),
    'the new viewer must see the old scrollback',
  );

  // 11. the audit log recorded the terminal, never its content ----------------------
  const audit = await proxyFetch(base, `/v1/devices/${deviceId}/rpc`, {
    method: 'POST',
    headers: { 'x-forge-phone-secret': phoneSecret },
    body: { method: 'POST', path: '/api/bridge/audit', bodyBase64: Buffer.from('{}').toString('base64') },
  });
  const actions = audit.json.entries.map((entry) => entry.action);
  assert.ok(actions.includes('term.open'), `term.open missing from ${actions}`);
  assert.ok(actions.includes('fs.read'), 'fs.read missing');
  assert.ok(
    !JSON.stringify(audit.json).includes('FORGE_E2E_42'),
    'audit log must never contain terminal content',
  );
});
