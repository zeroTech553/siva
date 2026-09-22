# Forge: what it is today, what it can do, and the gap to "real terminal + accounts"

Written 2026-09-22 from a full read of this repo (`app/`, `components/`, `lib/`, `worker/`,
`bridge/`, `vendor/agent-remote/`) plus research into the open-source projects that already
ship real browser terminals, remote CLI agents, and remote file access.

This document is the honest baseline. `docs/forge-architecture.md` is the *intended* design;
this file is what the code *actually does* — and where the two disagree.

---

## 1. One-paragraph summary

Forge is a "your laptop's coding agents, in your pocket" product. A visitor opens the website,
picks a CLI (Claude Code / Codex / Cursor / Antigravity / OpenCode / Copilot), gets a pairing
code, runs one install command on their laptop, and the site then drives that laptop's agent
sessions. The laptop **dials out** — there is no inbound port, no tunnel, no Cloudflare account
for the user. Three deployed pieces make it work: a Next.js app on Vercel (UI + proxy), a
Cloudflare Worker relay with D1 + one Durable Object per laptop (the pipe), and two processes
on the laptop (the vendored `agentremoted` daemon + a small Python `forge-bridge` sidecar).

```
Phone/laptop browser                You operate (Cloudflare)              User's machine
┌────────────────────────┐        ┌──────────────────────────┐        ┌──────────────────────────────┐
│ Next.js on Vercel      │        │ Worker `forge-relay`     │        │ forge_bridge.py              │
│  /            pairing  │ HTTPS  │  D1: pairing_codes,      │  WSS   │  • outbound socket + backoff │
│  /console     desk UI  │───────▶│      devices, rate_limits│◀───────│  • heartbeat 15s (daemonOnline)│
│  /api/*       proxy    │  JSON  │  DO `DeviceRelay`        │  out   │  • RPC proxy → localhost     │
│  /d/[device]/[...path] │        │  (one per laptop)        │  only  │  • injects X-Auth-Token      │
│  /install*  installers │        │                          │        │        ▼                     │
│  localStorage forge.v1 │        │                          │        │ agentremoted 127.0.0.1:8473  │
└────────────────────────┘        └──────────────────────────┘        │  tmux + claude/codex/…       │
                                                                      └──────────────────────────────┘
```

---

## 2. What it can do today (verified against the code)

### 2.1 Pairing — the only "signup"

| Step | Code | Detail |
|---|---|---|
| Mint code | `POST /api/pair` → `worker: createPair` | 9-char code `ABC-DEF-GHJ` from a 32-char Crockford-ish alphabet (~3.5e13), 10-min TTL, single-use, 12/min/IP rate limit |
| Phone secret | same call | 32-byte random `phoneSecret`; only `sha256` of it is stored (`pairing_codes.phone_secret_hash`) |
| Install command | `pairing-screen.tsx` | Unix: `curl -fsSL <origin>/install \| bash -s -- CODE cli`. Windows: `curl.exe … /install.cmd … CODE cli` |
| Installer | `/install` (bash stub) → `/install.py` (826-line Python installer in `lib/install-script.ts`) | Requires `python3`; creates `~/.forge`, a venv, `pip install websocket-client==1.8.0`; kills previous Forge processes; detects/installs CLIs (incl. downloading Antigravity `agy` from Google storage with sha512 check, `npm i -g @anthropic-ai/claude-code`, `winget` fallback) |
| Claim | `POST /api/pair/claim` → `worker: claimPair` | Creates the `devices` row, mints `deviceToken` (hashed at rest), returns `deviceId` + `workerWebSocketUrl` (`wss://…/v1/devices/{id}/connect?token=…`) |
| Persist | installer | Writes `~/.forge/config.json`; installs `agentremoted` from a **pinned upstream commit** (`DAEMON_COMMIT = fb8ec4e…`, `overlay_daemon()`); writes `~/.agentremoted/config.json` bound to `127.0.0.1:8473` |
| Autostart | installer | macOS launchd, Linux `systemd --user`, Windows Startup-folder VBScript |
| Browser side | `pairing-screen.tsx` | Stores `{code, phoneSecret, expiresAt, deviceId, hostname}` in `localStorage['forge.v1']`; polls `/api/pair?code=…` then `/api/devices/{id}` every 1.5 s until `online`, then `router.push('/console')` |

