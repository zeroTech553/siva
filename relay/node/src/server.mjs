#!/usr/bin/env node
// Forge relay — Node edition, for local development and small self-hosts.
//
// Implements relay/PROTOCOL.md over one process:
//
//   HTTP  (proxy secret)   POST /v1/pairs            mint a pairing code
//                          POST /v1/pairs/claim      laptop claims it
//                          GET  /v1/pairs/status
//                          GET  /v1/devices/:id      status
//                          DELETE /v1/devices/:id    revoke
//                          POST /v1/devices/:id/rpc  agent-console / files RPC
//                          POST /v1/devices/:id/term-ticket   mint a WS ticket
//                          GET  /health
//   WSS   (device token)   /v1/devices/:id/connect   the laptop
//   WSS   (single-use ticket) /v1/devices/:id/term   a browser terminal
//
// Environment:
//   PORT                     listen port     (default 8787)
//   HOST                     bind address    (default 0.0.0.0)
//   WORKER_PROXY_SECRET      shared secret the Next.js proxy must present
//   FORGE_RELAY_STATE        optional JSON file to persist device records

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { RpcHub } from './rpc.mjs';
import { CLOSE_TICKET_INVALID, Room } from './room.mjs';
import { Store, safeEqual } from './store.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY = 1_400_000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function createRelay({
  statePath = process.env.FORGE_RELAY_STATE ?? '',
  proxySecret = process.env.WORKER_PROXY_SECRET ?? '',
} = {}) {
  const store = new Store(statePath);
  const rooms = new Map(); // deviceId -> Room
  const hubs = new Map(); // deviceId -> RpcHub

  const room = (deviceId) => {
    let existing = rooms.get(deviceId);
    if (!existing) {
      existing = new Room(deviceId, {
        onEmpty: (id) => {
          rooms.delete(id);
          hubs.delete(id);
        },
      });
      rooms.set(deviceId, existing);
    }
    return existing;
  };
  const hub = (deviceId) => {
    let existing = hubs.get(deviceId);
    if (!existing) {
      existing = new RpcHub();
      hubs.set(deviceId, existing);
    }
    return existing;
  };

  setInterval(() => store.sweep(), 60_000).unref();

  // -- HTTP --------------------------------------------------------------------
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'relay'}`);
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
    };

    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        send(200, { ok: true, service: 'forge-relay-node', rooms: rooms.size });
        return;
      }

      if (!proxySecret || !safeEqual(req.headers['x-forge-proxy-secret'] ?? '', proxySecret)) {
        send(401, { error: 'Invalid proxy credential' });
        return;
      }

      if (url.pathname === '/v1/pairs' && req.method === 'POST') {
        if (!store.consumeRate(`create:${clientKey(req)}`, 12, 60_000)) {
          send(429, { error: 'Too many requests' });
          return;
        }
        const pairing = store.createPairing();
        send(201, pairing);
        return;
      }

      if (url.pathname === '/v1/pairs/claim' && req.method === 'POST') {
        if (!store.consumeRate(`claim:${clientKey(req)}`, 30, 60_000)) {
          send(429, { error: 'Too many requests' });
          return;
        }
        const body = await readJson(req);
        const result = store.claimPairing(body.code, body);
        if (result.error) {
          send(result.status, { error: result.error });
          return;
        }
        const wsUrl = new URL(url);
        wsUrl.protocol = 'ws:';
        wsUrl.pathname = `/v1/devices/${result.deviceId}/connect`;
        wsUrl.search = `token=${encodeURIComponent(result.deviceToken)}`;
        send(201, {
          deviceId: result.deviceId,
          deviceToken: result.deviceToken,
          workerWebSocketUrl: wsUrl.toString(),
        });
        return;
      }

      if (url.pathname === '/v1/pairs/status' && req.method === 'GET') {
        const pairing = store.pairingStatus(
          url.searchParams.get('code'),
          req.headers['x-forge-phone-secret'] ?? '',
        );
        if (!pairing) {
          send(404, { error: 'Pairing session not found' });
          return;
        }
        if (!pairing.deviceId) {
          if (pairing.expiresAt <= Date.now()) {
            send(200, { status: 'expired' });
            return;
          }
          send(200, {
            status: 'waiting',
            expiresAt: new Date(pairing.expiresAt).toISOString(),
          });
          return;
        }
        const device = store.device(pairing.deviceId);
        const deviceRoom = rooms.get(pairing.deviceId);
        send(200, {
          status: deviceRoom?.online ? 'online' : 'claimed',
          device: publicDevice(device, deviceRoom),
        });
        return;
      }

      const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)(?:\/(rpc|term-ticket|owner))?$/);
      if (deviceMatch) {
        const deviceId = deviceMatch[1];
        const action = deviceMatch[2];
        const phoneSecret = req.headers['x-forge-phone-secret'] ?? '';
        const device = store.authorizedDevice(deviceId, phoneSecret);
        if (!device) {
          send(404, { error: 'Device not found' });
          return;
        }
        const deviceRoom = rooms.get(deviceId);

        if (!action && req.method === 'GET') {
          send(200, { device: publicDevice(device, deviceRoom) });
          return;
        }
        if (!action && req.method === 'DELETE') {
          store.revokeDevice(deviceId);
          deviceRoom?.laptopSocket()?.close(1000, 'Device removed');
          send(200, { removed: true });
          return;
        }
        if (action === 'owner' && req.method === 'POST') {
          const body = await readJson(req);
          const ok = store.claimOwner(deviceId, String(body.userId ?? ''));
          send(ok ? 200 : 409, ok ? { ownerUserId: String(body.userId ?? '') } : { error: 'Device already belongs to another account' });
          return;
        }
        if (action === 'term-ticket' && req.method === 'POST') {
          if (!store.consumeRate(`ticket:${deviceId}`, 30, 60_000)) {
            send(429, { error: 'Too many requests' });
            return;
          }
          const body = await readJson(req);
          const clientId = String(body.clientId ?? '');
          if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
            send(400, { error: 'clientId must be a UUID' });
            return;
          }
          const ticket = store.mintTicket(deviceId, {
            clientId,
            userId: String(body.userId ?? ''),
          });
          const wsUrl = new URL(url);
          wsUrl.protocol = 'ws:';
          wsUrl.pathname = `/v1/devices/${deviceId}/term`;
          wsUrl.search = `ticket=${encodeURIComponent(ticket.ticket)}`;
          send(201, { ...ticket, url: wsUrl.toString() });
          return;
        }
        if (action === 'rpc' && req.method === 'POST') {
          if (!store.consumeRate(`rpc:${deviceId}`, 240, 60_000)) {
            send(429, { error: 'Too many requests' });
            return;
          }
          const socket = deviceRoom?.laptopSocket();
          if (!socket) {
            send(503, { error: 'Laptop is offline', code: 'LAPTOP_OFFLINE' });
            return;
          }
          const body = await readJson(req);
          const method = String(body.method ?? '').toUpperCase();
          if (!body.data && !ALLOWED_METHODS.has(method)) {
            send(400, { error: 'Unsupported RPC method' });
            return;
          }
          if (!body.data && !isSafePath(body.path)) {
            send(400, { error: 'Invalid RPC path' });
            return;
          }
          dispatchRpc(hub(deviceId), socket, body, res);
          return;
        }
      }

      send(404, { error: 'Not found' });
    } catch (error) {
      send(500, { error: String(error?.message ?? error), code: 'RELAY_EXCEPTION' });
    }
  });

  // -- WebSockets -----------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 45 + 64 * 1024 + 64 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'relay'}`);
    const laptopMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/connect$/);
    const termMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/term$/);

    if (laptopMatch) {
      const device = store.deviceByToken(laptopMatch[1], url.searchParams.get('token') ?? '');
      if (!device) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        store.touchDevice(device.id);
        const deviceRoom = room(device.id);
        deviceRoom.attachLaptop(ws);
        hub(device.id).listen(ws);
      });
      return;
    }

    if (termMatch) {
      const ticket = store.burnTicket(termMatch[1], url.searchParams.get('ticket') ?? '');
      if (!ticket) {
        // Finish the upgrade so the browser gets a proper close code instead
        // of a network error it cannot distinguish from a dead relay.
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.close(CLOSE_TICKET_INVALID, 'Ticket invalid or expired');
        });
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        room(termMatch[1]).attachBrowser(ws, {
          clientId: ticket.clientId,
          userId: ticket.userId,
        });
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  return { server, store, rooms };
}

