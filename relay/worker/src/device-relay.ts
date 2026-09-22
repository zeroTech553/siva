// One Durable Object per machine: the laptop's socket plus every browser
// attached to it — the Worker edition of relay/node/src/room.mjs, on the
// WebSocket Hibernation API so idle terminals cost nothing.
//
// The DO is a router, nothing more. It reads the 33-byte routing header of
// binary frames (kind ‖ sessionId ‖ clientId) and the `type` of JSON frames,
// checks that senders only speak for their own clientId, and forwards. It
// never holds keys, never decrypts, and buffers nothing (scrollback replay
// is the laptop's job).
//
// Hibernation rules honoured here:
// - browser identity lives in serializeAttachment, restored on every wake
// - tickets and rpc state live in DO storage / memory rebuilt lazily
// - only OPEN sockets are ever written to

import type { BrowserAttachment, Env, LaptopMessage, RpcRequest, TicketRecord } from './types'
import { HttpError, hashSecret, json, readJson } from './util'

export const CLOSE_TICKET_INVALID = 4001
export const CLOSE_NOT_AUTHORIZED = 4003
export const CLOSE_DEVICE_OFFLINE = 4004
export const CLOSE_REPLACED = 4012

const KIND_TERMINAL = 0x01
const ROUTING_HEADER_BYTES = 33
const MAX_BINARY_FRAME = 45 + 64 * 1024 + 16
const TICKET_TTL_MS = 60_000

const TERM_BROWSER_TO_LAPTOP = new Set([
  'term_open',
  'term_attach',
  'term_resize',
  'term_detach',
  'term_close',
  'term_list',
  'channel_hello',
])
const TERM_LAPTOP_TO_BROWSER = new Set([
  'term_key',
  'term_ready',
  'term_eof',
  'term_error',
  'term_closed',
  'channel_key',
])

const decoder = new TextDecoder()

const ACCEPT_TIMEOUT_MS = 45_000
const DAEMON_TIMEOUT_MS = 120_000
const RPC_LIFETIME_MS = 5 * 60_000
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024

type PendingRpc = {
  stream: TransformStream<Uint8Array, Uint8Array>
  writer: WritableStreamDefaultWriter<Uint8Array>
  resolveStart: (response: Response) => void
  rejectStart: (error: Error) => void
  started: boolean
  accepted: boolean
  bytes: number
  timeout: ReturnType<typeof setTimeout>
}

export class DeviceRelay implements DurableObject {
  private daemonOnline = false
  private caps: Record<string, unknown> | null = null
  private pending = new Map<string, PendingRpc>()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // -- HTTP entry (always authorized by the Worker with the proxy secret) ---
  async fetch(request: Request) {
    if (request.headers.get('x-forge-authorized') !== this.env.WORKER_PROXY_SECRET) {
      return json({ error: 'Unauthorized relay request' }, 401)
    }
    const url = new URL(request.url)
    if (url.pathname.endsWith('/connect')) return this.connectLaptop(request)
    if (url.pathname.endsWith('/term')) return this.connectBrowser(request, url)
    if (url.pathname.endsWith('/term-ticket') && request.method === 'POST') {
      return this.mintTicket(request)
    }
    if (url.pathname.endsWith('/status')) {
      return json({
        online: this.laptop() !== null,
        daemonOnline: this.daemonOnline,
        caps: this.caps,
        browsers: this.browsers().length,
      })
    }
    if (url.pathname.endsWith('/disconnect') && request.method === 'POST') {
      this.laptop()?.close(1000, 'Device removed')
      for (const socket of this.browsers()) socket.close(CLOSE_DEVICE_OFFLINE, 'Device removed')
      this.daemonOnline = false
      this.failAll(new Error('Device removed'))
      return json({ disconnected: true })
    }
    if (url.pathname.endsWith('/rpc') && request.method === 'POST') return this.rpc(request)
    return json({ error: 'Not found' }, 404)
  }

