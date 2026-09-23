// Browser-side crypto peer, used by bridge/tests/test_crypto_interop.py.
//
// This is the *real* browser stack (@noble/curves X25519 + WebCrypto AES-GCM),
// not a re-implementation, so the interop test proves the Python bridge and the
// TypeScript client can actually talk to each other.
//
// Protocol: line-delimited JSON on stdin/stdout.
//   in  1: {deviceId, clientId, pythonPublicKey, pythonSalt}
//   out 2: {nodePublicKey, nodeSalt, sealed[], plaintexts[]}
//   in  3: {sealed[]}
//   out 4: {opened[], errors[]}

import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createInterface } from 'node:readline';

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const utf8 = (s) => new TextEncoder().encode(s);

function nonce(salt, counter) {
  const out = new Uint8Array(12);
  out.set(salt.subarray(0, 4), 0);
  const view = new DataView(out.buffer);
  view.setBigUint64(4, BigInt(counter), false);
  return out;
}

function deriveKey(ourSecret, theirPublic, deviceId, clientId, saltBytes) {
  const shared = x25519.getSharedSecret(ourSecret, theirPublic);
  const salt = sha256(utf8(deviceId));
  const info = utf8(`forge-e2e-v2:${deviceId}:${clientId}`);
  return hkdf(sha256, shared, salt, info, 32);
}

async function importKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function main() {
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();

  const hello = JSON.parse((await lines.next()).value);
  const secret = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secret);
  const nodeSalt = crypto.getRandomValues(new Uint8Array(4));
  const peerSalt = unb64(hello.pythonSalt);

  const raw = deriveKey(
    secret,
    unb64(hello.pythonPublicKey),
    hello.deviceId,
    hello.clientId,
  );
  const key = await importKey(raw);

  // Seal two frames with an incrementing counter, exactly like the browser.
  const plaintexts = ['ls -la\n', JSON.stringify({ cols: 132, rows: 43 })];
  const sealed = [];
  for (let i = 0; i < plaintexts.length; i += 1) {
    const iv = nonce(nodeSalt, i);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      utf8(plaintexts[i]),
    );
    sealed.push(b64(new Uint8Array([...iv, ...new Uint8Array(ct)])));
  }

  process.stdout.write(
    JSON.stringify({
      nodePublicKey: b64(publicKey),
      nodeSalt: b64(nodeSalt),
      sealed,
      plaintexts,
      keyLength: raw.length,
    }) + '\n',
  );

  // Now open whatever Python sends back. Like the real client, enforce nonce
  // discipline: the incoming nonce must equal peerSalt ‖ expected counter, so
  // replayed or reordered frames are refused even though AES-GCM decryption
  // alone would happily accept a repeated nonce.
  let recvCounter = 0;
  const next = await lines.next();
  if (!next.done && next.value) {
    const request = JSON.parse(next.value);
    const openedB64 = [];
    const errors = [];
    for (let i = 0; i < request.sealed.length; i += 1) {
      const blob = unb64(request.sealed[i]);
      try {
        const iv = blob.subarray(0, 12);
        const expected = nonce(peerSalt, recvCounter);
        if (Buffer.compare(Buffer.from(iv), Buffer.from(expected)) !== 0) {
          throw new Error(`unexpected nonce (counter ${recvCounter})`);
        }
        const ct = blob.subarray(12);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        recvCounter += 1;
        // Returned as base64 so binary PTY output can be compared byte-exactly.
        openedB64.push(b64(new Uint8Array(pt)));
      } catch (error) {
        errors.push(String(error?.message ?? error));
      }
    }
    process.stdout.write(
      JSON.stringify({
        openedB64,
        opened: openedB64.map((value) => new TextDecoder().decode(unb64(value))),
        errors,
      }) + '\n',
    );
  }
  rl.close();
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ fatal: String(error?.message ?? error) }) + '\n');
  process.exit(1);
});