// -- helpers -----------------------------------------------------------------------

function dispatchRpc(rpcHub, socket, body, res) {
  let responded = false;
  rpcHub.dispatch(
    socket,
    {
      method: body.method,
      path: body.path,
      headers: body.headers,
      bodyBase64: body.bodyBase64,
      clientId: body.clientId,
      data: body.data,
    },
    {
      onStart: (status, headers) => {
        responded = true;
        const safe = {};
        for (const [name, value] of Object.entries(headers)) {
          const key = name.toLowerCase();
          if (key === 'content-length' || key === 'content-encoding' || key === 'transfer-encoding') continue;
          safe[key] = value;
        }
        safe['cache-control'] = 'no-store';
        safe['x-content-type-options'] = 'nosniff';
        res.writeHead(status, safe);
      },
      onChunk: (chunk) => {
        res.write(chunk);
      },
      onEnd: () => {
        res.end();
      },
      onError: (message, code, started) => {
        if (started) {
          res.destroy();
          return;
        }
        if (responded) return;
        responded = true;
        const status = code === 'LAPTOP_BUSY' ? 429 : code === 'LAPTOP_OFFLINE' ? 503 : 504;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: message, code: code || 'LAPTOP_TIMEOUT' }));
      },
    },
  );
}

function isSafePath(path) {
  const text = String(path ?? '');
  return text.startsWith('/') && !text.includes('..') && text.length <= 2048;
}

function clientKey(req) {
  return String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown',
  );
}

function publicDevice(device, deviceRoom) {
  if (!device) return null;
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    online: Boolean(deviceRoom?.online),
    daemonOnline: Boolean(deviceRoom?.daemonOnline),
    caps: deviceRoom?.caps ?? null,
    ownerUserId: device.ownerUserId || null,
    createdAt: new Date(device.createdAt).toISOString(),
    lastSeenAt: device.lastSeenAt ? new Date(device.lastSeenAt).toISOString() : null,
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

// -- boot ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  if (!process.env.WORKER_PROXY_SECRET) {
    console.error('WORKER_PROXY_SECRET is required (the Next.js proxy authenticates with it)');
    process.exit(1);
  }
  const { server } = createRelay();
  server.listen(PORT, HOST, () => {
    console.log(`forge-relay-node listening on ${HOST}:${PORT}`);
  });
}
