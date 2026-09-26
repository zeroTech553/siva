# Repository layout

Where things live and why. If you are adding a feature, this tells you which folder it belongs in.

```
siva/
├── app/                    Next.js App Router — routes only. Thin: parse input, call lib/, return.
│   ├── layout.tsx          self-hosted fonts (assets/fonts), metadata, security-relevant <html>
│   ├── globals.css         stylesheet *manifest* — only @imports ../styles/*.css, in cascade order
│   ├── page.tsx            the landing page (hero machine, CLI selector, terminal, pair, prompt)
│   ├── console/page.tsx    the full Zero OS desktop, once a laptop is paired with this browser
│   ├── api/                server-only endpoints (proxy to the relay, installers, overlay files)
│   │   ├── pair/           mint + claim pairing codes            (maxDuration 60)
│   │   ├── devices/[id]/   device status, revoke; terminal-ticket/ mints single-use WS tickets
│   │   ├── install/[variant]/  sh | py | cmd installers (public URLs are rewrites, see next.config.mjs)
│   │   ├── bridge/[name]/  serves bridge/*.py modules to the installer   (deliberately no-store)
│   │   ├── machines/       the signed-in user's machines (Supabase; 503 in device-only mode)
│   │   ├── forge/[name]/   serves bridge/overlay/*.py (daemon provider overlays)
│   │   └── agy/manifest/   Antigravity CLI binary manifest + fallback (CDN-cached)
│   └── d/[deviceId]/[...path]/  generic RPC proxy: browser → relay → laptop daemon (maxDuration 300)
│
├── components/             React, grouped by *feature*, not by file type
│   ├── computer/           THE MACHINE — see components/computer/README.md for the map
│   │   ├── zero-computer.tsx   chassis + CRT + peripherals + boot, one component to drop anywhere
│   │   ├── zero-logo.tsx       the Zero OS mark (inline SVG, any scale)
│   │   ├── boot/               boot-stages.ts (pure data) + boot-screen.tsx (POST → loader → splash)
│   │   ├── hardware/           machine-shell, crt-screen, keyboard, mouse, use-machine (power/OSD/LEDs)
│   │   └── os/                 window-manager.ts (pure reducer), use-window-manager.ts, zero-os.tsx,
│   │                           os-window, os-taskbar, os-menu, os-shutdown, os-ui (buttons/pills/fields)
│   ├── landing/            the marketing page: landing-page (state owner) + one file per section
│   ├── cli/                cli-picker, model-picker, flag-panel, command-preview, prompt-composer
│   ├── pairing/            use-pairing.ts (the flow) + pair-panel.tsx (the UI) — no page of its own
│   ├── console/            console-frame (session+state) → console-os (the desktop's app list),
│   │                       control-panel, cd-player
│   ├── terminal/           machine-terminal.tsx (real PTY over the encrypted pipe),
│   │                       demo-terminal.tsx (a working shell that runs in the browser)
│   ├── agent/              use-agent-console.ts (state) + agent-window.tsx (UI) + console-transcript
│   └── files/              file-browser.tsx — the laptop's disk over /api/fs/*
│
├── lib/
│   ├── shared/             imports fine on server *and* client; no React, no DOM, no env reads
│   │   ├── cli-flags.ts        per-CLI models/flags → exact argv, shell + PowerShell quoting,
│   │   │                       deep-research wrapping, and the mapping onto the daemon's
│   │   │                       permission_mode (mirrors bridge/overlay/cli_launch.py).
│   │   │                       THE single CLI catalog: ids, aliases, models, flags, and the
│   │   │                       argv the daemon adds by itself.
│   │   ├── daemon.ts           daemon/relay payload types + provider helpers
│   │   ├── poll-schedule.ts    the pure maths of polite polling (three schedules, unit-tested)
│   │   └── app-origin.ts       which origin installers and pairing codes advertise
│   ├── client/             browser-only
│   │   ├── polite-polling.ts   the ONE polling loop: hidden tab = zero requests, adaptive backoff,
│   │   │                       instant tick on refocus, no overlapping rounds, offline-aware
│   │   ├── use-paired-machine.ts  restore + presence for "is my laptop connected?"
│   │   ├── use-cli-selection.ts   the visitor's CLI/model/flags, persisted per CLI (forge.cli.v1)
│   │   ├── terminal-{crypto,frames,connection}.ts  X25519 + AES-256-GCM pipe to the laptop
│   │   ├── device-rpc.ts       one call: browser → /d/[id]/… → relay → daemon
│   │   ├── forge-session.ts    localStorage session + console prefs
│   │   ├── account.ts          the signed-in user's machines (Supabase)
│   │   └── zero-sound.ts       WebAudio blips: keys, window open, ding, error, chiptunes
│   ├── server/             node-only: relay proxy, installer script, origin checks, http helpers
│   │   ├── env.ts             EVERY env var, with what breaks without it. Nothing else
│   │   │                      reads process.env for configuration.
│   │   └── a file in here must never be imported from a 'use client' component
│   └── supabase/           the only files that read Supabase env vars: config, client, server
│
├── styles/                 one CSS file per concern; import order in app/globals.css IS the cascade
│   ├── tokens.css          colours, radii, fonts, base layer, keyframes (retheme here)
│   ├── computer.css        .zc-* (chassis, CRT, bays, knobs) .mk-* (keyboard) .mm-* (mouse)
│   ├── os.css              .zos-* .os-* (desktop, windows, taskbar, start menu, shutdown, widgets)
│   ├── apps.css            apps inside a window: .pair-* .cli-* .prompt-* .demo-term-* .machine-term-*
│   │                       .forge-* .cd-* .file-browser-* .os-pane
│   └── landing.css         .land-* — the page around the machine (pegboard hero, sections, footer)
│       Namespaces are disjoint on purpose — that is what makes the split safe.
│
├── pixel/                  hand-authored pixel art
│   ├── sprites.mjs         each icon as an editable 16×16 character grid + the Zero OS palette
│   └── build.mjs           grid → PNG in public/sprites/ + app/icon.png favicon (run `pnpm sprites`; output is committed)
│
├── assets/fonts/           self-hosted woff2 + their OFL license texts (no build-time Google fetch)
├── public/                 static web assets only: sprites, CLI logos, upstream share client
│
├── bridge/                 what runs on the user's laptop
│   ├── forge_bridge.py     outbound WSS to the relay, RPC proxy to the local daemon, heartbeats
│   ├── forge_pty.py        real PTY sessions: POSIX pty(4) and Windows ConPTY behind one interface
│   ├── forge_files.py      file API rooted at home: list/read/write/edit/glob/grep/stat/up/download
│   ├── forge_crypto.py     X25519 + AES-256-GCM so the relay only ever sees ciphertext
│   ├── forge_frames.py     the 45-byte binary frame layout shared with the relay and browser
│   ├── forge_audit.py      append-only JSON-lines audit log of every remote action
│   └── overlay/*.py        dropped into the vendored daemon to add cursor/antigravity/opencode/copilot
│                           (cli_launch.py builds the headless argv that lib/shared/cli-flags.ts previews;
│                           codex_mode.py wraps the upstream codex provider so the phone's
│                           permission choice reaches `codex exec`)
│
├── relay/                  the pipe. Same protocol, two deployments.
│   ├── PROTOCOL.md         frame reference — read this before touching either relay
│   ├── worker/             Cloudflare Worker + Durable Objects (production, zero idle cost)
│   └── node/               Node relay for local dev and self-hosting (same frames, in-memory store)
│
├── scripts/doctor.mjs      `pnpm doctor` — is this deployment wired up? toolchain, env,
│                           relay (mints a real pairing code), Supabase + migration, bridge modules
├── supabase/migrations/    machines table + RLS (apply with supabase db push)
├── tests/                  node --test suites (`pnpm test`)
│   ├── window-manager.test.mjs  the OS window manager's pure reducer: focus, z, min/max, cascade, tile
│   ├── cli-flags.test.mjs       exact argv, shell/PowerShell quoting, deep research, permission mapping
│   ├── cli-parity.test.mjs      CROSS-LANGUAGE: runs the real Python builders and compares
│   │                            their argv with what the browser previews
│   ├── poll-schedule.test.mjs   the polling maths and its free-tier budget
│   ├── relay-room.test.mjs      relay routing rules
│   ├── e2e-terminal.test.mjs    the full pipe: relay → real Python bridge → real /bin/sh, encrypted
│   ├── e2e-prompt.test.mjs      "send a prompt": REAL Next.js → relay → bridge → daemon → real CLI
│   └── fixtures/                fake-cli (a stand-in coding agent) + stub_daemon.py (the
│                                daemon's API contract) — everything else in those two tests is real
├── docs/                   architecture, current state, this file (history/ = superseded plans)
└── vendor/agent-remote/    upstream daemon at a pinned commit — do not edit; overlay it from bridge/overlay
```

