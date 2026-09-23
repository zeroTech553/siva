// RPC pipeline: HTTP request in, laptop frames out, HTTP response streamed back.
//
// Same shape and limits as the Durable Object implementation, so the browser
// cannot tell which relay it is talking to:
//
//   proxy -> { type:"rpc_request", id, method, path, headers?, bodyBase64?, clientId?, data? }
//   laptop -> rpc_accepted -> rpc_start -> rpc_chunk* -> rpc_end | rpc_error

import { randomUUID } from 'node:crypto';

export const ACCEPT_TIMEOUT_MS = 45_000;
export const DAEMON_TIMEOUT_MS = 120_000;
export const RPC_LIFETIME_MS = 5 * 60_000;
export const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
export const MAX_CONCURRENT = 16;

export class RpcHub {
  constructor() {
    this.pending = new Map(); // id -> pending record
  }

  /** Wire a laptop socket's rpc_* frames into this hub. */
  listen(socket) {
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      const id = String(frame.id ?? '');
      if (!id || !String(frame.type ?? '').startsWith('rpc_')) return;
      const pending = this.pending.get(id);
      if (!pending) return;

      if (frame.type === 'rpc_accepted') {
        if (pending.started || pending.accepted) return;
        pending.accepted = true;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(
          () => this.fail(id, 'Local daemon did not respond', 'DAEMON_TIMEOUT'),
          DAEMON_TIMEOUT_MS,
        );
        return;
      }
      if (frame.type === 'rpc_start') {
        if (pending.started) return;
        pending.started = true;
        pending.accepted = true;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(
          () => this.fail(id, 'RPC lifetime exceeded', 'LAPTOP_TIMEOUT'),
          RPC_LIFETIME_MS,
        );
        pending.onStart(Number(frame.status) || 502, frame.headers ?? {});
        return;
      }
      if (frame.type === 'rpc_chunk') {
        let chunk;
        try {
          chunk = Buffer.from(String(frame.bodyBase64 ?? ''), 'base64');
        } catch {
          return;
        }
        pending.bytes += chunk.length;
        if (pending.bytes > MAX_RESPONSE_BYTES) {
          this.fail(id, 'RPC response is too large', 'RESPONSE_TOO_LARGE');
          return;
        }
        pending.onChunk(chunk);
        return;
      }
      if (frame.type === 'rpc_end') {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.onEnd();
        return;
      }
      if (frame.type === 'rpc_error') {
        this.fail(id, String(frame.message ?? 'RPC failed'), String(frame.code ?? ''));
      }
    };
    socket.on('message', onMessage);
    socket.on('close', () => this.failAll('Laptop disconnected', 'LAPTOP_OFFLINE'));
    return () => socket.off('message', onMessage);
  }

  /**
   * Send one RPC. Handlers stream the response:
   *   onStart(status, headers), onChunk(buffer), onEnd(), onError(message, code)
   */
  dispatch(socket, request, handlers) {
    if (this.pending.size >= MAX_CONCURRENT) {
      handlers.onError('Laptop is busy', 'LAPTOP_BUSY');
      return null;
    }
    const id = randomUUID();
    const pending = {
      ...handlers,
      accepted: false,
      started: false,
      bytes: 0,
      timer: setTimeout(
        () => this.fail(id, 'Laptop bridge did not accept the request in time', 'LAPTOP_TIMEOUT'),
        ACCEPT_TIMEOUT_MS,
      ),
    };
    this.pending.set(id, pending);
    try {
      socket.send(JSON.stringify({ type: 'rpc_request', id, ...request }));
    } catch {
      this.fail(id, 'Laptop connection is stale', 'LAPTOP_STALE');
      return null;
    }
    return id;
  }

  fail(id, message, code) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.onError(message, code, pending.started);
  }

  failAll(message, code) {
    for (const id of [...this.pending.keys()]) this.fail(id, message, code);
  }
}
