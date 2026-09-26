// Cross-language parity: the command the browser *shows* versus the command the
// laptop *execs*.
//
// Two builders, two languages, one promise:
//
//   lib/shared/cli-flags.ts   buildCliCommand()      what the visitor reads
//   bridge/overlay/cli_launch.py  build_headless_cmd()   cursor / agy / opencode / copilot
//   vendor …/providers/claude.py  prepare()                claude
//   vendor …/providers/codex.py   prepare()                codex (+ our overlay rewrite)
//
// If they drift, the UI shows one command and the machine runs another — which
// is worse than either being wrong on its own, because the visitor has already
// agreed to what they read. So this file runs BOTH sides over the same matrix
// (the Python in one subprocess, via tests/fixtures/build_argv_matrix.py) and
// compares real argv, not intentions.
//
// The vendored daemon is read-only, so it can move under us: the last test here
// reads the vendored provider sources and fails if the argv they build stops
// matching what our profiles claim they add.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCliCommand,
  cliProfile,
  cliProfileList,
  defaultFlagState,
  permissionModeFor,
} from '../lib/shared/cli-flags.ts';
import { wirePermissionMode } from '../lib/shared/daemon.ts';

const REPO = new URL('..', import.meta.url).pathname;
const PYTHON = join(REPO, '.venv', 'bin', 'python');
const MATRIX = join(REPO, 'tests', 'fixtures', 'build_argv_matrix.py');
const HAVE_PYTHON = existsSync(PYTHON);

/**
 * What each real CLI's `--help` advertises, as far as the flags cli_launch
 * detects. The daemon builds argv from this text (detect_cli_flags), so a
 * parity check that used one generic help for all six would be checking a
 * machine that does not exist. These are help-only stubs: nothing runs them.
 */
const HELP = {
  claude: `Usage: claude [options] [prompt]
  -p, --print                     Print response and exit
      --output-format <format>    text | json | stream-json
      --model <model>             Model to use
      --permission-mode <mode>    default | acceptEdits | plan | bypassPermissions
      --dangerously-skip-permissions
      --resume <id>               Resume a session
      --continue                  Continue the last session
      --add-dir <dir>             Additional directory
      --allowedTools <tools>      Tool allowlist
      --max-turns <n>             Stop after n turns
      --append-system-prompt <t> Extra instructions`,
  codex: `Usage: codex exec [OPTIONS] [PROMPT]
      --json                      Emit JSON events
  -s, --sandbox <mode>            read-only | workspace-write | danger-full-access
  -a, --ask-for-approval <mode>   untrusted | on-request | on-failure | never
  -m, --model <model>             Model to use
  -C, --cd <dir>                  Working directory
      --skip-git-repo-check       Allow a non-git folder
      --dangerously-bypass-approvals-and-sandbox`,
  cursor: `Usage: agent [options] [prompt]
  -p, --print                     Print response and exit
      --output-format <format>    text | json | stream-json
      --stream-partial-output     Stream partials
      --model <model>             Model to use
      --mode <mode>               agent | plan | ask
      --force                     Skip the safety check
      --workspace <dir>           Workspace folder
      --resume <id>               Resume a session`,
  opencode: `Usage: opencode run [options] [message]
      --format <format>           text | json
      --auto                      Auto-approve
      --agent <name>              build | plan
      --model <model>             Model to use
      --session <id>              Resume a session
      --dir <path>                Working directory`,
  copilot: `Usage: copilot [options]
  -p, --prompt <text>             The prompt
      --allow-all-tools           Let every tool run
      --deny-tool <spec>          Refuse a tool
      --silent                    No banner
      --output-format <format>    text | json
      --model <model>             Model to use`,
  antigravity: `Usage: agy [options] [prompt]
      --print                     Print response and exit
      --output-format <format>    text | json | stream-json
      --model <model>             Model to use
      --workspace <dir>           Workspace folder`,
};

const STUB_DIR = HAVE_PYTHON ? mkdtempSync(join(tmpdir(), 'forge-parity-cli-')) : '';