### 2.2 The pipe (relay + RPC)

- `bridge/forge_bridge.py` (244 lines): one outbound WebSocket, exponential backoff 1→30 s,
  `ping_interval=25`, heartbeat every 15 s that probes the local daemon's `/api/ping` and reports
  `daemonOnline`. Single-instance guard by binding `127.0.0.1:18473`.
- Every browser call goes `/d/{deviceId}/{path}` (Vercel, `maxDuration = 300`) → `POST
  /v1/devices/{id}/rpc` on the Worker (gated by a shared `WORKER_PROXY_SECRET`) → the Durable
  Object → `rpc_request` frame to the laptop → the bridge re-issues it as plain HTTP to
  `127.0.0.1:8473`, **adding the daemon token from `~/.agentremoted/token`** so the browser never
  learns it.
- Responses stream back as base64 chunks (`rpc_accepted` → `rpc_start` → `rpc_chunk`* → `rpc_end`).
  Limits: 45 s to accept, 120 s for the daemon, 5 min lifetime, 25 MB response, 1 MB request,
  16 concurrent RPCs per device, 240 RPC/min.
- Status: `online` = laptop socket open; `daemonOnline` = local daemon answered.

### 2.3 The agent console (`components/console-frame.tsx`, 676 lines)

- `GET /api/ping` → provider list + per-provider auth health (`cli_on_path`, `status`, `detail`);
  `readyProviders()` / `pickReadyProvider()` order and pick a CLI; `cliSetupMessage()` tells the
  user the exact login command (`claude login`, `codex login`, `agent login`, `opencode auth login`,
  `copilot login`, `agy`, `grok auth login`).
- `GET /api/projects` → project list; the laptop's home dir is discovered by **running four probe
  commands** through `/api/shell` (`resolveLaptopHome()`).
- Prompt send: `POST /api/sessions/new` or `POST /api/sessions/{id}/continue` with
  `{prompt, permission_mode}`; falls back across the provider queue if one fails.
- Live job stream: polls `GET /api/jobs/{id}?since={seq}` **every 250 ms**, merges events, tracks
  `next_seq`, and surfaces `pending_permission` (Allow/Deny) and `pending_question`
  (options / Skip) inline.
- Permission modes exposed: `bypassPermissions` ("Full access", **the default**), `acceptEdits`,
  `plan`, `''` ("Ask each time").
- Extras: stop job, new chat, reset pairing, CD player (WebAudio chiptunes in `lib/desk-sound.ts`),
  BIOS boot screen, CRT power/brightness knobs, draggable on-screen mouse that click-throughs to
  real DOM elements, on-screen keyboard that types into focused inputs.

### 2.4 The "terminal" — **not a real terminal**

`components/laptop-terminal.tsx` is a line-based command runner:

- You type a line → it is wrapped (`cmd & echo __FORGE_CWD__ & cd` on Windows, or
  `cmd\nprintf '__FORGE_CWD__:%s' "$(pwd)"` on Unix) → `POST /api/shell` → the whole output is
  appended as static text. The `__FORGE_CWD__` marker is scraped out to track `cd`.
- Consequences: **no PTY**. No `vim`/`top`/`htop`, no tab-completion, no colours, no cursor
  control, no `Ctrl-C`, no streaming (one blocking request per command), no resize, no scrollback
  from the machine, no persistent shell (each command is a fresh subprocess — `cd` only "works"
  because of the marker hack).
- The daemon *does* have a tmux-based Live TUI (`GET /api/sessions/{id}/tui` capture +
  `POST …/tui/keys`), but Forge's UI never calls it. That is polled screen-scraping of an agent
  pane, not a general shell.

### 2.5 Files — almost none

Only what upstream `agentremoted` exposes: `GET /api/drop` (host→phone drop listing),
`GET /api/drop/{name}`, `POST /api/drop/{name}/delete`, `POST /api/attachments` (phone→host
upload, chunked). There is **no file tree, no file reader, no editor, no grep/glob, no git diff
view** in Forge's UI.

### 2.6 Accounts — none

