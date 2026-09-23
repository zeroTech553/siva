# Forge relay protocol — v2

One contract, two implementations (`relay/worker` for Cloudflare, `relay/node` for local dev and
self-hosting) and three clients (browser, laptop bridge, Vercel proxy). **Read this before changing
any of them.** Version negotiation is by capability, not by breaking the wire: a v1 laptop keeps
working, a v2 laptop advertises `caps` and the browser upgrades to it.

```
browser  ──WSS──▶  relay (one room per machine)  ◀──WSS──  bridge (laptop)
   │                     │                                    │
   │  ticketed socket    │  device-token socket               │  PTY, files, RPC → agentremoted
   └── E2E ciphertext ───┴────────────── E2E ciphertext ──────┘
              the relay routes frames it cannot read
```

## 1. Connections

| Who | URL | Credential | Lifetime |
|---|---|---|---|
| Laptop bridge | `wss://{relay}/v1/devices/{deviceId}/connect?token={deviceToken}` | long-lived device token, hashed at rest | hours–days; reconnect with 1→30 s backoff |
| Browser | `wss://{relay}/v1/devices/{deviceId}/term?ticket={ticket}` | **single-use 60 s ticket** minted by Vercel for a signed-in user | one tab; reconnect mints a new ticket |
| Vercel proxy | `POST /v1/...` with `x-forge-proxy-secret` | shared operator secret | per request |

Tickets exist so a long-lived secret never appears in a URL, a log, or a browser history entry.
The relay stores `{ticketHash → deviceId, userId, clientId, clientPub, expiresAt, used}` and burns
it on first use.

A browser socket is *tagged* in the room: the relay remembers `{socketId → clientId, sessionId}` so
it can route frames and survive Durable Object hibernation (see `relay/worker`).

## 2. Frame envelope

Two encodings on the same socket.

**Text frames** are JSON: `{ "v": 2, "type": "...", ... }`.

**Binary frames** carry terminal bytes, because base64 would add 33 % to every keystroke batch and
every screen update:

```
offset  len  field
0       1    kind       0x01 = terminal payload (the only kind today)
1       16   sessionId  UUIDv4, raw bytes — which shell this belongs to
17      16   clientId   UUIDv4, raw bytes — which browser it is for
33      12   nonce      4-byte direction salt ‖ 8-byte big-endian counter
45      N    ciphertext AES-256-GCM (16-byte tag included), max 64 KiB plaintext per frame
```

Header overhead is 45 bytes. The relay parses `kind`, `sessionId` and `clientId`
and never decrypts.

`clientId` is in the header because every browser has its **own** key with the
machine, so one shell with two viewers is two sealed copies of the same bytes,
each addressed to one viewer. It is also an authorisation check: the relay
verifies that the sending socket is tagged with the `clientId` it claims and
that it is attached to `sessionId`, so no browser can inject frames into someone
else's session.

## 3. Encryption

Per (client, machine) pair, established once and reused:

- Identity keys: X25519. The laptop keeps `device_priv` in `~/.forge/keys.json` (mode 0600);
  each browser keeps its own `client_priv` in IndexedDB, non-extractable where the platform allows.
- Handshake: browser sends `clientPub` in its ticket request; the laptop replies with `devicePub`
  and its direction salt in `term_key`. The relay sees both public keys and nothing else.
- Secret: `HKDF-SHA256(ikm = X25519(client_priv, device_pub), salt = sha256(deviceId), info =
  "forge-e2e-v2:" ‖ deviceId ‖ ":" ‖ clientId, len = 32)`.
- Traffic: AES-256-GCM, `nonce = salt ‖ counter`, counters start at 0 and increment per frame per
  direction. Rekey after 2²⁰ frames or 24 h by re-running the handshake with fresh salts.
- Replay/on-connect: the **laptop** keeps the scrollback ring buffer (256 KiB per session) and
  re-sends it to a newly attached browser. The relay buffers nothing, so a reconnect cannot leak
  ciphertext to a client that does not hold the key.

What the relay can see: deviceId, clientId, sessionId, frame sizes, timestamps. Never plaintext.

`caps` in `heartbeat` advertises what a bridge supports:

```json
{ "v": 2, "type": "heartbeat", "daemonOnline": true,
  "bridge": "4.0", "caps": { "e2e": true, "term": true, "files": true, "pty": "posix" } }
```

A browser that sees no `caps.term` falls back to the v1 one-shot shell runner and says so in the UI.

## 4. Terminal

Sessions live **on the laptop** and outlive the browser tab (the tmux/winterm-web model): closing
the tab does not kill your shell, and a second device can attach to the same session.

Browser → relay → laptop:

