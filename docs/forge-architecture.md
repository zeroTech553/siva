# Forge architecture

What exists today, in one file. Read this before changing anything; update it
when you do.

**One sentence:** a browser drives the coding CLIs on a laptop you own, through a
relay the laptop dials out to, without opening a port.

---

## The four boundaries

```
  your phone / any browser                                     the laptop you own
┌─────────────────────────────┐                        ┌──────────────────────────────┐
│ Next.js app (Vercel)        │                        │ forge-bridge.py              │
│                             │   HTTPS + WSS          │   outbound WSS, nothing      │
│  /            static CDN    │◀──────────────────────▶│   listening                  │
│  /console     static CDN    │        relay           │        │                      │
│  /api/pair*   functions     │                        │        │ HTTP + X-Auth-Token   │
│  /d/[deviceId] proxy        │                        │        ▼  (injected)         │
│                             │                        │ agentremoted (vendored)      │
│ lib/shared/cli-flags.ts     │                        │   127.0.0.1:8473             │
│   builds the command the    │                        │        │                      │
│   visitor reads ────────────┼── argv parity ─────────┼────────▶ claude / codex /     │
└─────────────────────────────┘                        │          cursor / opencode /  │
                                                       │          copilot / antigravity│
┌─────────────────────────────┐                        └──────────────────────────────┘
│ relay (Worker / Node)       │
│   pairing rooms, device     │   Optional, accounts only:
│   rooms, terminal tickets   │   Supabase  ← machines table (RLS per user)
└─────────────────────────────┘
```

**Why the laptop dials out.** The bridge opens the WebSocket and keeps it open.
No inbound port, no port forwarding, no public IP, no VPN — it works behind any
NAT, which is the whole product.

**Why the relay is dumb.** Terminal bytes are encrypted in the browser and
decrypted on the laptop (X25519 + AES-256-GCM, `bridge/forge_crypto.py`). The
relay routes ciphertext and cannot read a keystroke. It is therefore safe to run
one shared relay for everyone, which is what makes the free tier possible.

---

## Boundary 1 — browser → app

| Path | Kind | Cost rule |
| --- | --- | --- |
| `/`, `/console` | `○ Static` | served by the CDN; never reads cookies, headers or searchParams |
| `/api/pair`, `/api/pair/claim` | function | mints and claims a single-use code |
| `/api/devices/[id]` | function | presence, terminal tickets, revoke |
| `/d/[deviceId]/[...path]` | function | the only route that waits on a laptop (`maxDuration 300`) |
| `/api/install/*`, `/api/bridge/*`, `/api/forge/*` | function | what the installer downloads |
| `/api/machines*` | function | Supabase-backed; the only cookie consumer (`proxy.ts`) |

The browser polls through one loop: `lib/client/polite-polling.ts`. A hidden tab
issues **zero** requests, an idle tab backs off, a refocus ticks immediately, and
rounds never overlap. Schedules are pure maths in `lib/shared/poll-schedule.ts`,
unit-tested against a requests-per-minute budget. There is no `setInterval` in
any component — that is a rule, not a preference.

## Boundary 2 — app → relay

`lib/server/relay.ts` is the only place that talks to the relay. It adds
`x-forge-proxy-secret` (so only this deployment can mint pairing codes), blocks
cross-origin writes (`requireSameOrigin`), and strips every request header except
an allowlist. `lib/server/env.ts` is the only place that reads `process.env`.

## Boundary 3 — relay → bridge → daemon

`relay/PROTOCOL.md` is the frame reference; the Durable Object and the Node relay
implement the same frames (and `tests/relay-room.test.mjs` holds them to it).

Pairing is one-time: the phone mints a code, the installer claims it, and the
code is dead (`409` on reuse — asserted in the e2e test). After that the bridge
holds a device token and the browser holds a phone secret. The daemon token never
leaves the laptop: the bridge reads `~/.agentremoted/token` and injects it as
`X-Auth-Token`, so no browser ever needs it (asserted in the e2e test).

## Boundary 4 — daemon → CLI

This is the boundary that was quietly broken, so it is the one with a test.

The browser shows a command built by `lib/shared/cli-flags.ts`. The laptop runs a
command built by:

| CLI | Who builds it |
| --- | --- |
| claude | `vendor/…/providers/claude.py::prepare` |
| codex | `vendor/…/providers/codex.py::prepare`, then `bridge/overlay/codex_mode.py` rewrites the sandbox |
| cursor, antigravity, opencode, copilot | `bridge/overlay/cli_launch.py::build_headless_cmd` |

`tests/cli-parity.test.mjs` runs **both** builders over the same matrix — real
Python in a subprocess, real fixtures — and compares argv. If the UI and the
machine ever disagree, it fails. `tests/e2e-prompt.test.mjs` goes further: it
spawns the actual Next.js app, relay, bridge and daemon, sends a prompt, and
asserts the prompt reached a real process byte-identical, as the last argument.

---

## The invariants

Each one has a test that fails if you break it. Add to this list rather than
adding a comment somewhere.

| Invariant | Enforced by |
| --- | --- |
| The command the visitor reads is the command the laptop runs | `tests/cli-parity.test.mjs` |
| A prompt survives the whole pipe byte-identical, last in argv | `tests/e2e-prompt.test.mjs` |
| A read-only pass (deep research, plan mode) never carries a full-access flag | `tests/cli-flags.test.mjs`, `tests/cli-parity.test.mjs` |
| The laptop's permission choice reaches every CLI, including codex | `tests/cli-parity.test.mjs` |
| The model the visitor picked reaches the CLI | `tests/cli-parity.test.mjs`, `tests/e2e-prompt.test.mjs` |
| A pairing code is single-use; a stolen device id is not enough | `tests/e2e-terminal.test.mjs`, `tests/e2e-prompt.test.mjs` |
| The daemon token never reaches the browser | `tests/e2e-prompt.test.mjs` |
| Terminal bytes are encrypted end to end | `tests/e2e-terminal.test.mjs`, `bridge/tests/test_crypto*.py` |
| A file path cannot escape the laptop's root | `bridge/tests/test_files.py` |
| A hidden tab costs zero requests | `tests/poll-schedule.test.mjs` |
| Window z-order, minimise, cascade, tile, Alt+Tab | `tests/window-manager.test.mjs` |
| The relay's two implementations route identically | `tests/relay-room.test.mjs` |

## Running it

```
cp .env.example .env.local     # then: pnpm doctor
pnpm relay:dev                 # terminal 1 — relay on :8787
pnpm dev                       # terminal 2 — app on :3000
pnpm test                      # unit + e2e (spawns itself: app, relay, bridge, daemon)
pnpm doctor                    # is this deployment actually wired up?
```

`pnpm doctor` is the plug-and-play check: toolchain, every env var and what breaks
without it, relay reachability (it mints a real pairing code), Supabase plus
whether the migration was applied, and the laptop-side modules.
