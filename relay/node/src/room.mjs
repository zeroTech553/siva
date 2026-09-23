// One Room per machine: the laptop's socket plus every browser attached to it.
//
// The room is a router, nothing more. It reads the 33-byte routing header of
// binary frames (kind ‖ sessionId ‖ clientId) and the `type` of JSON frames,
// checks that senders only speak for their own clientId, and forwards. It
// never holds keys, never decrypts, and buffers nothing (scrollback replay is
// the laptop's job, so ciphertext is never retained for clients that may not
// hold a key). The Durable Object in relay/worker implements this same class
// shape on top of hibernation APIs.

export const CLOSE_TICKET_INVALID = 4001;
export const CLOSE_NOT_AUTHORIZED = 4003;
export const CLOSE_DEVICE_OFFLINE = 4004;
export const CLOSE_RATE_LIMITED = 4009;
export const CLOSE_REPLACED = 4012;

const KIND_TERMINAL = 0x01;
const ROUTING_HEADER_BYTES = 33;
const MAX_BINARY_FRAME = 45 + 64 * 1024 + 16;
const TERM_BROWSER_TO_LAPTOP = new Set([
  'term_open',
  'term_attach',
  'term_resize',
  'term_detach',
  'term_close',
  'term_list',
  'channel_hello',
]);
const TERM_LAPTOP_TO_BROWSER = new Set([
  'term_key',
  'term_ready',
  'term_eof',
  'term_error',
  'term_closed',
  'channel_key',
]);

