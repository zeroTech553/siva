# Verification report

Date: 2026-09-24 · branch `arena/01a0cdd0-siva` · Linux (this sandbox).

Written against the audit standard: **nothing counts as verified unless it was
executed.** Claims from a previous session are not evidence; a green build is not
evidence; a passing test is only evidence of what it asserts. Where something
could not be executed here, it says NOT VERIFIED with the reason.

## VERIFICATION STATUS

**Production Confidence: PARTIALLY VERIFIED**

Everything that runs on Linux, and everything that is pure logic, was executed
and passes. What is missing is the one thing this sandbox does not have: a real
browser, and a laptop running a real coding CLI. Both are named below.

## WHAT WAS EXECUTED

```
corepack pnpm typecheck          clean
corepack pnpm build              clean, / and /console are ○ (Static)
node --test tests/*.test.mjs     83 tests, 83 pass, 0 fail, 0 skipped
python3 -m unittest (bridge)     90 tests, OK
node scripts/doctor.mjs          relay reached, real pairing code minted
```

The suite no longer silently skips. Before this session the end-to-end tests
were **being skipped** — `.venv` and `node_modules` were absent, so
`tests/e2e-terminal.test.mjs` reported `skip: 'python venv missing'` and the run
looked green. Both were rebuilt; the e2e tests now actually run. That was the
most consequential finding, and it was a process finding, not a code one.

## VERIFIED

- **Full pipe, real processes.** `tests/e2e-prompt.test.mjs` spawns the real
  Next.js app, the real Node relay, the real `bridge/forge_bridge.py` and a
  stub daemon speaking the vendored daemon's API, then sends a prompt and waits
  for the job to finish. It asserts the prompt reached a **real subprocess**
  byte-identical as the last argv element, that the stream-json output was parsed
  into job events, that a follow-up prompt resumed the session id, and that the
  app's own access log shows `POST /d/<id>/api/sessions/new 200`.
- **Terminal + files + crypto.** `tests/e2e-terminal.test.mjs`: real Python
  bridge, real `/bin/sh`, X25519 + AES-256-GCM, ticket burn (4001 on reuse),
  scrollback replay on re-attach, encrypted file RPC.
- **Pairing.** Code minted through the real app; single-use (409 on reuse);
  cross-origin mint blocked (403); a wrong phone secret does not reveal the
  device; `/internal` never proxied.
- **CLI argv parity (cross-language).** `tests/cli-parity.test.mjs` runs the real
  Python builders in a subprocess over 12 visitor-realistic cases and compares
  argv against `lib/shared/cli-flags.ts`.
- **Security-relevant surface, by execution:** origin checks, header allowlist,
  `/internal` block, single-use tickets, daemon token never in a browser body,
  file containment (`bridge/tests/test_files.py`), crypto
  (`bridge/tests/test_crypto*.py`).
- **Cost rules.** Build output shows `○ /` and `○ /console`; every API route
  declares `maxDuration`; the polling maths is asserted against a budget.
- **Landing page, at HTTP level.** `/` (47 KB) and `/console` (23 KB) return 200;
  the served CSS contains the `#e9ecec` pegboard and contains **no** lime/green
  hex value; the installer, the overlay modules and 404-on-unknown-overlay all
  behave.
- **Laptop installer content.** `pnpm doctor` confirms all 6 bridge modules and
  all 8 overlays exist and that `cli_launch.py` imports cleanly.

## BUGS FOUND AND FIXED

