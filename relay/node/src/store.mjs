// In-memory store for the Node relay.
//
// This relay is for development and small self-hosted deployments, so state
// lives in maps and dies with the process — the laptop bridge reconnects and
// re-pairs devices survive because device records can optionally be persisted
// to a JSON file (FORGE_RELAY_STATE). The Worker relay uses D1 + Durable
// Object storage for the same shapes.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const PAIR_TTL_MS = 10 * 60_000;
export const TICKET_TTL_MS = 60_000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function sha256(value) {
  return createHash('sha256').update(value).digest('base64url');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function randomCode() {
  const raw = Array.from(randomBytes(9), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  return `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6, 9)}`;
}

export function normalizeCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code) ? code : null;
}

export class Store {
  constructor(statePath = '') {
    this.pairings = new Map(); // code -> {phoneSecretHash, createdAt, expiresAt, claimedAt, deviceId}
    this.devices = new Map(); // deviceId -> {id, name, platform, phoneSecretHash, deviceTokenHash, ownerUserId, createdAt, lastSeenAt, revokedAt}
    this.tickets = new Map(); // ticketHash -> {deviceId, clientId, userId, expiresAt, used}
    this.rate = new Map(); // key -> {windowStartedAt, count}
    this.statePath = statePath;
    if (statePath) this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8'));
      for (const device of raw.devices ?? []) this.devices.set(device.id, device);
    } catch {
      // First run: no state file yet.
    }
  }

  persist() {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(
        this.statePath,
        JSON.stringify({ devices: [...this.devices.values()] }, null, 2),
      );
    } catch {
      // Persistence is best-effort in the dev relay.
    }
  }

  // -- rate limiting (fixed window, same shape as the Worker) --------------
  consumeRate(key, limit, windowMs) {
    const now = Date.now();
    const row = this.rate.get(key);
    if (!row || now - row.windowStartedAt >= windowMs) {
      this.rate.set(key, { windowStartedAt: now, count: 1 });
      return true;
    }
    if (row.count >= limit) return false;
    row.count += 1;
    return true;
  }

  // -- pairing --------------------------------------------------------------
  createPairing() {
    const now = Date.now();
    const phoneSecret = randomToken();
    let code = randomCode();
    for (let attempts = 0; this.pairings.has(code) && attempts < 4; attempts += 1) {
      code = randomCode();
    }
    this.pairings.set(code, {
      phoneSecretHash: sha256(phoneSecret),
      createdAt: now,
      expiresAt: now + PAIR_TTL_MS,
      claimedAt: null,
      deviceId: null,
    });
    return { code, phoneSecret, expiresAt: new Date(now + PAIR_TTL_MS).toISOString() };
  }

  claimPairing(code, { name, platform }) {
    const normalized = normalizeCode(code);
    if (!normalized) return { error: 'Invalid pairing code', status: 400 };
    const pairing = this.pairings.get(normalized);
    const now = Date.now();
    if (!pairing || pairing.expiresAt <= now) return { error: 'Pairing code expired', status: 410 };
    if (pairing.claimedAt || pairing.deviceId) {
      return { error: 'Pairing code was already claimed', status: 409 };
    }
    const deviceId = randomUUID();
    const deviceToken = randomToken();
    pairing.claimedAt = now;
    pairing.deviceId = deviceId;
    this.devices.set(deviceId, {
      id: deviceId,
      name: cleanLabel(name, 'Forge laptop'),
      platform: cleanLabel(platform, 'unknown'),
      phoneSecretHash: pairing.phoneSecretHash,
      deviceTokenHash: sha256(deviceToken),
      ownerUserId: '',
      createdAt: now,
      lastSeenAt: null,
      revokedAt: null,
    });
    this.persist();
    return { deviceId, deviceToken };
  }

  pairingStatus(code, phoneSecret) {
    const normalized = normalizeCode(code);
    const pairing = normalized ? this.pairings.get(normalized) : null;
    if (!pairing || !phoneSecret || !safeEqual(sha256(phoneSecret), pairing.phoneSecretHash)) {
      return null;
    }
    return pairing;
  }

  // -- devices ----------------------------------------------------------------
  device(deviceId) {
    const device = this.devices.get(String(deviceId ?? ''));
    return device && !device.revokedAt ? device : null;
  }

  authorizedDevice(deviceId, phoneSecret) {
    const device = this.device(deviceId);
    if (!device || !phoneSecret) return null;
    if (!safeEqual(sha256(phoneSecret), device.phoneSecretHash)) return null;
    return device;
  }

  deviceByToken(deviceId, token) {
    const device = this.device(deviceId);
    if (!device || !token) return null;
    if (!safeEqual(sha256(token), device.deviceTokenHash)) return null;
    return device;
  }

  claimOwner(deviceId, userId) {
    const device = this.device(deviceId);
    if (!device) return false;
    if (device.ownerUserId && device.ownerUserId !== userId) return false;
    device.ownerUserId = String(userId ?? '');
    this.persist();
    return true;
  }

  revokeDevice(deviceId) {
    const device = this.devices.get(String(deviceId ?? ''));
    if (!device) return false;
    device.revokedAt = Date.now();
    this.persist();
    return true;
  }

  touchDevice(deviceId) {
    const device = this.device(deviceId);
    if (device) device.lastSeenAt = Date.now();
  }

  // -- terminal tickets --------------------------------------------------------
  mintTicket(deviceId, { clientId, userId }) {
    const ticket = randomToken(24);
    this.tickets.set(sha256(ticket), {
      deviceId: String(deviceId),
      clientId: String(clientId ?? ''),
      userId: String(userId ?? ''),
      expiresAt: Date.now() + TICKET_TTL_MS,
      used: false,
    });
    return { ticket, expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString() };
  }

  burnTicket(deviceId, ticket) {
    const key = sha256(String(ticket ?? ''));
    const record = this.tickets.get(key);
    if (!record) return null;
    if (record.used || record.expiresAt <= Date.now() || record.deviceId !== String(deviceId)) {
      this.tickets.delete(key);
      return null;
    }
    record.used = true;
    this.tickets.delete(key);
    return record;
  }

  sweep() {
    const now = Date.now();
    for (const [code, pairing] of this.pairings) {
      if (pairing.expiresAt <= now - PAIR_TTL_MS) this.pairings.delete(code);
    }
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(key);
    }
  }
}

function cleanLabel(value, fallback) {
  const clean = String(value ?? '')
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 80);
  return clean || fallback;
}