function uuidFromBytes(bytes) {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class Room {
  constructor(deviceId, { onEmpty } = {}) {
    this.deviceId = deviceId;
    this.laptop = null; // { socket, caps, daemonOnline, connectedAt }
    this.browsers = new Map(); // clientId -> { socket, userId, sessions:Set<sessionId> }
    this.onEmpty = onEmpty;
  }

  // -- presence -------------------------------------------------------------
  get online() {
    return Boolean(this.laptop && this.laptop.socket.readyState === this.laptop.socket.OPEN);
  }

  get daemonOnline() {
    return Boolean(this.laptop?.daemonOnline);
  }

  get caps() {
    return this.laptop?.caps ?? null;
  }

  status() {
    return {
      type: 'status',
      online: this.online,
      daemonOnline: this.daemonOnline,
      caps: this.caps,
      browsers: this.browsers.size,
    };
  }

  broadcastStatus() {
    const frame = JSON.stringify(this.status());
    for (const browser of this.browsers.values()) {
      this.sendRaw(browser.socket, frame);
    }
  }

  sendRaw(socket, frame) {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(frame);
      } catch {
        // A dying socket's close handler will clean up.
      }
    }
  }

  // -- laptop side ------------------------------------------------------------
  attachLaptop(socket) {
    if (this.laptop && this.laptop.socket !== socket) {
      try {
        this.laptop.socket.close(CLOSE_REPLACED, 'Replaced by a new connection');
      } catch {
        /* already gone */
      }
    }
    this.laptop = { socket, caps: null, daemonOnline: false, connectedAt: Date.now() };

    socket.on('message', (data, isBinary) => this.fromLaptop(data, isBinary));
    socket.on('close', () => {
      if (this.laptop?.socket === socket) {
        this.laptop = null;
        for (const [clientId, browser] of this.browsers) {
          this.sendRaw(
            browser.socket,
            JSON.stringify({ type: 'bye', reason: 'laptop disconnected' }),
          );
          void clientId;
        }
        this.broadcastStatus();
        this.maybeEmpty();
      }
    });
    this.broadcastStatus();
  }

  fromLaptop(data, isBinary) {
    if (isBinary) {
      this.routeBinary(data, { fromLaptop: true });
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    const type = String(frame.type ?? '');

    if (type === 'heartbeat') {
      const changed =
        this.laptop &&
        (this.laptop.daemonOnline !== Boolean(frame.daemonOnline) ||
          JSON.stringify(this.laptop.caps) !== JSON.stringify(frame.caps ?? null));
      if (this.laptop) {
        this.laptop.daemonOnline = Boolean(frame.daemonOnline);
        this.laptop.caps = frame.caps ?? null;
      }
      this.sendRaw(this.laptop.socket, JSON.stringify({ type: 'heartbeat_ack', at: Date.now() }));
      if (changed) this.broadcastStatus();
      return;
    }

    if (TERM_LAPTOP_TO_BROWSER.has(type)) {
      const clientId = String(frame.clientId ?? '');
      const browser = this.browsers.get(clientId);
      if (browser) {
        this.sendRaw(browser.socket, JSON.stringify(frame));
        if (type === 'term_ready' && frame.sessionId) {
          browser.sessions.add(String(frame.sessionId));
        }
        if ((type === 'term_eof' || type === 'term_closed') && frame.sessionId) {
          browser.sessions.delete(String(frame.sessionId));
        }
      }
      return;
    }

    if (type === 'term_list_result') {
      // Fan out: whoever asked most recently gets it; harmless to all.
      for (const browser of this.browsers.values()) {
        this.sendRaw(browser.socket, JSON.stringify(frame));
      }
      return;
    }

    // rpc_* frames are handled by the HTTP rpc pipeline, which registers its
    // own listener; ignore here.
  }

  // -- browser side -------------------------------------------------------------
  attachBrowser(socket, { clientId, userId }) {
    const existing = this.browsers.get(clientId);
    if (existing && existing.socket !== socket) {
      try {
        existing.socket.close(CLOSE_REPLACED, 'Replaced by a new connection');
      } catch {
        /* already gone */
      }
    }
    const browser = { socket, userId, sessions: new Set() };
    this.browsers.set(clientId, browser);

    socket.on('message', (data, isBinary) => this.fromBrowser(clientId, data, isBinary));
    socket.on('close', () => {
      if (this.browsers.get(clientId)?.socket === socket) {
        this.browsers.delete(clientId);
        // Tell the laptop so sessions can idle out.
        if (this.online) {
          for (const sessionId of browser.sessions) {
            this.sendRaw(
              this.laptop.socket,
              JSON.stringify({ type: 'term_detach', sessionId, clientId }),
            );
          }
        }
        this.maybeEmpty();
      }
    });

    this.sendRaw(socket, JSON.stringify(this.status()));
  }

  fromBrowser(clientId, data, isBinary) {
    if (isBinary) {
      this.routeBinary(data, { fromLaptop: false, clientId });
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    const type = String(frame.type ?? '');
    if (!TERM_BROWSER_TO_LAPTOP.has(type)) return;
    if (!this.online) {
      const browser = this.browsers.get(clientId);
      if (browser) {
        this.sendRaw(
          browser.socket,
          JSON.stringify({ type: 'error', code: 'DEVICE_OFFLINE', message: 'Laptop is offline' }),
        );
      }
      return;
    }
    // The browser only ever speaks as itself: clientId and userId are stamped
    // from the authenticated socket, never trusted from the payload.
    const browser = this.browsers.get(clientId);
    frame.clientId = clientId;
    frame.userId = browser?.userId ?? '';
    if (type === 'term_attach' || type === 'term_open') {
      if (frame.sessionId) browser?.sessions.add(String(frame.sessionId));
    }
    this.sendRaw(this.laptop.socket, JSON.stringify(frame));
  }

  // -- binary routing --------------------------------------------------------------
  routeBinary(data, { fromLaptop, clientId }) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length < ROUTING_HEADER_BYTES || buffer.length > MAX_BINARY_FRAME) return;
    if (buffer[0] !== KIND_TERMINAL) return;
    const frameSession = uuidFromBytes(buffer.subarray(1, 17));
    const frameClient = uuidFromBytes(buffer.subarray(17, 33));

    if (fromLaptop) {
      // Laptop -> exactly the browser named in the header, and only if that
      // browser is attached to the session the frame claims.
      const browser = this.browsers.get(frameClient);
      if (!browser) return;
      if (!browser.sessions.has(frameSession)) return;
      this.sendRaw(browser.socket, buffer);
      return;
    }

    // Browser -> laptop. The sender may only use its own clientId (the socket
    // identity), and only for sessions it is attached to.
    if (frameClient !== clientId) return;
    const browser = this.browsers.get(clientId);
    if (!browser || !browser.sessions.has(frameSession)) return;
    if (!this.online) return;
    this.sendRaw(this.laptop.socket, buffer);
  }

  // -- rpc passthrough (HTTP -> laptop -> HTTP) -----------------------------------
  laptopSocket() {
    return this.online ? this.laptop.socket : null;
  }

  maybeEmpty() {
    if (!this.laptop && this.browsers.size === 0) this.onEmpty?.(this.deviceId);
  }
}