| Severity | Location | Root cause | Fix |
| --- | --- | --- | --- |
| **High** | `use-agent-console.ts` | the model the visitor picked was never sent to the daemon — every job ran the CLI's own default | `model` now sent on both job routes; `build_headless_cmd` takes it; `--model`/`-m` detected from `--help` |
| **High** | codex provider | upstream takes sandbox/approval from `config.json` and ignores `permission_mode`, so **every** codex job ran with `--dangerously-bypass-approvals-and-sandbox` regardless of the UI | new overlay `bridge/overlay/codex_mode.py` + `apply_codex_permission` rewrites the argv; wired into the installer |
| **High** | `install-script.ts` | the laptop's fallback config was `permission_mode: bypassPermissions` + `codex_sandbox: danger-full-access` — full access by default | `acceptEdits` / `workspace-write` |
| **Medium** | `permission_mode` on the wire | `''` was sent for "ask each time", but the daemon reads `''` as *use the laptop's config default* — a machine-level setting the visitor never saw | `wirePermissionMode()` sends `default` |
| **Medium** | preview vs reality | the preview omitted the flags the daemon always adds (claude's `--output-format stream-json --verbose`, codex's `--json`, copilot's `--allow-all-tools --silent`…) | `daemonAlways` per profile, shown **and explained**; the daemon's flags win over a conflicting panel choice |
| **Medium** | copilot | `-p` takes the prompt as its value, so the preview put the visitor's flags *between* `-p` and the prompt — a command that would not paste | `promptFlag`; copilot now emits `-p <prompt>` last |
| **Medium** | claude / codex cwd | the preview used `--add-dir` / `--cd`, neither of which is what the daemon passes; claude has no directory flag at all | `-C` for codex; `cd <dir> && …` shown for claude and copilot |
| **Medium** | opencode, copilot, cursor | "plan"/read-only was not translated into anything for these three, so a read-only pass still auto-approved | `--agent plan` (opencode), `--deny-tool write` (copilot), `--mode plan` (cursor); `--force`/`--auto`/`--allow-all-tools` dropped with them |
| **Medium** | resume | copilot and antigravity have no headless resume flag, but the console kept the session id and implied the next prompt continued the conversation | `canResume` per profile; those two start fresh |
| **Medium** | duplicate flags | two switches meaning the same thing (`--yolo` + full-access sandbox) both landed in argv | deduped to one |
| **Low** | `lib/shared/cli-catalog.ts` | a second, smaller list of the same six CLIs — the UI read one, the command builder used the other | deleted; aliases moved into `cli-flags.ts` |
| **Low** | codex `--sandbox danger-full-access` | not the flag the daemon actually passes | preview now shows `--dangerously-bypass-approvals-and-sandbox` |
| **High** | `lib/server/relay.ts` | a refactor left `fetch(\`${relayUrl}${path}\`)` — the *function object*, not its result — so every relay call fetched an unparseable URL and surfaced as a confusing **502 "relay unavailable"**. Typecheck and build both passed; a template literal accepts anything | fixed, plus a guard that refuses a non-URL base and names the bad value; `tests/env.test.mjs` pins the behaviour |
| **Test flake** | `tests/e2e-prompt.test.mjs` | the test spawns `next dev`, which shares `.next` with `pnpm build`; a production build left behind made the dev server serve nothing, so the test timed out with an empty log and looked like a network failure | the spawned server gets its own `FORGE_DIST_DIR` (`.next-e2e`) |
| **Process** | the test suite | `.venv` and `node_modules` absent → e2e tests **skipped** while the run reported success | both restored; `pnpm doctor` now fails loudly when a test is skipped |

The first two bugs in that table were found by *executing* the pipe, not by
reading code: the model the visitor picked never reached the CLI, and codex
ignored the permission mode entirely. Neither could be caught by a unit test of
the browser alone, because both live in the gap between what the UI promises and
what the laptop does.

The relay-URL bug is worth dwelling on: it was introduced by a refactor in this
same session, `tsc` and `next build` both passed, and the only thing that
noticed was the end-to-end test. It is the argument for keeping that test.

## NOT VERIFIED

- **A real browser.** No browser is installed here, so nothing about rendering,
  pointer interaction, keyboard focus, dragging windows, or the CRT visuals was
  executed. The pages were fetched over HTTP and the CSS was inspected, which is
  static analysis of the output, not a user journey.
- **A real coding CLI.** `claude`, `codex`, `cursor`, `opencode`, `copilot` and
  `agy` are not installed here. The argv they receive is asserted exactly; their
  *behaviour* with that argv — whether they accept the flags in that order,
  whether the model id resolves — is not.
- **The vendored daemon.** `agentremoted` is exercised through a stub that speaks
  its documented API. It requires `tmux`, which is absent. The overlay code it
  loads (`cli_launch.handle_stream_line`, `finalize_job`) is the real thing and is
  executed by the e2e test.
- **Supabase.** No project credentials here, so accounts, RLS and the migration
  are unexecuted. `pnpm doctor` checks for the `machines` table when keys exist.
- **The Cloudflare Worker relay.** Only the Node relay was run. They share
  `relay/PROTOCOL.md` and `tests/relay-room.test.mjs` covers the routing rules.
- **Installer on a laptop.** `install.sh` / `.ps1` / `.py` were not run; only
  served and inspected.

## CROSS-PLATFORM MATRIX

| Platform | Status | Evidence |
| :--- | :--- | :--- |
| Linux | **Verified** | every test in this report ran here; real PTY (`ready.pty === true`, `backend === 'posix'`) |
| macOS | Not verified | no hardware. POSIX paths are shared with Linux; Windows-specific branches are the risk |
| Windows | Not verified | `forge_pty.py` ConPTY path and the PowerShell quoting are unit-tested (`tests/cli-flags.test.mjs`) but never executed against a Windows console |
| Browser | Partially verified | HTTP-level only: both pages 200, static in the build, CSS inspected. No DOM/interaction execution |

## TEST QUALITY

The pre-existing tests were honest about argv and quoting. What they could not
catch was **drift between the two implementations**, because each side was only
ever tested against itself. `tests/cli-parity.test.mjs` closes that: it runs the
real Python over the same inputs and compares. It also reads the vendored
provider sources and fails if they stop matching what our profiles claim, so a
daemon bump cannot quietly invalidate the preview.

The e2e tests were previously skippable in a way that looked like success. A
skipped test now counts as a warning in `pnpm doctor`.

## REMAINING RISKS

1. **CLI behaviour is unverified.** The argv is right; whether each CLI accepts
   it is not. First real run per CLI should be watched.
2. **No browser test.** A visual or interaction regression would not be caught.
3. **Supabase unexercised.** Apply the migration before enabling accounts.
4. **The laptop runs what the phone asks.** That is the product, and it is why
   the permission defaults were tightened — but a visitor who picks "full access"
   gets full access.
5. **The relay's two implementations** are only contract-tested, not
   integration-tested against the same client.

## WHAT THIS SESSION ADDED

- `tests/e2e-prompt.test.mjs` — the full journey, real app, real processes.
- `tests/cli-parity.test.mjs` — browser preview ↔ laptop argv, cross-language.
- `bridge/tests/test_cli_launch.py` — 21 tests for the argv builder and the codex
  permission rewrite.
- `tests/fixtures/{fake-cli,stub_daemon.py,build_argv_matrix.py}` — the only
  fakes in the data path.
- `lib/server/env.ts` + `scripts/doctor.mjs` + `pnpm doctor` — plug-and-play.
- `bridge/overlay/codex_mode.py` — the codex permission fix.
- `docs/forge-architecture.md` rewritten; `docs/repo-layout.md` updated.
- `tests/env.test.mjs` — the env validation `pnpm doctor` reports.
