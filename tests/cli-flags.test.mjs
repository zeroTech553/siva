// Unit tests for lib/shared/cli-flags.ts — the argv builder behind the landing
// page's CLI selector and the "Send a prompt" section.
//
// This is the file that decides what actually runs on somebody's laptop, so the
// assertions are about exact argv, exact shell quoting and the mapping onto the
// daemon's single `permission_mode` field. The daemon-side reference
// implementation is bridge/overlay/cli_launch.py::build_headless_cmd; if these
// two ever disagree, the browser shows one command and the laptop runs another.
//
// cli-flags.ts imports types only (erased at runtime), so `node --test` runs it.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEEP_RESEARCH_BRIEF,
  buildCliCommand,
  cliProfile,
  cliProfileList,
  defaultFlagState,
  permissionModeFor,
  quotePosix,
  quotePowerShell,
  summariseFlags,
  wrapForDeepResearch,
} from '../lib/shared/cli-flags.ts';

const IDS = ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'antigravity'];

/** Nothing switched on: the CLI runs exactly as it would from a bare shell. */
const NO_FLAGS = { toggles: {}, selects: {}, values: {} };

/** argv with the prompt dropped, so tests can assert on the flags alone. */
function flagsOf(build) {
  const built = buildCliCommand(build);
  // Copilot takes the prompt as the value of -p, so drop both.
  return cliProfile(build.cli).promptFlag ? built.argv.slice(0, -2) : built.argv.slice(0, -1);
}

/**
 * The argv the laptop's daemon adds by itself, whatever the visitor picked
 * (claude always streams JSON, codex always asks for --json, and so on). Read
 * from the profile rather than written out here, so this file stays a test of
 * buildCliCommand and not a copy of the catalog.
 */
const daemonOf = (id) => [...(cliProfile(id).daemonAlways?.argv ?? [])];

/** What every command for this CLI starts with: its head, then the daemon's. */
const prefixOf = (id) => [...cliProfile(id).head, ...daemonOf(id)];

test('every supported CLI is in the catalog exactly once', () => {
  const listed = cliProfileList().map((profile) => profile.id);
  assert.deepEqual(listed, IDS);
  assert.equal(new Set(listed).size, listed.length);
});

test('a profile resolves from its id, its binary or its display name', () => {
  assert.equal(cliProfile('codex').id, 'codex');
  assert.equal(cliProfile('agy').id, 'antigravity', 'binary name');
  assert.equal(cliProfile('Claude Code').id, 'claude', 'display name');
  assert.equal(cliProfile('claude-code').id, 'claude', 'slug form');
  assert.equal(cliProfile('').id, IDS[0], 'empty falls back to the first profile');
  assert.equal(cliProfile('nonsense').id, IDS[0], 'unknown falls back instead of throwing');
  assert.equal(cliProfile(undefined).id, IDS[0]);
});

test('omitting the flag state applies the profile’s recommended defaults', () => {
  const bare = buildCliCommand({ cli: 'claude', prompt: 'x', flags: NO_FLAGS });
  assert.deepEqual(bare.argv, [...prefixOf('claude'), 'x']);

  const defaulted = buildCliCommand({ cli: 'claude', prompt: 'x' });
  assert.deepEqual(defaulted.argv, [...prefixOf('claude'), '--permission-mode', 'acceptEdits', 'x']);
  // Both the daemon's own flags and a default change behaviour, so both are explained.
  assert.equal(defaulted.explain.length, 2);
  assert.match(defaulted.explain[0], /forge/i);
  assert.match(defaulted.explain[1], /permission mode/i);

  assert.deepEqual(buildCliCommand({ cli: 'codex', prompt: 'x' }).argv, [
    ...prefixOf('codex'),
    '--sandbox',
    'workspace-write',
    'x',
  ]);
});

test('every CLI builds one non-interactive turn: head … prompt', () => {
  const heads = {
    claude: ['claude', '-p'],
    codex: ['codex', 'exec'],
    cursor: ['agent', '-p'],
    opencode: ['opencode', 'run'],
    // Copilot's -p takes the prompt as its value, so it sits next to the prompt.
    copilot: ['copilot'],
    antigravity: ['agy', '--print'],
  };
  for (const id of IDS) {
    const built = buildCliCommand({ cli: id, prompt: 'fix the failing test', flags: NO_FLAGS });
    assert.deepEqual(built.argv.slice(0, heads[id].length), heads[id], `${id} head`);
    assert.deepEqual(built.argv.slice(heads[id].length, prefixOf(id).length), daemonOf(id), `${id} daemon flags`);
    assert.equal(built.argv.at(-1), 'fix the failing test', `${id} prompt is last`);
    assert.equal(built.prompt, 'fix the failing test');
    assert.ok(built.shell.startsWith(prefixOf(id).join(' ')), `${id} shell form`);
    // No visitor flags set, so the only thing to explain is what Forge itself adds.
    assert.equal(built.explain.length, daemonOf(id).length ? 1 : 0, `${id} explains only the daemon's flags`);
    if (daemonOf(id).length) assert.match(built.explain[0], /forge/i, `${id} says why`);
  }
});