| Frame | Payload | Notes |
|---|---|---|
| `term_open` | `{sessionId?, cols, rows, cwd?, shell?, clientPub, clientId, salt}` | no `sessionId` = create one; the relay fills in `userId` from the verified ticket |
| `term_attach` | `{sessionId, clientPub, clientId, salt}` | join an existing session (second device, or reconnect) |
| `term_resize` | `{sessionId, cols, rows}` | cols/rows clamped to 2…500 by the bridge |
| `term_detach` | `{sessionId}` | tab closed; session keeps running |
| `term_close` | `{sessionId}` | kill the shell |
| `term_list` | `{}` | ask for the session list |
| *binary 0x01* | keystrokes / paste | encrypted |

Laptop → relay → browser(s):

| Frame | Payload | Notes |
|---|---|---|
| `term_key` | `{sessionId, devicePub, salt}` | handshake reply; sent once per client |
| `term_ready` | `{sessionId, shell, cwd, pid, cols, rows, replayBytes}` | session is live |
| `term_list_result` | `{sessions: [{sessionId, shell, cwd, pid, startedAt, attached, alive}]}` | |
| `term_eof` | `{sessionId, exitCode}` | shell exited |
| `term_error` | `{sessionId, message, code}` | e.g. `PTY_UNAVAILABLE`, `CWD_NOT_ALLOWED` |
| `term_closed` | `{sessionId}` | acknowledgement of `term_close` |
| *binary 0x01* | screen output, and the replay burst after `term_ready` | encrypted |

The relay fans `term_*` and binary frames out to **every browser attached to that sessionId**, never
to other sessions, and never to the laptop's own socket.

## 5. Files

Request/response over the RPC path (§6), served by the bridge itself (not the daemon) so the
surface is identical on macOS, Linux and Windows. Roots are the user's home directory plus any
`roots` in `~/.forge/config.json`; every path is `realpath`-resolved and must stay inside a root.

| Path | Method | Body → Result |
|---|---|---|
| `/api/fs/list` | POST | `{path, limit?}` → `{path, entries:[{name,type,size,mtime,mode}], truncated}` |
| `/api/fs/read` | POST | `{path, offset?, limit?, bytes?}` → `{path, lines, content, truncated, totalLines, encoding}` |
| `/api/fs/write` | POST | `{path, content, createParents?}` → `{path, bytes}` |
| `/api/fs/edit` | POST | `{path, oldText, newText, replaceAll?}` → `{path, replacements}` (exact-unique match, CRLF-aware) |
| `/api/fs/stat` | POST | `{path}` → `{path, type, size, mtime, mode, root}` |
| `/api/fs/glob` | POST | `{path, pattern, limit?}` → `{matches:[...]}` |
| `/api/fs/grep` | POST | `{path, pattern, limit?, ignoreCase?}` → `{matches:[{path,line,text}]}` (uses `rg` when present) |
| `/api/fs/download` | POST | `{path}` → streamed base64 chunks |
| `/api/fs/upload` | POST | `{path, contentBase64, append?}` → `{path, bytes}` |

Every mutating call writes one JSON line to `~/.forge/audit.log`.

## 6. RPC (agent console, v1 shape, optionally encrypted)

Unchanged framing so an old laptop keeps working:

```
relay → laptop   { type: "rpc_request", id, method, path, headers?, bodyBase64? }
laptop → relay   { type: "rpc_accepted", id }
                 { type: "rpc_start",  id, status, headers }
                 { type: "rpc_chunk",  id, bodyBase64 } …
                 { type: "rpc_end",    id }
                 { type: "rpc_error",  id, message }
```

With `caps.e2e`, `method/path/headers/bodyBase64` are replaced by a single `data` field holding
`base64(nonce ‖ ciphertext)` of that same object, and `rpc_start`/`rpc_chunk` payloads are encrypted
per chunk with the same counter scheme. The relay then cannot read or validate paths — validation
moves into the bridge, which already refuses `/internal/*` and `..`.

Limits: 1 MiB request, 25 MiB response, 45 s to accept, 120 s for the daemon, 5 min lifetime,
16 concurrent RPCs per machine, 240 RPC/min.

## 7. Errors and status

| Frame | Meaning |
|---|---|
| `{type:"status", online, daemonOnline, caps}` | sent to a browser on connect and on every change |
| `{type:"error", code, message}` | `TICKET_INVALID`, `TICKET_EXPIRED`, `DEVICE_OFFLINE`, `SESSION_NOT_FOUND`, `RATE_LIMITED`, `E2E_REQUIRED` |
| `{type:"bye", sessionId?, reason}` | laptop dropped; browser should reconnect and re-attach |

WebSocket close codes: `4001` ticket invalid/expired, `4003` not authorised, `4004` device offline,
`4009` rate limited, `4012` replaced by a newer connection.