There is no user table anywhere (`worker/schema.sql` has exactly `pairing_codes`, `devices`,
`rate_limits`). Identity = a `phoneSecret` in `localStorage` of one browser. Lose the browser or
clear site data → the laptop is unreachable until you re-pair. No multi-machine list, no
cross-device sync, no "log out that laptop" UI beyond `DELETE /api/devices/{id}`, no email,
no sessions history across devices.

---

## 3. Where the code contradicts its own docs

| Doc claim (`docs/forge-architecture.md` §D, §7) | Reality |
|---|---|
| E2E encryption: X25519 ECDH handshake, AES-256-GCM traffic, key rotation, relay is zero-knowledge | **Not implemented.** `lib/crypto.ts` only does sha256/random/bearer-parsing. The Worker, the DO, and Vercel all see plaintext prompts, transcripts, and shell output |
| Ed25519 device identity with challenge-response on reconnect | Not implemented. A static `deviceToken` in a query string is the device credential |
| `POST /v1/abuse` to disable a device_id | Not implemented in `worker/src/index.ts` |
| Offline queue in DO SQLite (send from the subway, laptop picks it up on wake) | Not implemented. Offline = `503 LAPTOP_OFFLINE`, prompt is lost |
| Bridge auto-update via `GET /v1/version` | Not implemented. Users re-run the install command forever |
| Local audit log `~/.forge/audit.log` of every remote command | Not implemented |
| Pairing code `XXXX-XXXX`, 8 chars | Worker uses `XXX-XXX-XXX`, 9 chars. `lib/crypto.ts:randomCode()/normalizeCode()` still implement the 8-char version and are **dead code** (only `publicOrigin` from that file is used) |
| shadcn/ui component library | All 21 components in `components/ui/` are **imported by nothing**. The desk UI is hand-rolled CSS |
| Guest sandbox on by default (upstream seatbelt jail) | Installer does not enable it; default permission mode is `bypassPermissions` |

Other production gaps: `phoneSecret` is accepted from a `?token=` query param (`lib/relay.ts`,
`lib/crypto.ts`); `WORKER_PROXY_SECRET` is one shared static secret for all traffic;
`wrangler.toml` hardcodes an account id; `public/ar/app.js` (199 KB upstream web client) is served
at `/share` but is not wired to Forge auth; 250 ms job polling × every open console is the real
cost driver, not messages.

---

## 4. Research: how the projects that already do this, do it

### 4.1 Real terminal in a browser