test('copilot keeps its prompt beside -p, not after every other flag', () => {
  const flags = defaultFlagState(cliProfile('copilot'));
  const built = buildCliCommand({ cli: 'copilot', prompt: 'explain this repo', flags });
  assert.deepEqual(built.argv.slice(-2), ['-p', 'explain this repo']);
  assert.ok(built.argv.indexOf('-p') > 2, 'the options come first');
  assert.equal(built.shell.endsWith(`-p 'explain this repo'`), true, built.shell);
});

test('the daemon’s own flags win over a conflicting choice in the panel', () => {
  // claude always streams JSON to the phone; picking "JSON" in the panel must
  // not leave two --output-format flags in the command.
  const flags = defaultFlagState(cliProfile('claude'));
  flags.selects['output-format'] = 'json';
  const built = buildCliCommand({ cli: 'claude', prompt: 'x', flags });
  const formats = built.argv.filter((piece) => piece === '--output-format');
  assert.equal(formats.length, 1, built.argv.join(' '));
  assert.equal(built.argv[built.argv.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(
    !built.explain.some((line) => line.startsWith('--output-format json')),
    'the dropped choice is not explained as if it had survived',
  );
});

test('a working directory uses the CLI’s own flag, or cd when it has none', () => {
  const codex = buildCliCommand({ cli: 'codex', prompt: 'x', cwd: '/my repo', flags: NO_FLAGS });
  assert.deepEqual(codex.argv.slice(-3), ['-C', '/my repo', 'x'], 'codex takes -C, like the daemon passes');

  const claude = buildCliCommand({ cli: 'claude', prompt: 'x', cwd: '/my repo', flags: NO_FLAGS });
  assert.ok(!claude.argv.includes('--add-dir'), 'claude has no directory flag: --add-dir would only add a second root');
  assert.equal(claude.shell, `cd '/my repo' && ${claude.argv.map(quotePosix).join(' ')}`);
  assert.ok(claude.powershell.startsWith('cd "/my repo"; '), claude.powershell);
  assert.ok(claude.explain.some((line) => line.includes('work inside /my repo')));
});

// Quote characters as constants: writing '\'''"`' inline is unreadable and one
// escape short of a syntax error, and this file is read by humans.
const SQ = "'" // single quote
const DQ = '"' // double quote
const BT = '`' // backtick
const BS = '\\' // backslash

/** The awkward prompt every quoting rule has to survive. */
const AWKWARD = `fix it${SQ}s a ${DQ}bug${DQ} with $HOME & ${BT}ls${BT}`

test('the prompt is trimmed and survives awkward characters', () => {
  const built = buildCliCommand({ cli: 'claude', prompt: `  ${AWKWARD}  `, flags: NO_FLAGS });
  assert.equal(built.argv.at(-1), AWKWARD, 'trimmed, and passed as ONE argv element');

  // POSIX: wrap in single quotes, and turn each ' into '\''  (close, escaped
  // quote, reopen). A shell that parses this gets the original string back.
  const head = prefixOf('claude').join(' ')
  const posix = `${SQ}fix it${SQ}${BS}${SQ}${SQ}s a ${DQ}bug${DQ} with $HOME & ${BT}ls${BT}${SQ}`
  assert.equal(built.shell, `${head} ${posix}`, 'a shell can paste this verbatim')

  // PowerShell: wrap in double quotes and backtick-escape " $ and ` only.
  const power = `${DQ}fix it${SQ}s a ${BT}${DQ}bug${BT}${DQ} with ${BT}$HOME & ${BT}${BT}ls${BT}${BT}${DQ}`
  assert.equal(built.powershell, `${head} ${power}`)
});

test('quotePosix leaves safe words alone and single-quotes everything else', () => {
  assert.equal(quotePosix('claude'), 'claude');
  assert.equal(quotePosix('--model'), '--model');
  assert.equal(quotePosix('/Users/me/repo'), '/Users/me/repo');
  assert.equal(quotePosix(''), SQ + SQ, 'the empty string still becomes one argument');
  assert.equal(quotePosix('fix the bug'), `${SQ}fix the bug${SQ}`);
  assert.equal(quotePosix(AWKWARD), `${SQ}fix it${SQ}${BS}${SQ}${SQ}s a ${DQ}bug${DQ} with $HOME & ${BT}ls${BT}${SQ}`);
  assert.equal(quotePosix('no\nnewline'), `${SQ}no\nnewline${SQ}`, 'newlines stay inside the quotes');
});

test('quotePowerShell double-quotes and escapes only " $ and `', () => {
  assert.equal(quotePowerShell('codex'), 'codex');
  assert.equal(quotePowerShell(''), DQ + DQ);
  assert.equal(quotePowerShell('fix the bug'), `${DQ}fix the bug${DQ}`);
  assert.equal(quotePowerShell('pay $HOME now'), `${DQ}pay ${BT}$HOME now${DQ}`);
  assert.equal(quotePowerShell(`say ${DQ}hi${DQ}`), `${DQ}say ${BT}${DQ}hi${BT}${DQ}${DQ}`);
  // Both backticks double: `ls`  →  ``ls``
  assert.equal(quotePowerShell(`${BT}ls${BT}`), `${DQ}${BT}${BT}ls${BT}${BT}${DQ}`);
  assert.equal(
    quotePowerShell(AWKWARD),
    `${DQ}fix it${SQ}s a ${BT}${DQ}bug${BT}${DQ} with ${BT}$HOME & ${BT}${BT}ls${BT}${BT}${DQ}`,
  );
});


test('default flag state: recommended toggles on, declared select defaults only', () => {
  const claude = defaultFlagState(cliProfile('claude'));
  assert.equal(claude.selects['permission-mode'], 'acceptEdits');
  assert.deepEqual(flagsOf({ cli: 'claude', prompt: 'x', flags: claude }), [
    ...prefixOf('claude'),
    '--permission-mode',
    'acceptEdits',
  ]);

  const codex = defaultFlagState(cliProfile('codex'));
  assert.equal(codex.selects.sandbox, 'workspace-write');
  assert.deepEqual(flagsOf({ cli: 'codex', prompt: 'x', flags: codex }), [
    ...prefixOf('codex'),
    '--sandbox',
    'workspace-write',
  ]);

  // Cursor's "Agent" and OpenCode's "build" are the CLIs' own defaults, so they
  // must add NO argv of the visitor's — otherwise we would silently change how
  // the tool behaves. What is left is the head plus what Forge itself adds.
  const cursor = defaultFlagState(cliProfile('cursor'));
  assert.deepEqual(flagsOf({ cli: 'cursor', prompt: 'x', flags: cursor }), prefixOf('cursor'));
  const opencode = defaultFlagState(cliProfile('opencode'));
  assert.deepEqual(flagsOf({ cli: 'opencode', prompt: 'x', flags: opencode }), prefixOf('opencode'));
});

test('toggles, selects and value flags all land in argv, in catalog order', () => {
  const profile = cliProfile('claude');
  const flags = defaultFlagState(profile);
  flags.toggles['skip-permissions'] = true;
  flags.toggles.continue = true;
  flags.selects['output-format'] = 'stream-json';
  flags.values['max-turns'] = '12';
  flags.values['allowed-tools'] = 'Read,Grep';

  const argv = flagsOf({ cli: 'claude', prompt: 'x', flags });
  assert.deepEqual(argv, [
    ...prefixOf('claude'),
    '--permission-mode',
    'acceptEdits',
    '--dangerously-skip-permissions',
    // the panel's stream-json choice is the daemon's own, so it appears once
    '--continue',
    '--allowedTools',
    'Read,Grep',
    '--max-turns',
    '12',
  ]);
  assert.equal(argv.filter((piece) => piece === '--output-format').length, 1, argv.join(' '));
});

test('an empty value flag adds nothing', () => {
  const flags = defaultFlagState(cliProfile('claude'));
  flags.values['max-turns'] = '   ';
  assert.deepEqual(flagsOf({ cli: 'claude', prompt: 'x', flags }), [
    ...prefixOf('claude'),
    '--permission-mode',
    'acceptEdits',
  ]);
});

test('the same flag is never emitted twice', () => {
  const flags = defaultFlagState(cliProfile('codex'));
  flags.toggles.yolo = true; // --dangerously-bypass-approvals-and-sandbox
  flags.selects.sandbox = 'danger-full-access'; // the same thing, by sandbox name
  const argv = flagsOf({ cli: 'codex', prompt: 'x', flags });
  // One "no sandbox, no approvals" switch, whichever spelling it takes.
  const SPELLINGS = ['--sandbox', '--dangerously-bypass-approvals-and-sandbox', '--yolo'];
  const fullAccess = argv.filter((piece) => SPELLINGS.includes(piece)).length;
  assert.equal(fullAccess, 1, argv.join(' '));
  assert.ok(
    !argv.includes('--sandbox'),
    'the conflicting --sandbox choice is resolved, not stacked: ' + argv.join(' '),
  );
});

test('deep research wraps the prompt in a research brief', () => {
  const wrapped = wrapForDeepResearch('which auth library should we use?');
  assert.ok(wrapped.startsWith(DEEP_RESEARCH_BRIEF));
  assert.ok(wrapped.includes('which auth library should we use?'));
  assert.ok(wrapped.length > DEEP_RESEARCH_BRIEF.length + 30, 'the method rules are appended');
  assert.equal(wrapForDeepResearch('   '), '');

  const built = buildCliCommand({ cli: 'claude', prompt: 'why is this slow?', deepResearch: true });
  assert.equal(built.prompt, built.argv.at(-1));
  assert.ok(built.prompt.startsWith(DEEP_RESEARCH_BRIEF));
  assert.ok(built.explain.some((line) => line.includes('deep research')));
});

test('deep research overrides a conflicting flag instead of duplicating it', () => {
  // Codex defaults to workspace-write; research must force read-only, once.
  const codex = buildCliCommand({
    cli: 'codex',
    prompt: 'x',
    flags: defaultFlagState(cliProfile('codex')),
    deepResearch: true,
  });
  const sandboxes = codex.argv.filter((piece) => piece === '--sandbox');
  assert.equal(sandboxes.length, 1, codex.argv.join(' '));
  assert.equal(codex.argv[codex.argv.indexOf('--sandbox') + 1], 'read-only');

  // Same for Claude's permission mode.
  const claude = buildCliCommand({
    cli: 'claude',
    prompt: 'x',
    flags: defaultFlagState(cliProfile('claude')),
    deepResearch: true,
  });
  const modes = claude.argv.filter((piece) => piece === '--permission-mode');
  assert.equal(modes.length, 1, claude.argv.join(' '));
  assert.equal(claude.argv[claude.argv.indexOf('--permission-mode') + 1], 'plan');
});

test('every CLI gets research flags that make it read-only and thorough', () => {
  for (const id of IDS) {
    const built = buildCliCommand({ cli: id, prompt: 'x', deepResearch: true });
    const research = cliProfile(id).deepResearch.argv;
    assert.ok(research.length >= 0, `${id} may rely on the wrapped prompt alone`);
    for (const piece of research) {
      assert.ok(built.argv.includes(piece), `${id} includes ${piece}`);
    }
  }
});

test('permissionModeFor maps the panel onto the daemon’s one field', () => {
  // Deep research is always read-only.
  for (const id of IDS) {
    assert.equal(permissionModeFor({ cli: id, deepResearch: true }), 'plan', `${id} research`);
  }

  const claudeFlags = defaultFlagState(cliProfile('claude'));
  assert.equal(permissionModeFor({ cli: 'claude', flags: claudeFlags }), 'acceptEdits');
  claudeFlags.selects['permission-mode'] = 'plan';
  assert.equal(permissionModeFor({ cli: 'claude', flags: claudeFlags }), 'plan');
  claudeFlags.selects['permission-mode'] = 'default';
  claudeFlags.toggles['skip-permissions'] = true;
  assert.equal(permissionModeFor({ cli: 'claude', flags: claudeFlags }), 'bypassPermissions');
  claudeFlags.toggles['skip-permissions'] = false;
  assert.equal(permissionModeFor({ cli: 'claude', flags: claudeFlags }), '', 'ask each time');

  const codexFlags = defaultFlagState(cliProfile('codex'));
  assert.equal(permissionModeFor({ cli: 'codex', flags: codexFlags }), '', 'codex asks on request');
  codexFlags.selects.sandbox = 'read-only';
  assert.equal(permissionModeFor({ cli: 'codex', flags: codexFlags }), 'plan');
  codexFlags.selects.sandbox = 'danger-full-access';
  assert.equal(permissionModeFor({ cli: 'codex', flags: codexFlags }), 'bypassPermissions');
  codexFlags.toggles.yolo = true;
  assert.equal(permissionModeFor({ cli: 'codex', flags: codexFlags }), 'bypassPermissions');

  const cursorFlags = defaultFlagState(cliProfile('cursor'));
  assert.equal(permissionModeFor({ cli: 'cursor', flags: cursorFlags }), 'acceptEdits');
  cursorFlags.selects.mode = 'plan';
  assert.equal(permissionModeFor({ cli: 'cursor', flags: cursorFlags }), 'plan');
  cursorFlags.selects.mode = '';
  cursorFlags.toggles.force = true;
  assert.equal(permissionModeFor({ cli: 'cursor', flags: cursorFlags }), 'bypassPermissions');

  const opencodeFlags = defaultFlagState(cliProfile('opencode'));
  assert.equal(permissionModeFor({ cli: 'opencode', flags: opencodeFlags }), 'acceptEdits');
  opencodeFlags.selects.agent = 'plan';
  assert.equal(permissionModeFor({ cli: 'opencode', flags: opencodeFlags }), 'plan');
  opencodeFlags.selects.agent = 'build';
  opencodeFlags.toggles.auto = true;
  assert.equal(permissionModeFor({ cli: 'opencode', flags: opencodeFlags }), 'bypassPermissions');

  const copilotFlags = defaultFlagState(cliProfile('copilot'));
  assert.equal(permissionModeFor({ cli: 'copilot', flags: copilotFlags }), 'acceptEdits');
  copilotFlags.toggles['allow-all-tools'] = true;
  assert.equal(permissionModeFor({ cli: 'copilot', flags: copilotFlags }), 'bypassPermissions');

  // No flags at all still yields a safe default rather than undefined.
  assert.equal(permissionModeFor({ cli: 'claude' }), 'acceptEdits');
  assert.equal(permissionModeFor({ cli: 'unknown' }), 'acceptEdits');
});

test('summariseFlags says what the command will do in words', () => {
  assert.match(
    summariseFlags({ cli: 'claude', flags: NO_FLAGS }),
    /no extra flags/i,
    'nothing switched on is described as the CLI default',
  );

  // The defaults a fresh visitor gets are described, because they DO change
  // behaviour: Claude would otherwise stop and ask before every edit.
  assert.match(summariseFlags({ cli: 'claude' }), /permission mode/i);

  const summary = summariseFlags({
    cli: 'codex',
    flags: defaultFlagState(cliProfile('codex')),
    deepResearch: true,
  });
  assert.match(summary, /deep research/i);
  assert.match(summary, /sandbox/i);

  const risky = summariseFlags({ cli: 'cursor', flags: { toggles: { force: true }, selects: {}, values: {} } });
  assert.match(risky, /force|yolo/i);
});

test('risky flags are marked so the UI can warn about them', () => {
  const riskyByCli = {};
  for (const id of IDS) {
    riskyByCli[id] = cliProfile(id)
      .flags.filter((flag) => flag.risky)
      .map((flag) => flag.id);
  }
  assert.ok(riskyByCli.claude.includes('skip-permissions'), 'claude');
  assert.ok(riskyByCli.codex.includes('yolo'), 'codex');
  assert.ok(riskyByCli.cursor.includes('force'), 'cursor');
  assert.ok(riskyByCli.copilot.includes('allow-all-tools'), 'copilot');
});

test('every select flag has options and every value flag has a template', () => {
  for (const profile of cliProfileList()) {
    for (const flag of profile.flags) {
      if (flag.kind === 'select') {
        assert.ok(flag.options?.length, `${profile.id}/${flag.id} has options`);
        assert.ok(
          flag.options.every((option) => Array.isArray(option.argv)),
          `${profile.id}/${flag.id} options carry argv`,
        );
      }
      if (flag.kind === 'value') {
        assert.ok(flag.template?.length, `${profile.id}/${flag.id} has a template`);
        assert.ok(
          flag.template.some((piece) => piece.includes('{value}')),
          `${profile.id}/${flag.id} template has a {value} slot`,
        );
      }
      if (flag.kind === 'toggle') {
        assert.ok(Array.isArray(flag.argv), `${profile.id}/${flag.id} has argv`);
      }
      assert.ok(flag.label, `${profile.id}/${flag.id} has a label`);
    }
    assert.ok(profile.models.length, `${profile.id} offers model suggestions`);
    assert.ok(profile.docs.startsWith('https://'), `${profile.id} links its docs`);
    assert.ok(profile.login, `${profile.id} tells you how to log in`);
  }
});

test('the shell and powershell forms are built from the same argv', () => {
  const built = buildCliCommand({
    cli: 'cursor',
    prompt: 'do the thing',
    model: 'gpt-5',
    cwd: '/my repo',
    flags: NO_FLAGS,
  });
  assert.equal(built.shell, built.argv.map(quotePosix).join(' '));
  assert.equal(built.powershell, built.argv.map(quotePowerShell).join(' '));
  assert.ok(built.shell.includes("'/my repo'"), 'a path with a space is quoted');
});