## Conventions

- **Routes are thin.** No business logic in `app/**/route.ts`; it lives in `lib/server/`.
- **One home for configuration.** `lib/server/env.ts` reads `process.env`; nothing else does.
  Adding a variable means adding it there, with what breaks without it — `pnpm doctor` then
  checks it for free.
- **One home for the CLI catalog.** `lib/shared/cli-flags.ts`. A second list of the same six
  CLIs existed once and was deleted: the UI read one and the command builder used the other.
- **One concern per file.** If a file needs a comment explaining two unrelated jobs, split it.
- **Feature folders, not type folders.** `components/terminal/` holds the terminal's components;
  there is no `components/atoms|organisms`. Everything about the machine lives in `components/computer/`.
- **State first, pixels second.** Anything with rules of its own is a pure module next to the component
  that draws it (`window-manager.ts`, `boot-stages.ts`, `cli-flags.ts`, `poll-schedule.ts`) and gets a
  unit test. If you cannot test it without a DOM, it is doing too much.
- **Class namespace = CSS file.** New component → pick a namespace → its CSS goes in that file only.
- **Never put a secret in a URL.** Tickets are short-lived and single-use; see `relay/PROTOCOL.md`.
- **The laptop side is Python stdlib + two deps** (`websocket-client`, `cryptography`, plus
  `pywinpty` on Windows). Keep it that way: the installer runs on machines we do not control.