The pattern is unanimous: **xterm.js in the browser + WebSocket + a PTY owner on the machine**.
GoTTY states it plainly — xterm.js renders, the server relays TTY output to clients and client
input to the TTY ([sorenisanerd/gotty](https://github.com/sorenisanerd/gotty)); WeTTY is the same
idea over SSH ([butlerx/wetty](https://github.com/butlerx/wetty)); the three-layer split
(xterm.js frontend / WebSocket / backend PTY management) is the canonical description
([x-cmd gotty](https://www.x-cmd.com/install/gotty/),
[web terminal comparison](https://sabujkundu.com/best-open-source-web-terminals-for-embedding-in-your-browser/)).
xterm.js is what VS Code's own terminal uses, so it is the safe frontend choice.

Two references matter most for us because they solve *our* exact problem (a PTY on a machine
behind NAT, streamed to a browser/phone):

- **VibeTunnel** — "turn any browser into your terminal & command your agents on the go".
  Node server + native PTY (node-pty) + xterm.js/ghostty-web client; `PtyManager` (session
  lifecycle), `SessionManager` (spawn + I/O), `TerminalManager` (buffer state),
  `BufferAggregator` (batches output), `WsV3Hub` (binary WebSocket protocol with magic bytes),
  a `vt` wrapper so any command you run becomes a shareable session, asciinema-format session
  recording, JWT auth, and multiple concurrent sessions
  ([deepwiki: vibetunnel](https://deepwiki.com/amantus-ai/vibetunnel),
  [README](https://github.com/amantus-ai/vibetunnel/blob/main/web/README.md),
  [fork README](https://github.com/Nano1337/vibeplatform)). The cross-platform fork documents the
  wire format we can copy almost verbatim: `ws.send({type:'input', sessionId, data})` and
  `{type:'output', …}`, plus `terminal.scrollback`, `allowFileUpload/Download`, `maxSessions`
  ([shaike1/vibessh](https://github.com/shaike1/vibessh)).
- **winterm-web** — "a real Windows terminal in your browser: ConPTY streamed over WebSocket,
  sessions survive restarts". Its split is the one to copy: a **session daemon that owns the PTY
  and stays alive** (tmux-server role) on `127.0.0.1:8771`, a **pure-relay web server holding
  zero session state** on `:8767`, and xterm.js in the browser — so closing the tab does not kill
  the session. Local IPC is NDJSON over TCP; security is `allowedHosts` / `allowedOrigins`
  allowlists ([somoo1995/winterm-web](https://github.com/somoo1995/winterm-web)).

Windows PTY specifics: Python's `pty`/`termios` **do not work on Windows**; ConPTY is required
([python issue 41663](https://bugs.python.org/issue41663)) and the standard way from Python is
`pywinpty` (ConPTY native, winpty fallback, prebuilt wheels) ([pywinpty on PyPI](https://pypi.org/project/pywinpty/)).
The clean engineering pattern is a **platform-branched drop-in**: `win_pty_bridge.py` exposing the
same `spawn/read/write/resize/close` surface as the POSIX `pty_bridge.py`, reading in an executor
so the loop never blocks, and **clamping cols/rows** to protect `setwinsize` from garbage values
coming out of xterm.js ([NousResearch/hermes-agent PR #42251](https://github.com/NousResearch/hermes-agent/pull/42251)).

### 4.2 Relaying that terminal through Cloudflare (our chosen pipe)

- Use the **Hibernation WebSocket API**: `ctx.acceptWebSocket(server, [tags])`,
  `serializeAttachment()` for per-connection state, and the DO accrues **no billable duration
  while hibernating** — clients stay connected, a message wakes it
  ([Cloudflare: Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
  [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).
- The failure mode to design around is **waking from hibernation with live sockets but empty
  memory**. TermOnMac (a production DO relay for exactly this use case) documents the fix: tag
  every socket with a UUID, persist `role:{tag}` / `user:{tag}` in DO storage, rebuild in the
  constructor inside `blockConcurrencyWhile`, **skip sockets whose `readyState !== OPEN`**, eagerly
  delete the replaced socket's storage keys (its `webSocketClose` may fire *after* hibernation),
  and reschedule a heartbeat alarm at the end of every `alarm()`
  ([TermOnMac blog](https://termonmac.com/blog/durable-objects-hibernation/)).
- Cloudflare now ships this exact feature in its Sandbox SDK: `sandbox.terminal(request)` proxies a
  WebSocket upgrade to the container's PTY endpoint **with output buffering for replay on
  reconnect**, plus an official xterm.js addon
  ([Cloudflare changelog 2026-02-09](https://developers.cloudflare.com/changelog/post/2026-02-09-pty-terminal-support/)).
  "Buffer output so a reconnecting client can replay" is the detail most home-grown terminals get
  wrong — we will keep a per-session ring buffer in the DO.
- For auth on the socket, prefer **short-lived signed capability URLs** over putting a long-lived
  secret in a query string: mint a role-bound, single-use ticket server-side, keep no channel state
  in the Worker ([the-greenman/browser-executor-relay](https://github.com/the-greenman/browser-executor-relay)).

### 4.3 Remote CLI agents (the "agent" half)

- **Happy** (`slopus/happy`, MIT, ~22k stars) is the closest product analog and the one our docs
  already cite: a pnpm monorepo of `happy-cli` (wrapper you run instead of `claude`), `happy-server`
  (encrypted sync + real-time routing), `happy-wire` (shared protocol types), `happy-app`
  (Expo iOS/Android/web) ([deepwiki](https://deepwiki.com/slopus/happy),
  [README](https://github.com/slopus/happy/blob/main/README.md)). Its server is deliberately
  **zero-knowledge**: "stores encrypted data but has no ability to decrypt it", **cryptographic
  auth — no passwords stored, only public-key signatures**, WebSocket sync across devices,
  encrypted push notifications, and a self-host path (Docker Compose: Postgres + Redis + server)
  ([happy-server README](https://github.com/slopus/happy/tree/main/packages/happy-server),
  [overview](https://cosyra.com/guides/cosyra-vs-happy-coder.html)). Crypto: X25519 keypairs,
  ECDH, AES-256-GCM, ephemeral session keys for forward secrecy
  ([dev.to write-up](https://dev.to/_53fb7c03dd741a6124e4e/happy-the-open-source-app-that-puts-claude-code-in-your-pocket-7i2)).
  Its constraint is architectural, and it is ours too: **it provides no compute**, so a sleeping
  laptop strands the phone.
- **Omnara** took the wrapper route: parse `~/.claude/projects` + terminal output, stream to the
  platform over SSE, respond from web/mobile; open-source backend of API server + Postgres +
  push/email/SMS notifications; `omnara serve` exposes a **remote-launch endpoint** so you can
  start agents from your phone ([HN Show](https://news.ycombinator.com/item?id=44878650),
  [YC launch](https://www.ycombinator.com/launches/OCT-omnara-the-first-command-center-for-ai-agents-terminal-web-and-mobile),
  [README](https://github.com/omnara-ai/omnara/blob/main/README.md)). They have since rebuilt on
  the Claude Agent SDK because wrapping a CLI is hard to maintain — a useful warning about how much
  upstream churn we absorb by vendoring `agentremoted`.
- **Omnigent** is the multi-agent version: a meta-harness over Claude Code/Codex/Cursor/OpenCode,
  requiring **tmux** for its native terminal wrappers, **bubblewrap (Linux) / seatbelt (macOS)**
  filesystem+network sandboxing plus an L7 egress proxy, a local web UI on `:6767`, and
  "messages, sub-agents, **terminals, and files** stay in sync" across terminal/browser/phone
  ([omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent)). That sentence is your product
  spec: terminal + agent + files, one session, any device.
- The vendored **agent-remote** daemon remains the strongest base for the agent half: it already
  attaches to sessions the user started in a normal terminal (the differentiator vs Happy, which
  forces `happy claude`), and it already has permission prompts, queue, stop, rewind, file drop,
  guest jail, launchd/systemd.

### 4.4 Remote file access (the "read files" half)

- **FarHand** has the best-designed remote file/tool surface to copy: `remote_bash`,
  `remote_read` (**line numbers + offset/limit paging**), `remote_write` (creates parents),
  `remote_edit` (replace an *exact unique* string, CRLF-aware), `remote_ls` / `remote_glob` /
  `remote_grep` (backed by `rg`), `upload` / `download` restricted to allowlisted folders,
  credential-shaped names refused, and **one JSON line per action in a local audit log**
  ([CogFlux/farhand](https://github.com/CogFlux/farhand)).
- **OpenHands SDK** shows the server-side shape: a built-in REST/WebSocket server, a `BaseWorkspace`
  interface with `file_download(path) -> bytes` / `execute_command(cmd)`, and a `LocalWorkspace`
  (in-process) vs `RemoteWorkspace` (delegates over HTTP) that are **interchangeable** — the same
  abstraction we need so the browser doesn't care whether the machine is local or remote; plus one
  container per agent for multi-tenant isolation
  ([arXiv 2511.03690](https://arxiv.org/html/2511.03690v1)).
- The cautionary tale: a project whose file browser used the **client-side File System Access API**
  was useless when the agent ran on a server — the browser could only see the *user's* files, not
  the machine's. The fix was to default to a **server-side `/api/files`** route
  ([hermes-workspace #294](https://github.com/outsourc-e/hermes-workspace/issues/294)). Our file
  browser must read the *laptop's* filesystem through the bridge, never the phone's.

### 4.5 Supabase auth (your chosen model)

- Use **`@supabase/ssr`** — `@supabase/auth-helpers-nextjs` is deprecated; the migration maps
  `createRouteHandlerClient` / `createClientComponentClient` / `createServerComponentClient` all to
  `createServerClient` with a `cookies` adapter
  ([Supabase migration guide](https://supabase.com/docs/guides/troubleshooting/how-to-migrate-from-supabase-auth-helpers-to-ssr-package-5NRunM)).
- App Router pattern: `lib/supabase/server.ts` + `lib/supabase/client.ts` + `middleware.ts` that
  refreshes the session on every request; pages/route handlers call `getClaims()` / `getUser()`
  server-side because client checks are bypassable
  ([Supabase vs Authgear for Next.js](https://www.authgear.com/post/supabase-vs-authgear-nextjs/)).
  `getClaims()` verifies against `/.well-known/jwks.json` and is cached — **prefer it over
  `getUser()`**, which hits the auth server every call
  ([JS API reference](https://supabase.com/docs/reference/javascript/auth-getclaims)).
- Verify the same JWT **in the Cloudflare Worker**: either `supabase.auth.getUser(jwt)` via
  supabase-js (works on Workers) or `@tsndr/cloudflare-worker-jwt`
  ([supabase discussion #20763](https://github.com/orgs/supabase/discussions/20763)); the newer
  `@supabase/server` package does JWT verification for edge functions for you
  ([Supabase blog](https://supabase.com/blog/introducing-supabase-server)).
- Multi-tenancy is **RLS**: `ENABLE ROW LEVEL SECURITY` + deny-by-default policies keyed on
  `auth.uid()` (note: `auth.uid()` is the *user*, not a tenant id — use `auth.jwt()->>'claim'` for
  org-style tenancy) ([Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
  [community discussion](https://github.com/orgs/community/discussions/149922)).
- Pentest lessons to respect: the service-role key **bypasses RLS**, so it must never reach the
  browser; "verify JWT" alone is not authorisation (an anon-key token from the same project passes
  it); don't rely on the legacy JWT secret as an access control
  ([Supabase security best practices](https://www.pentestly.io/blog/supabase-security-best-practices-2025-guide)).
- Note for expectations: Supabase Auth has **no passkeys/WebAuthn** as of March 2026
  ([comparison](https://www.authgear.com/post/supabase-vs-authgear-nextjs/)) — email magic link,
  OTP, TOTP MFA, and 20+ OAuth providers are available.

---

## 5. The gap, stated as work

Your four decisions: **Supabase accounts**, **direct WebSocket to the Cloudflare relay**,
**hand-authored pixel art**, **everything in one pass**. Mapped to concrete deliverables:

1. **Real terminal.** Bridge gains a cross-platform PTY owner (POSIX `pty.openpty` +
   `termios`; Windows `pywinpty`/ConPTY behind the same `spawn/read/write/resize/close` surface,
   clamped winsize). Sessions live in the bridge so they survive tab reloads (winterm-web's
   split). Relay gains a terminal channel on the DO: browser socket ↔ laptop socket, tagged +
   hibernation-safe, with a ring buffer for replay-on-reconnect, driven by 30–60 s single-use
   tickets minted through Vercel. UI gains xterm.js (+fit, +webgl optional) inside the CRT.
2. **Files.** Bridge-served FS API rooted at home with realpath containment:
   `fs/list`, `fs/read` (line numbers, offset/limit), `fs/write`, `fs/edit` (exact-unique replace),
   `fs/glob`, `fs/grep`, `fs/stat`, `fs/download`, `fs/upload`, plus a JSON-lines audit log. UI:
   "My Computer" becomes a real file tree + reader.
3. **Accounts.** Supabase auth (`@supabase/ssr`, middleware refresh, `getClaims()`), Postgres
   tables `profiles`, `machines`, `machine_members`?, `term_sessions`, `audit_events` behind RLS on
   `auth.uid()`; pairing code now binds a **machine to an account**, so any signed-in browser sees
   the same machine list, terminals, and agent sessions. Guest pairing can stay as a degraded path.
4. **Pixel-art monitor UI + clean files.** Hand-authored sprite pipeline (pixel maps in code →
   PNG/SVG, committed, editable) for monitor/tower/keyboard/mouse/icons/wallpaper; `globals.css`
   (1413 lines) split into `styles/` modules; `console-frame.tsx` (676 lines) split into
   `components/desk/*`, `components/os/*`, `components/terminal/*`, `components/agent/*`,
   `components/files/*` + `hooks/*`; delete the 21 unused shadcn components or start using them;
   delete dead `lib/crypto.ts` code and reconcile the pairing-code format.
5. **Production hardening.** E2E encryption (X25519 + AES-256-GCM) or an explicit, documented
   decision not to; device identity challenge-response; offline queue in DO SQLite; `/v1/version`
   auto-update; `/v1/abuse`; per-device secret rotation; drop `?token=` secrets from URLs;
   audit log; stop defaulting to `bypassPermissions`; replace 250 ms job polling with the daemon's
   `/ws/status` or SSE over the RPC stream.