  // -- sockets ----------------------------------------------------------------
  private connectLaptop(request: Request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426)
    }
    this.laptop()?.close(CLOSE_REPLACED, 'Replaced by a new connection')
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1], ['laptop'])
    this.daemonOnline = false
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private async mintTicket(request: Request) {
    const body = await readJson<{ clientId?: string; userId?: string }>(request)
    const clientId = String(body.clientId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new HttpError(400, 'clientId must be a UUID')
    const ticket = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
    const record: TicketRecord = {
      deviceId: new URL(request.url).pathname.split('/')[1] ?? '',
      clientId,
      userId: String(body.userId ?? ''),
      expiresAt: Date.now() + TICKET_TTL_MS,
      used: false,
    }
    await this.state.storage.put(`ticket:${await hashSecret(ticket)}`, record, {
      allowUnconfirmed: false,
    })
    return json({ ticket, expiresAt: new Date(record.expiresAt).toISOString() }, 201)
  }

  private async connectBrowser(request: Request, url: URL) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426)
    }
    // Finish the upgrade first so the browser receives a proper close code
    // instead of an opaque handshake failure.
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    const ticket = url.searchParams.get('ticket') ?? ''
    const key = `ticket:${await hashSecret(ticket)}`
    const record = ticket ? await this.state.storage.get<TicketRecord>(key) : undefined
    const valid = record && !record.used && record.expiresAt > Date.now()
    if (record) await this.state.storage.delete(key) // burn on first sight

    if (!valid) {
      this.state.acceptWebSocket(server)
      server.close(CLOSE_TICKET_INVALID, 'Ticket is invalid or was already used')
      return new Response(null, { status: 101, webSocket: client })
    }

    // Replace an earlier socket for this client (one tab per clientId).
    for (const socket of this.browsers()) {
      const attachment = this.attachment(socket)
      if (attachment?.clientId === record.clientId) {
        socket.close(CLOSE_REPLACED, 'Replaced by a new connection')
      }
    }

    this.state.acceptWebSocket(server, ['browser', `client:${record.clientId}`])
    const attachment: BrowserAttachment = {
      kind: 'browser',
      clientId: record.clientId,
      userId: record.userId,
      sessions: [],
    }
    server.serializeAttachment(attachment)
    this.send(server, JSON.stringify(this.statusFrame()))
    return new Response(null, { status: 101, webSocket: client })
  }

  // -- hibernation-safe socket handlers ---------------------------------------
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (this.isLaptop(socket)) {
      if (typeof message === 'string') this.laptopControl(socket, message)
      else this.routeBinaryFromLaptop(message)
      return
    }
    const attachment = this.attachment(socket)
    if (!attachment) return
    if (typeof message === 'string') this.browserControl(socket, attachment, message)
    else this.routeBinaryFromBrowser(attachment, message)
  }

  webSocketClose(socket: WebSocket) {
    if (this.isLaptop(socket)) {
      this.daemonOnline = false
      this.failAll(new Error('Laptop disconnected'))
      const bye = JSON.stringify({ type: 'bye', reason: 'laptop disconnected' })
      for (const browser of this.browsers()) this.send(browser, bye)
      this.broadcastStatus()
      return
    }
    // Tell the laptop so its sessions can idle out.
    const attachment = this.attachment(socket)
    const laptop = this.laptop()
    if (attachment && laptop) {
      for (const sessionId of attachment.sessions) {
        this.send(laptop, JSON.stringify({ type: 'term_detach', sessionId, clientId: attachment.clientId }))
      }
    }
  }

  webSocketError(socket: WebSocket) {
    this.webSocketClose(socket)
  }

  // -- laptop frames ------------------------------------------------------------
  private laptopControl(socket: WebSocket, raw: string) {
    let frame: LaptopMessage
    try {
      frame = JSON.parse(raw) as LaptopMessage
    } catch {
      return
    }
    const type = String(frame.type ?? '')

    if (type === 'heartbeat') {
      const heartbeat = frame as { daemonOnline?: boolean; caps?: Record<string, unknown> }
      const changed =
        this.daemonOnline !== Boolean(heartbeat.daemonOnline) ||
        JSON.stringify(this.caps) !== JSON.stringify(heartbeat.caps ?? null)
      this.daemonOnline = Boolean(heartbeat.daemonOnline)
      this.caps = heartbeat.caps ?? null
      this.send(socket, JSON.stringify({ type: 'heartbeat_ack', at: Date.now() }))
      if (changed) this.broadcastStatus()
      return
    }

    if (TERM_LAPTOP_TO_BROWSER.has(type)) {
      const clientId = String((frame as Record<string, unknown>).clientId ?? '')
      const sessionId = String((frame as Record<string, unknown>).sessionId ?? '')
      const browser = this.browserByClient(clientId)
      if (!browser) return
      this.send(browser, raw)
      const attachment = this.attachment(browser)
      if (!attachment) return
      if (type === 'term_ready' && sessionId && !attachment.sessions.includes(sessionId)) {
        attachment.sessions.push(sessionId)
        browser.serializeAttachment(attachment)
      }
      if ((type === 'term_eof' || type === 'term_closed') && sessionId) {
        attachment.sessions = attachment.sessions.filter((session) => session !== sessionId)
        browser.serializeAttachment(attachment)
      }
      return
    }

    if (type === 'term_list_result') {
      for (const browser of this.browsers()) this.send(browser, raw)
      return
    }

    if (type.startsWith('rpc_')) this.rpcFrame(frame)
  }

  private routeBinaryFromLaptop(message: ArrayBuffer) {
    const frame = parseHeader(message)
    if (!frame) return
    const browser = this.browserByClient(frame.clientId)
    if (!browser) return
    const attachment = this.attachment(browser)
    if (!attachment?.sessions.includes(frame.sessionId)) return
    this.send(browser, message)
  }

  // -- browser frames -------------------------------------------------------------
  private browserControl(socket: WebSocket, attachment: BrowserAttachment, raw: string) {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(frame.type ?? '')
    if (!TERM_BROWSER_TO_LAPTOP.has(type)) return
    const laptop = this.laptop()
    if (!laptop) {
      this.send(socket, JSON.stringify({ type: 'error', code: 'DEVICE_OFFLINE', message: 'Laptop is offline' }))
      return
    }
    // The browser only ever speaks as itself: identity comes from the ticket,
    // never from the payload.
    frame.clientId = attachment.clientId
    frame.userId = attachment.userId
    if ((type === 'term_attach' || type === 'term_open') && frame.sessionId) {
      const sessionId = String(frame.sessionId)
      if (!attachment.sessions.includes(sessionId)) {
        attachment.sessions.push(sessionId)
        socket.serializeAttachment(attachment)
      }
    }
    this.send(laptop, JSON.stringify(frame))
  }

  private routeBinaryFromBrowser(attachment: BrowserAttachment, message: ArrayBuffer) {
    const frame = parseHeader(message)
    if (!frame) return
    if (frame.clientId !== attachment.clientId) return
    if (!attachment.sessions.includes(frame.sessionId)) return
    const laptop = this.laptop()
    if (laptop) this.send(laptop, message)
  }

  // -- rpc pipeline (HTTP -> laptop -> streamed HTTP response) ---------------------
  private async rpc(request: Request) {
    const laptop = this.laptop()
    if (!laptop) return json({ error: 'Laptop is offline', code: 'LAPTOP_OFFLINE' }, 503)
    if (this.pending.size >= 16) return json({ error: 'Laptop is busy', code: 'LAPTOP_BUSY' }, 429)

    let rpc: RpcRequest
    try {
      rpc = await readJson<RpcRequest>(request)
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      throw error
    }

    const id = crypto.randomUUID()
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    let resolveStart!: (response: Response) => void
    let rejectStart!: (error: Error) => void
    const response = new Promise<Response>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    const timeout = setTimeout(
      () => this.fail(id, new Error('Laptop bridge did not accept the request in time')),
      ACCEPT_TIMEOUT_MS,
    )
    this.pending.set(id, {
      stream,
      writer: stream.writable.getWriter(),
      resolveStart,
      rejectStart,
      started: false,
      accepted: false,
      bytes: 0,
      timeout,
    })
    try {
      laptop.send(JSON.stringify({ type: 'rpc_request', id, ...rpc }))
    } catch {
      this.fail(id, new Error('Laptop connection is stale'))
      return json({ error: 'Laptop connection is stale', code: 'LAPTOP_STALE' }, 503)
    }

    try {
      return await response
    } catch (error) {
      const message = error instanceof Error ? error.message : 'RPC failed'
      const daemonDown = /daemon/i.test(message)
      return json({ error: message, code: daemonDown ? 'DAEMON_TIMEOUT' : 'LAPTOP_TIMEOUT' }, 504)
    }
  }

  private rpcFrame(payload: LaptopMessage) {
    if (!('id' in payload)) return
    const id = String(payload.id)
    const pending = this.pending.get(id)
    if (!pending) return

    if (payload.type === 'rpc_accepted') {
      if (pending.started || pending.accepted) return
      pending.accepted = true
      clearTimeout(pending.timeout)
      pending.timeout = setTimeout(
        () => this.fail(id, new Error('Local daemon did not respond')),
        DAEMON_TIMEOUT_MS,
      )
      return
    }
    if (payload.type === 'rpc_start') {
      if (pending.started) return
      pending.started = true
      pending.accepted = true
      clearTimeout(pending.timeout)
      pending.timeout = setTimeout(() => this.fail(id, new Error('RPC lifetime exceeded')), RPC_LIFETIME_MS)
      const headers = new Headers((payload as { headers?: Record<string, string> }).headers)
      headers.delete('content-length')
      headers.delete('content-encoding')
      headers.set('cache-control', 'no-store')
      headers.set('x-content-type-options', 'nosniff')
      pending.resolveStart(
        new Response(pending.stream.readable, {
          status: Number((payload as { status?: number }).status) || 502,
          headers,
        }),
      )
      return
    }
    if (payload.type === 'rpc_chunk') {
      const chunk = decodeBase64(String((payload as { bodyBase64?: string }).bodyBase64 ?? ''))
      pending.bytes += chunk.byteLength
      if (pending.bytes > MAX_RESPONSE_BYTES) {
        this.fail(id, new Error('RPC response is too large'))
        return
      }
      void pending.writer.write(chunk)
      return
    }
    if (payload.type === 'rpc_end') {
      clearTimeout(pending.timeout)
      void pending.writer.close()
      this.pending.delete(id)
      return
    }
    if (payload.type === 'rpc_error') {
      this.fail(id, new Error(String((payload as { message?: string }).message ?? 'RPC failed')))
    }
  }

  // -- socket bookkeeping -----------------------------------------------------------
  private laptop(): WebSocket | null {
    const open = this.state
      .getWebSockets('laptop')
      .filter((socket) => socket.readyState === WebSocket.OPEN)
    return open.at(-1) ?? null
  }

  private browsers(): WebSocket[] {
    return this.state
      .getWebSockets('browser')
      .filter((socket) => socket.readyState === WebSocket.OPEN)
  }

  private browserByClient(clientId: string): WebSocket | null {
    if (!clientId) return null
    const open = this.state
      .getWebSockets(`client:${clientId}`)
      .filter((socket) => socket.readyState === WebSocket.OPEN)
    return open.at(-1) ?? null
  }

  private isLaptop(socket: WebSocket): boolean {
    return this.state.getTags(socket).includes('laptop')
  }

  private attachment(socket: WebSocket): BrowserAttachment | null {
    try {
      const value = socket.deserializeAttachment() as BrowserAttachment | null
      return value?.kind === 'browser' ? value : null
    } catch {
      return null
    }
  }

  private statusFrame() {
    return {
      type: 'status',
      online: this.laptop() !== null,
      daemonOnline: this.daemonOnline,
      caps: this.caps,
      browsers: this.browsers().length,
    }
  }

  private broadcastStatus() {
    const frame = JSON.stringify(this.statusFrame())
    for (const browser of this.browsers()) this.send(browser, frame)
  }

  private send(socket: WebSocket, frame: string | ArrayBuffer) {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(frame)
    } catch {
      // A dying socket's close handler cleans up.
    }
  }

  private fail(id: string, error: Error) {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    if (pending.started) void pending.writer.abort(error)
    else pending.rejectStart(error)
    this.pending.delete(id)
  }

  private failAll(error: Error) {
    for (const id of this.pending.keys()) this.fail(id, error)
  }
}

// -- binary routing header (relay/PROTOCOL.md §Binary layout) ---------------------
function parseHeader(message: ArrayBuffer): { sessionId: string; clientId: string } | null {
  if (message.byteLength < ROUTING_HEADER_BYTES || message.byteLength > MAX_BINARY_FRAME) return null
  const bytes = new Uint8Array(message)
  if (bytes[0] !== KIND_TERMINAL) return null
  return {
    sessionId: uuidFromBytes(bytes.subarray(1, 17)),
    clientId: uuidFromBytes(bytes.subarray(17, 33)),
  }
}

function uuidFromBytes(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function decodeBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
