// One live terminal: ticket → WebSocket → E2E handshake → encrypted PTY I/O.
//
//   browser ──POST /api/devices/{id}/terminal-ticket──▶ Next.js ──▶ relay
//   browser ◀───────────── { url, ticket } ────────────┘
//   browser ══ WebSocket(url) ══▶ relay ══▶ laptop bridge ══▶ real PTY
//
// The class owns the socket, the crypto channel and reconnection. Everything
// the UI needs arrives through the callbacks; everything the user types goes
// through send(). Frames are sealed with TerminalChannel before they touch
// the wire, so the relay only ever routes ciphertext.

import { ChannelError, TerminalChannel, toBase64 } from '@/lib/client/terminal-crypto'
import { packTerminal, unpackTerminal } from '@/lib/client/terminal-frames'

const CLIENT_ID_KEY = 'forge.terminal.clientId'
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000

export type TerminalStatus =
  | 'connecting' // ticket minted, socket dialing, handshake pending
  | 'ready' // PTY is live; keystrokes flow
  | 'reconnecting' // lost the socket; retrying with a fresh ticket
  | 'offline' // the laptop is not connected to the relay
  | 'closed' // shell exited or the user closed the session

export type TerminalCallbacks = {
  onOutput: (data: Uint8Array) => void
  onStatus: (status: TerminalStatus, detail?: string) => void
  onReady?: (info: { sessionId: string; shell: string; cwd: string; cols: number; rows: number }) => void
  onExit?: (exitCode: number | null) => void
}

export type TerminalOptions = {
  deviceId: string
  phoneSecret: string
  cols: number
  rows: number
  cwd?: string
  shell?: string
}

/** Stable per-browser client id — the laptop remembers it across reconnects. */
export function terminalClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY)
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing
    const fresh = crypto.randomUUID()
    localStorage.setItem(CLIENT_ID_KEY, fresh)
    return fresh
  } catch {
    return crypto.randomUUID()
  }
}

export class TerminalConnection {
  private readonly options: TerminalOptions
  private readonly callbacks: TerminalCallbacks
  private readonly clientId: string
  private channel: TerminalChannel
  private socket: WebSocket | null = null
  private sessionId: string | null = null
  private attempts = 0
  private closedByUser = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sendQueue: Promise<void> = Promise.resolve()

  constructor(options: TerminalOptions, callbacks: TerminalCallbacks) {
    this.options = options
    this.callbacks = callbacks
    this.clientId = terminalClientId()
    this.channel = new TerminalChannel()
  }

  async connect(): Promise<void> {
    this.closedByUser = false
    this.callbacks.onStatus(this.attempts > 0 ? 'reconnecting' : 'connecting')
    let url: string
    try {
      url = await this.mintTicket()
    } catch (cause) {
      this.scheduleReconnect(cause instanceof Error ? cause.message : 'ticket failed')
      return
    }

    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.channel = new TerminalChannel()

    socket.onopen = () => {
      this.attempts = 0
      const open = {
        type: this.sessionId ? 'term_attach' : 'term_open',
        sessionId: this.sessionId ?? undefined,
        cols: this.options.cols,
        rows: this.options.rows,
        cwd: this.options.cwd,
        shell: this.options.shell,
        clientId: this.clientId,
        clientPub: toBase64(this.channel.publicKey),
        clientSalt: toBase64(this.channel.sendSalt),
      }
      socket.send(JSON.stringify(open))
    }
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') void this.onControl(event.data)
      else void this.onBinary(event.data as ArrayBuffer)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.closedByUser) return
      if (event.code === 4012) {
        this.callbacks.onStatus('closed', 'This terminal was opened somewhere else.')
        return
      }
      if (event.code === 4004) {
        this.callbacks.onStatus('offline', 'The laptop is not connected.')
      }
      this.scheduleReconnect(event.reason || `socket closed (${event.code})`)
    }
    socket.onerror = () => {
      // onclose fires next and handles the retry.
    }
  }

  /** Encrypt and send raw keystrokes. */
  send(data: string): void {
    if (!this.sessionId || !this.channel.ready) return
    const sessionId = this.sessionId
    // Seals are async; the queue keeps the nonce counter and the wire in order.
    this.sendQueue = this.sendQueue.then(async () => {
      const sealed = await this.channel.sealText(data)
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(packTerminal(sessionId, this.clientId, sealed))
      }
    })
  }

  resize(cols: number, rows: number): void {
    this.options.cols = cols
    this.options.rows = rows
    if (this.sessionId && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'term_resize', sessionId: this.sessionId, cols, rows }))
    }
  }

  /** Leave the session running on the laptop and drop the socket. */
  detach(): void {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.sessionId && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'term_detach', sessionId: this.sessionId }))
    }
    this.socket?.close(1000, 'detach')
    this.socket = null
  }

  /** Kill the shell on the laptop, then drop the socket. */
  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.sessionId && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'term_close', sessionId: this.sessionId }))
    }
    this.socket?.close(1000, 'close')
    this.socket = null
    this.sessionId = null
  }

  // -- internals -------------------------------------------------------------

  private async mintTicket(): Promise<string> {
    const response = await fetch(`/api/devices/${encodeURIComponent(this.options.deviceId)}/terminal-ticket`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.phoneSecret}`,
      },
      body: JSON.stringify({ clientId: this.clientId }),
      cache: 'no-store',
    })
    const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string }
    if (!response.ok || !data.url) {
      throw new Error(data.error || `ticket request failed (${response.status})`)
    }
    return data.url
  }

  private async onControl(raw: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(frame.type ?? '')

    if (type === 'term_key') {
      await this.channel.finish(
        this.options.deviceId,
        this.clientId,
        String(frame.devicePub ?? ''),
        String(frame.deviceSalt ?? ''),
      )
      return
    }
    if (type === 'term_ready') {
      this.sessionId = String(frame.sessionId ?? '')
      this.callbacks.onStatus('ready')
      this.callbacks.onReady?.({
        sessionId: this.sessionId,
        shell: String(frame.shell ?? ''),
        cwd: String(frame.cwd ?? ''),
        cols: Number(frame.cols) || this.options.cols,
        rows: Number(frame.rows) || this.options.rows,
      })
      return
    }
    if (type === 'term_eof') {
      const exitCode = frame.exitCode == null ? null : Number(frame.exitCode)
      this.sessionId = null
      this.closedByUser = true
      this.callbacks.onStatus('closed', exitCode == null ? 'Shell exited.' : `Shell exited (${exitCode}).`)
      this.callbacks.onExit?.(exitCode)
      return
    }
    if (type === 'term_error') {
      this.callbacks.onStatus('offline', String(frame.message ?? 'terminal error'))
      return
    }
    if (type === 'status' && frame.online === false) {
      this.callbacks.onStatus('offline', 'The laptop is not connected.')
      return
    }
    if (type === 'bye') {
      this.callbacks.onStatus('offline', 'The laptop disconnected.')
    }
  }

  private async onBinary(data: ArrayBuffer): Promise<void> {
    const frame = unpackTerminal(data)
    if (!frame || frame.clientId !== this.clientId) return
    try {
      const plaintext = await this.channel.open(frame.sealed)
      this.callbacks.onOutput(plaintext)
    } catch (cause) {
      if (cause instanceof ChannelError) {
        // A gap means missed frames (e.g. relay restart); force a clean re-attach.
        this.socket?.close(1000, 'channel desync')
      }
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.closedByUser) return
    this.attempts += 1
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempts - 1, 4))
    this.callbacks.onStatus('reconnecting', reason)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => void this.connect(), delay)
  }
}