- **`vendor/` is read-only.** Upstream changes come in by bumping the pinned commit and adding an
  overlay file, never by editing vendored code.

## Cost rules (Vercel free tier)

Every serverless invocation is metered, so these are load-bearing, not stylistic:

1. **Pages are static.** `/` and `/console` build to `○ (Static)` and are served by the CDN. Do not
   read cookies, headers or searchParams in them — that makes a page dynamic and bills every view.
2. **`proxy.ts` matches only `/api/machines*`.** It is the sole cookie consumer. Adding a path to its
   matcher puts that path behind a function; add one only if a server component really needs the
   session (and say so in the comment at the top of `proxy.ts`).
3. **The browser polls through `startPolitePolling` only.** No `setInterval` in a component, ever:
   a hidden tab must cost zero, an idle tab must back off, a refocus must tick immediately, and
   rounds must never overlap. Schedules live in `lib/shared/poll-schedule.ts` and are unit-tested
   against a requests-per-minute budget.
4. **Every API route declares `maxDuration`.** 60 for the short relay/database hops; 300 only for
   `/d/[deviceId]/[...path]`, which waits on a laptop.
5. **Cache what cannot change mid-request.** Static assets, the installer and the Antigravity
   manifest carry `s-maxage` + `stale-while-revalidate` (see `next.config.mjs` and the routes).
   `bridge/*.py` and `bridge/overlay/*.py` stay `no-store` on purpose: a stale protocol module is
   worth more than the invocations it would save.