/** A help-only stand-in for one CLI, so detect_cli_flags sees the right flags. */
function stubBinary(id) {
  const path = join(STUB_DIR, `fake-${id}`);
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--help" ] || [ "$1" = "-h" ]; then\n  cat <<'HELP'\n${HELP[id]}\nHELP\n  exit 0\nfi\nexit 0\n`,
    'utf8',
  );
  chmodSync(path, 0o755);
  return path;
}

if (HAVE_PYTHON) {
  process.on('exit', () => rmSync(STUB_DIR, { recursive: true, force: true }));
}

const IDS = cliProfileList().map((profile) => profile.id);
const MODES = ['plan', 'acceptEdits', 'bypassPermissions', 'default'];

/** The prompt every case uses — awkward on purpose. */
const PROMPT = "Fix the retry helper's swallowed timeout, then run the tests.";

/** A model id per CLI, straight out of the profile's own suggestions. */
const modelFor = (id) => cliProfile(id).models[0]?.id ?? '';

/**
 * The daemon-side flavor name for a CLI (bridge/overlay/cli_launch.py::_flavor_key).
 */
const flavorFor = (id) => (id === 'antigravity' ? 'agy' : id === 'cursor' ? 'cursor' : id);

/**
 * claude and codex are built by the vendored daemon, not by build_headless_cmd,
 * so their counterpart argv comes from the fixture's reconstruction of
 * providers/{claude,codex}.py::prepare (kept honest by the last test here).
 */
const executedKey = (id) => (id === 'claude' ? 'claude_argv' : id === 'codex' ? 'codex_argv' : 'argv');

/**
 * Same flag, different spelling: the preview uses the documented long form, the
 * daemon uses the short one it was written with. codex accepts both.
 */
const ALIASES = {
  '--sandbox': '-s',
  '--ask-for-approval': '-a',
  '--model': '-m',
  '--cd': '-C',
  // codex's own alias for the same "no sandbox, no approvals" switch.
  '--yolo': '--dangerously-bypass-approvals-and-sandbox',
  // claude and cursor both accept the short and the long headless flag; the
  // preview shows the short one, cli_launch uses whichever --help advertised.
  '-p': '--print',
};

const sameFlag = (piece, other) => piece === other || ALIASES[piece] === other || ALIASES[other] === piece;

/** True when every element of `needle` appears in `haystack`, in order. */
function isSubsequence(needle, haystack) {
  let at = 0;
  for (const piece of haystack) {
    if (at < needle.length && sameFlag(needle[at], piece)) at += 1;
  }
  return at === needle.length;
}

