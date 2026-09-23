# Forge

Your computer, in your pocket. Pair a laptop once and get, from any browser:

- a **real terminal** — a live PTY on that laptop, streamed over an
  end-to-end-encrypted WebSocket (the relay only ever routes ciphertext)
- your **coding agents** — drive Claude Code, Codex, Cursor, OpenCode and
  Copilot sessions running on that machine
- your **files** — browse and read the laptop's disk, rooted and audited

The laptop makes one outbound WebSocket. No inbound port, no tunnel binary.
Accounts (Supabase) are optional: without keys the app runs in device-only
mode and pairing state lives in the browser.

## Use it

1. Open the site and copy the install command.
2. Run it on the laptop (macOS, Linux, or Windows).
3. When the console shows **Online**, open Terminal, File Manager, or ask the agent.

## Develop

```sh
pnpm install
pnpm relay:dev     # local relay on :8787 (needs WORKER_PROXY_SECRET)
pnpm dev           # web app on :3000
pnpm test          # relay routing rules + full-pipe e2e (relay → real bridge → real shell)
pnpm test:bridge   # 69 laptop-side Python tests
pnpm sprites       # rebuild the pixel-art icons from pixel/sprites.mjs
```

Copy `.env.example` to `.env.local` and fill in what you need. Read
`docs/repo-layout.md` for where things live, and `relay/PROTOCOL.md` before
touching either relay.

Deployed at https://clone-github-repository-olive.vercel.app — the Cloudflare
Worker relay (`relay/worker`) carries production traffic; the Node relay
(`relay/node`) is the same protocol for development and self-hosting.
