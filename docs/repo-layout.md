# Repository layout

Where things live and why. If you are adding a feature, this tells you which folder it belongs in.

```
siva/
├── app/                    Next.js App Router — routes only. Thin: parse input, call lib/, return.
│   ├── layout.tsx          self-hosted fonts (assets/fonts), metadata, security-relevant <html>
│   ├── globals.css         stylesheet *manifest* — only @imports ../styles/*.css, in cascade order
│   ├── page.tsx            landing → pairing
│   ├── console/page.tsx    the desk (terminal + agent + files) after a machine is connected
│   ├── api/                server-only endpoints (proxy to the relay, installers, overlay files)
│   │   ├── pair/           mint + claim pairing codes
│   │   ├── devices/[id]/   device status, revoke; terminal-ticket/ mints single-use WS tickets
│   │   ├── install/[variant]/  sh | py | cmd installers (public URLs are rewrites, see next.config.mjs)
│   │   ├── bridge/[name]/  serves bridge/*.py modules to the installer
│   │   ├── machines/       the signed-in user's machines (Supabase; 503 in device-only mode)
│   │   ├── forge/[name]/   serves bridge/overlay/*.py (daemon provider overlays)
│   │   └── agy/manifest/   Antigravity CLI binary manifest + fallback
│   └── d/[deviceId]/[...path]/  generic RPC proxy: browser → relay → laptop daemon
│
├── components/             React, grouped by *feature*, not by file type
│   ├── desk/               the physical 90s machine: CRT, tower, keyboard, mouse, CD player
│   ├── os/                 the retro OS chrome: desktop, window, taskbar, start menu, button
│   ├── pairing/            first-run pairing flow
│   ├── console/            the desk shell (console-frame) + control-panel
│   ├── terminal/           machine-terminal.tsx — xterm.js over the encrypted relay pipe
│   ├── agent/              use-agent-console.ts (state) + agent-window.tsx (UI) + transcript
│   └── files/              file-browser.tsx — the laptop's disk over /api/fs/*
│
├── lib/
│   ├── shared/             imports fine on server *and* client: CLI catalog, daemon types
│   ├── client/             browser-only: terminal-{crypto,frames,connection}, account, session storage, WebAudio
│   ├── server/             node-only: relay proxy, installer script, origin checks
│   │   └── a file in here must never be imported from a 'use client' component
│   └── supabase/           the only files that read Supabase env vars: config, client, server
│
├── styles/                 one CSS file per concern; import order in app/globals.css IS the cascade
│   ├── tokens.css          colours, radii, fonts, base layer, keyframes (retheme here)
│   ├── desk.css            .desk-* .crt-* .tower-*   (hardware)
│   ├── os.css              .win95-*                  (OS chrome)
│   └── apps.css            .pair-* .forge-* .machine-term-* .file-browser-* .cd-* .os-pane (apps)
│       Namespaces are disjoint on purpose — that is what makes the split safe.
│
├── pixel/                  hand-authored pixel art
│   ├── sprites.mjs         each icon as an editable character grid + palette
│   └── build.mjs           grid → PNG in public/sprites/ + app/icon.png favicon (run `pnpm sprites`; output is committed)
│
├── assets/fonts/           self-hosted woff2 + their OFL license texts (no build-time Google fetch)
├── public/                 static web assets only: sprites, logos, wallpaper, upstream share client
│
├── bridge/                 what runs on the user's laptop
│   ├── forge_bridge.py     outbound WSS to the relay, RPC proxy to the local daemon, heartbeats
│   ├── forge_pty.py        real PTY sessions: POSIX pty(4) and Windows ConPTY behind one interface
│   ├── forge_files.py      file API rooted at home: list/read/write/edit/glob/grep/stat/up/download
│   ├── forge_crypto.py     X25519 + AES-256-GCM so the relay only ever sees ciphertext
│   ├── forge_frames.py     the 45-byte binary frame layout shared with the relay and browser
│   ├── forge_audit.py      append-only JSON-lines audit log of every remote action
│   └── overlay/*.py        dropped into the vendored daemon to add cursor/antigravity/opencode/copilot
│
├── relay/                  the pipe. Same protocol, two deployments.
│   ├── PROTOCOL.md         frame reference — read this before touching either relay
│   ├── worker/             Cloudflare Worker + Durable Objects (production, zero idle cost)
│   └── node/               Node relay for local dev and self-hosting (same frames, in-memory store)
│
├── supabase/migrations/    machines table + RLS (apply with supabase db push)
├── tests/                  node --test suites: relay routing rules + the full-pipe e2e
│                           (relay → real Python bridge → real /bin/sh, encrypted end to end)
├── docs/                   architecture, current state, this file (history/ = superseded plans)
└── vendor/agent-remote/    upstream daemon at a pinned commit — do not edit; overlay it from bridge/overlay
```

## Conventions

- **Routes are thin.** No business logic in `app/**/route.ts`; it lives in `lib/server/`.
- **One concern per file.** If a file needs a comment explaining two unrelated jobs, split it.
- **Feature folders, not type folders.** `components/terminal/` holds the terminal's components;
  there is no `components/atoms|organisms`.
- **Class namespace = CSS file.** New component → pick a namespace → its CSS goes in that file only.
- **Never put a secret in a URL.** Tickets are short-lived and single-use; see `relay/PROTOCOL.md`.
- **The laptop side is Python stdlib + two deps** (`websocket-client`, `cryptography`, plus
  `pywinpty` on Windows). Keep it that way: the installer runs on machines we do not control.
- **`vendor/` is read-only.** Upstream changes come in by bumping the pinned commit and adding an
  overlay file, never by editing vendored code.