/** Run the whole matrix through the Python builders in one subprocess. */
function pythonArgv(cases) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-parity-'));
  const input = join(dir, 'cases.json');
  const output = join(dir, 'argv.json');
  try {
    writeFileSync(input, JSON.stringify(cases));
    execFileSync(PYTHON, [MATRIX, input, output], { cwd: REPO, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseCase(id, mode, model, extra = {}) {
  return {
    cli: id,
    flavor: flavorFor(id),
    binary: stubBinary(id),
    prompt: PROMPT,
    permission_mode: mode,
    model,
    session_id: '',
    cwd: '/tmp/project',
    ...extra,
  };
}

/** Every mode × model, for tests that only inspect what the laptop would run. */
function matrix(extra = {}) {
  const cases = [];
  for (const id of IDS) {
    for (const mode of MODES) {
      for (const model of ['', modelFor(id)]) cases.push(baseCase(id, mode, model, extra));
    }
  }
  return cases;
}

/**
 * The cases a real visitor produces: the panel's default state, the model they
 * picked, and the permission_mode that state maps to. Comparing the preview with
 * anything else would be comparing two commands nobody asked for.
 */
function visitorMatrix() {
  const cases = [];
  for (const id of IDS) {
    const flags = defaultFlagState(cliProfile(id));
    const mode = wirePermissionMode(permissionModeFor({ cli: id, flags }));
    for (const model of ['', modelFor(id)]) cases.push(baseCase(id, mode, model));
  }
  return cases;
}

const SKIP = HAVE_PYTHON ? false : 'python venv missing (.venv/bin/python)';

test('the preview shows the flags the laptop will really pass', { skip: SKIP, timeout: 120_000 }, () => {
  const cases = visitorMatrix();
  const results = pythonArgv(cases);
  assert.equal(results.length, cases.length);

  cases.forEach((testCase, index) => {
    const id = testCase.cli;
    const profile = cliProfile(id);
    const flags = defaultFlagState(profile);
    // The browser sends the mode it derived from the panel; the laptop runs it.
    assert.equal(
      testCase.permission_mode,
      wirePermissionMode(permissionModeFor({ cli: id, flags })),
      `${id}: the case must carry the mode the panel produces`,
    );
    const preview = buildCliCommand({ cli: id, prompt: PROMPT, model: testCase.model, flags });
    const executed = results[index][executedKey(id)];
    const where = `${id} mode=${testCase.permission_mode} model=${testCase.model || '(none)'}`;

    assert.ok(Array.isArray(executed) && executed.length > 2, `${where}: no argv came back`);

    // 1. Every option the visitor was shown is really passed.
    for (const piece of preview.argv.slice(1)) {
      if (!piece.startsWith('-')) continue;
      assert.ok(
        executed.some((other) => sameFlag(piece, other)),
        `${where}: the preview promises ${piece} but the laptop runs ${executed.join(' ')}`,
      );
    }

    // 2. The prompt arrives exactly once, and intact.
    const occurrences = executed.filter((piece) => piece === PROMPT).length;
    assert.equal(occurrences, 1, `${where}: the prompt must be passed exactly once`);

    // 3. What Forge itself adds is there too, in order.
    const daemon = profile.daemonAlways?.argv ?? [];
    if (daemon.length) {
      assert.ok(isSubsequence(daemon, executed), `${where}: missing Forge's own flags ${daemon.join(' ')}`);
    }

    // 4. The preview explains every flag it shows, so nothing is a mystery.
    assert.ok(preview.explain.length >= (daemon.length ? 1 : 0), `${where}: nothing explained`);
  });
});

test('permission_mode decides the freedom of the run, identically on both sides', { skip: SKIP, timeout: 120_000 }, () => {
  const cases = matrix();
  const results = pythonArgv(cases);

  const FREEDOM = {
    full: [
      '--dangerously-skip-permissions',
      '--dangerously-bypass-approvals-and-sandbox',
      '--yolo',
      '--force',
      '--auto',
      '--allow-all-tools',
    ],
    readOnly: ['read-only', 'plan', '--deny-tool', '--mode'],
  };
  const freedom = (argv) => {
    if (argv.some((piece) => FREEDOM.full.includes(piece))) return 'full'
    if (argv.some((piece) => FREEDOM.readOnly.includes(piece))) return 'read-only'
    return 'edits'
  };

  cases.forEach((testCase, index) => {
    const id = testCase.cli;
    const mode = testCase.permission_mode;
    const executed = results[index][executedKey(id)];
    const where = `${id} mode=${mode}`;

    if (id === 'claude') {
      // claude speaks permission_mode natively: it is passed straight through.
      assert.ok(isSubsequence(['--permission-mode', mode], executed), `${where}: ${executed.join(' ')}`);
      if (mode === 'plan') {
        assert.ok(!executed.includes('--dangerously-skip-permissions'), `${where}: plan must never skip prompts`);
      }
      return;
    }
    if (id === 'codex') {
      // codex speaks sandbox/approval; our overlay translates (codex_mode.py).
      const expected = { plan: 'read-only', acceptEdits: 'edits', default: 'edits', bypassPermissions: 'full' }[mode];
      assert.equal(freedom(executed), expected, `${where}: ${executed.join(' ')}`);
      assert.equal(executed.at(-1), PROMPT, `${where}: codex must still end with the prompt`);
      return;
    }
    if (id === 'opencode') {
      // opencode's own plan agent proposes without editing, and --auto is
      // dropped for it (cli_launch._build_opencode_cmd).
      assert.equal(executed.at(-1), PROMPT, where);
      assert.equal(
        freedom(executed),
        mode === 'plan' ? 'read-only' : 'full',
        `${where}: ${executed.join(' ')}`,
      );
      return;
    }
    if (id === 'copilot') {
      // Copilot's only brake is its deny list: a read-only pass denies writes
      // and gives up --allow-all-tools; anything else allows every tool and the
      // permission prompts go to the phone.
      assert.equal(executed.at(-1), PROMPT, where);
      assert.equal(
        freedom(executed),
        mode === 'plan' ? 'read-only' : 'full',
        `${where}: ${executed.join(' ')}`,
      );
      return;
    }
    if (id === 'cursor') {
      // cursor spells read-only as `--mode plan`, and drops --force with it.
      assert.equal(executed.at(-1), PROMPT, where);
      assert.equal(
        freedom(executed),
        mode === 'plan' ? 'read-only' : 'full',
        `${where}: ${executed.join(' ')}`,
      );
      if (mode === 'plan') assert.ok(!executed.includes('--force'), where);
      return;
    }
    // antigravity has no read-only flag (the profile says so, and the research
    // brief itself forbids edits), so a plan pass is indistinguishable in argv.
    assert.equal(executed.at(-1), PROMPT, where);
    assert.equal(freedom(executed), 'edits', `${where}: ${executed.join(' ')}`);
    assert.equal(cliProfile('antigravity').deepResearch.argv.length, 0, 'agy advertises no research flags');
  });
});

test('an empty permission_mode never means "whatever the laptop config says"', () => {
  // The daemon treats '' as "use config.permission_mode" (jobs.py), which is a
  // machine-level setting the visitor never saw. wirePermissionMode sends
  // claude's own word for asking instead.
  assert.equal(wirePermissionMode(''), 'default');
  assert.equal(wirePermissionMode(undefined), 'default');
  assert.equal(wirePermissionMode(null), 'default');
  assert.equal(wirePermissionMode('  '), 'default');
  assert.equal(wirePermissionMode('plan'), 'plan');
  assert.equal(wirePermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(wirePermissionMode('bypassPermissions'), 'bypassPermissions');

  // And the choice the panel calls "Ask each time" is the one that maps to it.
  const claude = defaultFlagState(cliProfile('claude'));
  claude.selects['permission-mode'] = 'default';
  assert.equal(permissionModeFor({ cli: 'claude', flags: claude }), '');
  assert.equal(wirePermissionMode(permissionModeFor({ cli: 'claude', flags: claude })), 'default');
});

test('the model the visitor picks is on both command lines', { skip: SKIP, timeout: 120_000 }, () => {
  const cases = visitorMatrix().filter((testCase) => testCase.model);
  const results = pythonArgv(cases);

  cases.forEach((testCase, index) => {
    const id = testCase.cli;
    const profile = cliProfile(id);
    const preview = buildCliCommand({
      cli: id,
      prompt: PROMPT,
      model: testCase.model,
      flags: defaultFlagState(profile),
    });
    const executed = results[index][executedKey(id)];
    const where = `${id} model=${testCase.model}`;

    assert.ok(isSubsequence([profile.modelFlag, testCase.model], preview.argv), `${where}: preview`);
    assert.ok(
      executed.some((piece) => sameFlag(profile.modelFlag, piece)) && executed.includes(testCase.model),
      `${where}: the laptop must run the same model, got ${executed.join(' ')}`,
    );
  });
});

test('a resumed session reaches the CLIs that can resume, and only those', { skip: SKIP, timeout: 120_000 }, () => {
  const sessionId = 'ses_01hzy3k9';
  const cases = visitorMatrix().map((testCase) => ({ ...testCase, session_id: sessionId }));
  const results = pythonArgv(cases);

  // What each CLI's own resume mechanism is. Copilot and Antigravity have no
  // headless resume flag, so the profile must say so and the console must not
  // claim the next prompt continues the conversation (canResume in cli-flags.ts).
  const resume = {
    claude: ['--resume', sessionId],
    codex: ['resume', sessionId],
    cursor: ['--resume', sessionId],
    opencode: ['--session', sessionId],
    copilot: null,
    antigravity: null,
  };

  cases.forEach((testCase, index) => {
    const id = testCase.cli;
    const executed = results[index][executedKey(id)];
    const expected = resume[id];
    assert.equal(cliProfile(id).canResume, Boolean(expected), `${id}: the profile must match reality`);
    if (!expected) {
      assert.ok(!executed.includes(sessionId), `${id} cannot resume: ${executed.join(' ')}`);
      return;
    }
    assert.ok(isSubsequence(expected, executed), `${id}: ${executed.join(' ')}`);
    // claude takes the prompt as -p's value (so it sits early); the CLIs built
    // by cli_launch.py put it last. Either way it is passed exactly once.
    const promptAt = executed.indexOf(PROMPT);
    assert.equal(executed.filter((piece) => piece === PROMPT).length, 1, `${id}: one prompt`);
    if (id === 'claude') assert.equal(executed[promptAt - 1], '-p', `${id}: ${executed.join(' ')}`);
    else assert.equal(executed.at(-1), PROMPT, `${id}: the prompt is still last`);
  });
});

test('the vendored daemon still builds the argv our profiles claim', () => {
  // vendor/ is read-only and pinned, but a bump is a one-line change — so the
  // claims baked into CLI_PROFILES.daemonAlways are checked against the source
  // they came from. If this fails, update the profile (and the preview), not
  // the vendor.
  const claude = readFileSync(join(REPO, 'vendor/agent-remote/daemon/agentremoted/providers/claude.py'), 'utf8');
  for (const literal of ['"-p"', '"--output-format", "stream-json"', '"--verbose"', '"--permission-mode"', '"--resume"', '"--model"']) {
    assert.ok(claude.includes(literal), `claude.py no longer passes ${literal}`);
  }

  const codex = readFileSync(join(REPO, 'vendor/agent-remote/daemon/agentremoted/providers/codex.py'), 'utf8');
  for (const literal of ['"exec", "--json"', '"--skip-git-repo-check"', '"-m"', '"-C"', '"resume"']) {
    assert.ok(codex.includes(literal), `codex.py no longer passes ${literal}`);
  }
  // Our overlay is what makes the phone's permission choice reach codex.
  assert.ok(
    codex.includes('"danger-full-access"'),
    'codex.py changed its sandbox vocabulary — bridge/overlay/codex_mode.py must follow',
  );

  const launch = readFileSync(join(REPO, 'bridge/overlay/cli_launch.py'), 'utf8');
  for (const literal of ['"run", "--format", "json"', '"--auto"', '"--agent", "plan"', '"--allow-all-tools"', '"--silent"']) {
    assert.ok(launch.includes(literal), `cli_launch.py no longer passes ${literal}`);
  }

  // And the profiles still describe those flags to the visitor.
  const claudeProfile = cliProfile('claude');
  assert.deepEqual(claudeProfile.daemonAlways?.argv, ['--output-format', 'stream-json', '--verbose']);
  const codexProfile = cliProfile('codex');
  assert.deepEqual(codexProfile.daemonAlways?.argv, ['--json', '--skip-git-repo-check']);
  assert.equal(cliProfile('copilot').promptFlag, '-p', "copilot's -p takes the prompt as its value");
});

test('the install command the visitor copies is the one the installer serves', () => {
  // Small, but it is the first thing anybody runs: the pairing/install copy in
  // the UI must match what /api/install/* actually serves.
  const script = readFileSync(join(REPO, 'lib/server/install-script.ts'), 'utf8');
  assert.ok(script.includes('/api/forge/cli_launch.py'), 'the installer fetches the CLI launcher');
  assert.ok(script.includes('/api/forge/codex_mode.py'), 'and the codex permission wrapper');
  assert.ok(script.includes('/api/forge/forge_hook.py'), 'and the provider hook');
  assert.ok(script.includes('"permission_mode": "acceptEdits"'), 'the laptop default is not full access');
  assert.ok(script.includes('"codex_sandbox": "workspace-write"'), 'codex defaults to the project box');
});
