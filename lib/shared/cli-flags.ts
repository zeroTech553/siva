/**
 * lib/shared/cli-flags.ts — what each coding CLI actually accepts on the
 * command line, and how to build a runnable command from a plain-English prompt.
 *
 * This is the single source of truth behind three UI surfaces:
 *
 *   1. the agent selector on the landing page  (which CLI, which model)
 *   2. the flags panel                         (what that CLI can do)
 *   3. "Send a prompt"                         (build the argv, or dispatch it)
 *
 * It is deliberately framework-free and DOM-free so it can be imported from a
 * server route, a client component, or a unit test (`tests/cli-flags.test.mjs`).
 *
 * Flag names were verified against each vendor's CLI reference in September 2026:
 *   claude   https://docs.claude.com/en/docs/claude-code/cli-reference
 *   codex    `codex exec --help`
 *   cursor   https://cursor.com/docs/cli/reference/parameters
 *   opencode `opencode run --help`
 *   copilot  `copilot --help`
 *   agy      `agy --help`  (flags also detected at runtime by bridge/overlay/cli_launch.py)
 *
 * Model ids change often, so every profile exposes `modelFlag` and the UI always
 * offers a "Custom model id" escape hatch — a stale list must never block a run.
 */

// Type-only import: it is erased at runtime, so this file can be imported by a
// plain `node --test` unit test (tests/cli-flags.test.mjs) with no bundler.
/**
 * The six coding CLIs Forge can drive, and the names they answer to.
 *
 * This used to live in a second, smaller catalog (`lib/shared/cli-catalog.ts`)
 * that duplicated the name/logo/binary/login of every CLI in CLI_PROFILES
 * below. Two lists of the same six CLIs is a bug waiting to happen — the UI
 * read one and the command builder used the other — so the alias table moved
 * here, next to the profiles it belongs with.
 */
export type CliId = 'claude' | 'codex' | 'cursor' | 'opencode' | 'copilot' | 'antigravity'

/**
 * The names a CLI answers to: what the daemon calls it, what its binary is
 * called, and the slugs people type (bridge/overlay/cli_launch.py::_flavor_key
 * has the Python twin of this table, and tests/cli-parity.test.mjs checks the
 * two agree).
 */
const CLI_ALIASES: Record<string, CliId> = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  openai: 'codex',
  cursor: 'cursor',
  agent: 'cursor',
  'cursor-agent': 'cursor',
  opencode: 'opencode',
  'open-code': 'opencode',
  copilot: 'copilot',
  github: 'copilot',
  gh: 'copilot',
  'github-copilot': 'copilot',
  antigravity: 'antigravity',
  agy: 'antigravity',
}

/** Any spelling of a CLI name → its canonical id, or '' when unknown. */
export function normalizeCliId(value: string | undefined | null): CliId | '' {
  if (!value) return ''
  return CLI_ALIASES[value.trim().toLowerCase()] || ''
}

export type FlagKind = 'toggle' | 'select' | 'value'

export type FlagOption = {
  value: string
  label: string
  /** argv pieces appended when this option is chosen. */
  argv: string[]
}

export type CliFlag = {
  /** Stable key used in UI state and in localStorage. */
  id: string
  label: string
  /** One sentence for people who have never seen a terminal flag. */
  hint: string
  kind: FlagKind
  /** argv pieces for `kind: 'toggle'`. */
  argv?: string[]
  /** Choices for `kind: 'select'`. */
  options?: FlagOption[]
  /** For `kind: 'value'`: argv with `{value}` where the user's text goes. */
  template?: string[]
  /** For `kind: 'select'`: the option chosen before the visitor touches it. */
  defaultOption?: string
  placeholder?: string
  /** Shown with a warning chip — it hands the agent real power. */
  risky?: boolean
  /** Pre-selected in the flags panel. */
  recommended?: boolean
}

export type CliModel = {
  id: string
  label: string
  note?: string
}

export type CliProfile = {
  id: CliId
  name: string
  binary: string
  logo: string
  login: string
  docs: string
  /**
   * argv prefix for ONE non-interactive turn, prompt excluded.
   * `claude -p`, `codex exec`, `opencode run`, `agent -p`, `copilot -p`, `agy --print`.
   */
  head: string[]
  modelFlag: string
  models: CliModel[]
  flags: CliFlag[]
  /** Extra argv + prompt preamble used when "Deep research" is on. */
  deepResearch: {
    argv: string[]
    note: string
    /**
     * Flags to take OUT of the command for a research pass — including ones
     * Forge itself would otherwise add (copilot's --allow-all-tools, which has
     * to go when the pass is read-only).
     */
    drops?: string[]
  }
  /**
   * argv the daemon on the laptop adds by itself, whatever the visitor picked.
   * Shown in the preview (and explained) so the browser never displays a
   * command the machine will not actually run.
   *
   * Sources of truth, in this repo:
   *   claude   vendor/agent-remote/daemon/agentremoted/providers/claude.py::prepare
   *   codex    vendor/agent-remote/daemon/agentremoted/providers/codex.py::prepare
   *   the rest bridge/overlay/cli_launch.py::build_headless_cmd
   * tests/cli-parity.test.mjs re-derives these from the Python and fails if
   * they drift.
   */
  daemonAlways?: { argv: string[]; why: string }
  /**
   * Set when the CLI takes the prompt as an option *value* instead of a
   * trailing positional (GitHub Copilot's `-p "<prompt>"`). Without it the
   * preview would put the visitor's flags between `-p` and the prompt, and the
   * command it shows would not run if you pasted it into a terminal.
   */
  promptFlag?: string
  /**
   * Whether this CLI can continue an existing conversation headless. Copilot and
   * Antigravity have no resume flag, so a session id cannot be passed on: the
   * console starts a fresh session for them instead of implying the next prompt
   * lands in the same conversation.
   */
  canResume: boolean
}

/** The research brief prepended to a prompt in deep-research mode. */
export const DEEP_RESEARCH_BRIEF = [
  'DEEP RESEARCH PASS — investigate before you change anything.',
  '',
  'Question:',
].join('\n')

export const DEEP_RESEARCH_RULES = [
  '',
  '---',
  'Method for this pass:',
  '1. Restate the question and write down what a good answer must contain.',
  '2. Gather evidence first: read the relevant files (cite file:line) and search',
  '   the web for primary sources (cite the URL for every external claim).',
  '3. Consider at least two alternative approaches and their trade-offs.',
  '4. Report: findings, evidence table, recommendation, risks, and next steps.',
  '5. Do not edit files in this pass unless the question explicitly asks for it.',
].join('\n')

export const CLI_PROFILES: readonly CliProfile[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    binary: 'claude',
    logo: '/logos/claude-code.svg',
    login: 'claude login',
    docs: 'https://docs.claude.com/en/docs/claude-code/cli-reference',
    head: ['claude', '-p'],
    canResume: true,
    // claude.py::prepare always streams JSON so the phone can show the answer
    // as it arrives, and --verbose is required by claude for stream-json.
    daemonAlways: {
      argv: ['--output-format', 'stream-json', '--verbose'],
      why: 'Forge streams the answer to your phone as the agent writes it',
    },
    modelFlag: '--model',
    models: [
      { id: 'sonnet', label: 'Sonnet', note: 'balanced default' },
      { id: 'opus', label: 'Opus', note: 'hardest tasks' },
      { id: 'haiku', label: 'Haiku', note: 'fast and cheap' },
    ],
    flags: [
      {
        id: 'permission-mode',
        label: 'Permission mode',
        hint: 'How much the agent may do without asking you first.',
        kind: 'select',
        recommended: true,
        defaultOption: 'acceptEdits',
        options: [
          { value: 'default', label: 'Ask each time', argv: [] },
          { value: 'acceptEdits', label: 'Accept file edits', argv: ['--permission-mode', 'acceptEdits'] },
          { value: 'plan', label: 'Plan only (read-only)', argv: ['--permission-mode', 'plan'] },
          {
            value: 'bypassPermissions',
            label: 'Bypass all prompts',
            argv: ['--permission-mode', 'bypassPermissions'],
          },
        ],
      },
      {
        id: 'skip-permissions',
        label: 'Skip permission prompts',
        hint: 'Runs every tool without asking. Only inside a machine you can afford to lose.',
        kind: 'toggle',
        argv: ['--dangerously-skip-permissions'],
        risky: true,
      },
      {
        id: 'output-format',
        label: 'Output format',
        hint: 'How the answer is printed: plain text, one JSON object, or streamed JSON events.',
        kind: 'select',
        options: [
          { value: 'text', label: 'Text (default)', argv: [] },
          { value: 'json', label: 'JSON', argv: ['--output-format', 'json'] },
          {
            value: 'stream-json',
            label: 'Stream JSON',
            argv: ['--output-format', 'stream-json', '--verbose'],
          },
        ],
      },
      {
        id: 'continue',
        label: 'Continue last session',
        hint: 'Keeps the previous conversation instead of starting a new one.',
        kind: 'toggle',
        argv: ['--continue'],
      },
      {
        id: 'allowed-tools',
        label: 'Allowed tools',
        hint: 'Comma-separated allowlist, e.g. Read,Edit,Bash(git:*).',
        kind: 'value',
        template: ['--allowedTools', '{value}'],
        placeholder: 'Read,Edit,Bash(git:*)',
      },
      {
        id: 'add-dir',
        label: 'Extra directory',
        hint: 'Gives the agent access to one more folder outside the project.',
        kind: 'value',
        template: ['--add-dir', '{value}'],
        placeholder: '../shared-lib',
      },
      {
        id: 'max-turns',
        label: 'Max turns',
        hint: 'Stops the agent after this many autonomous turns.',
        kind: 'value',
        template: ['--max-turns', '{value}'],
        placeholder: '12',
      },
      {
        id: 'system-prompt',
        label: 'Append system prompt',
        hint: 'Extra standing instructions for this one run.',
        kind: 'value',
        template: ['--append-system-prompt', '{value}'],
        placeholder: 'Answer in bullet points.',
      },
    ],
    deepResearch: {
      argv: ['--permission-mode', 'plan', '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch'],
      note: 'Plan mode is read-only, and only research tools are allowed.',
    },
  },

  {
    id: 'codex',
    name: 'Codex',
    binary: 'codex',
    logo: '/logos/codex.svg',
    login: 'codex login',
    docs: 'https://developers.openai.com/codex/cli',
    head: ['codex', 'exec'],
    canResume: true,
    // codex.py::prepare always asks for JSON events, and skips the git-repo
    // check because phone-driven turns often run in folders that are not repos.
    daemonAlways: {
      argv: ['--json', '--skip-git-repo-check'],
      why: 'Forge reads codex JSON events, and phone projects are often not git repos',
    },
    modelFlag: '--model',
    models: [
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', note: 'coding default' },
      { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', note: 'longest context' },
      { id: 'gpt-5.1', label: 'GPT-5.1', note: 'general reasoning' },
    ],
    flags: [
      {
        id: 'sandbox',
        label: 'Sandbox',
        hint: 'What the generated commands may touch on disk.',
        kind: 'select',
        recommended: true,
        defaultOption: 'workspace-write',
        options: [
          { value: 'read-only', label: 'Read only', argv: ['--sandbox', 'read-only'] },
          { value: 'workspace-write', label: 'Write in workspace', argv: ['--sandbox', 'workspace-write'] },
          {
            // codex.py::prepare passes the bypass flag for full access, not
            // `--sandbox danger-full-access`, so that is what the preview shows.
            value: 'danger-full-access',
            label: 'Full access',
            argv: ['--dangerously-bypass-approvals-and-sandbox'],
          },
        ],
      },
      {
        id: 'ask-for-approval',
        label: 'Ask for approval',
        hint: 'When Codex pauses and asks a human before acting.',
        kind: 'select',
        options: [
          { value: 'untrusted', label: 'Unless trusted', argv: ['--ask-for-approval', 'untrusted'] },
          { value: 'on-request', label: 'On request', argv: ['--ask-for-approval', 'on-request'] },
          { value: 'never', label: 'Never', argv: ['--ask-for-approval', 'never'] },
        ],
      },
      {
        id: 'json',
        label: 'JSON events',
        hint: 'Prints newline-delimited JSON events for scripts.',
        kind: 'toggle',
        argv: ['--json'],
      },
      {
        id: 'search',
        label: 'Live web search',
        hint: 'Lets the run search the web while it works.',
        kind: 'toggle',
        argv: ['--search'],
      },
      {
        id: 'cd',
        label: 'Working directory',
        hint: 'Runs in this folder instead of the current one.',
        kind: 'value',
        // -C is the form codex.py::prepare uses, so the preview matches.
        template: ['-C', '{value}'],
        placeholder: '~/projects/app',
      },
      {
        id: 'output-last-message',
        label: 'Write answer to file',
        hint: 'Saves the final message to a path you choose.',
        kind: 'value',
        template: ['--output-last-message', '{value}'],
        placeholder: 'answer.md',
      },
      {
        id: 'skip-git-check',
        label: 'Skip git repo check',
        hint: 'Allows a run outside a git repository.',
        kind: 'toggle',
        argv: ['--skip-git-repo-check'],
      },
      {
        id: 'yolo',
        label: 'No sandbox, no approvals',
        hint: 'Disables every guardrail. Disposable containers only.',
        kind: 'toggle',
        argv: ['--yolo'],
        risky: true,
      },
    ],
    deepResearch: {
      argv: ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--search'],
      note: 'Read-only sandbox with live web search on.',
    },
  },

  {
    id: 'cursor',
    name: 'Cursor',
    binary: 'agent',
    logo: '/logos/cursor.svg',
    login: 'agent login',
    docs: 'https://cursor.com/docs/cli/reference/parameters',
    head: ['agent', '-p'],
    canResume: true,
    // cli_launch.build_headless_cmd(flavor='cursor'): stream-json when the CLI
    // advertises it, and --force so a non-interactive turn never stalls.
    daemonAlways: {
      argv: ['--output-format', 'stream-json', '--force'],
      why: 'Forge streams the answer and never lets the agent wait on a prompt',
    },
    modelFlag: '--model',
    models: [
      { id: 'auto', label: 'Auto', note: 'Cursor picks' },
      { id: 'composer-1', label: 'Composer 1', note: 'Cursor agent model' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    ],
    flags: [
      {
        id: 'mode',
        label: 'Mode',
        hint: 'Agent edits files, Plan proposes, Ask only reads.',
        kind: 'select',
        recommended: true,
        options: [
          { value: 'agent', label: 'Agent (default)', argv: [] },
          { value: 'plan', label: 'Plan', argv: ['--mode', 'plan'] },
          { value: 'ask', label: 'Ask (read only)', argv: ['--mode', 'ask'] },
        ],
      },
      {
        id: 'force',
        label: 'Force (allow writes)',
        hint: 'Print mode needs this before the agent will modify files.',
        kind: 'toggle',
        argv: ['--force'],
        risky: true,
      },
      {
        id: 'output-format',
        label: 'Output format',
        hint: 'Text, one JSON object, or streamed JSON messages.',
        kind: 'select',
        options: [
          { value: 'text', label: 'Text (default)', argv: [] },
          { value: 'json', label: 'JSON', argv: ['--output-format', 'json'] },
          { value: 'stream-json', label: 'Stream JSON', argv: ['--output-format', 'stream-json'] },
        ],
      },
      {
        id: 'stream-partial',
        label: 'Stream partial output',
        hint: 'Streams text deltas inside stream-json mode.',
        kind: 'toggle',
        argv: ['--stream-partial-output'],
      },
      {
        id: 'sandbox',
        label: 'Sandbox',
        hint: 'Runs the local agent inside Cursor\'s sandbox.',
        kind: 'select',
        options: [
          { value: 'enabled', label: 'Enabled', argv: ['--sandbox', 'enabled'] },
          { value: 'disabled', label: 'Disabled', argv: ['--sandbox', 'disabled'] },
        ],
      },
      {
        id: 'workspace',
        label: 'Workspace',
        hint: 'Folder the agent works in.',
        kind: 'value',
        template: ['--workspace', '{value}'],
        placeholder: '~/projects/app',
      },
      {
        id: 'continue',
        label: 'Continue last chat',
        hint: 'Resumes the previous session.',
        kind: 'toggle',
        argv: ['--continue'],
      },
      {
        id: 'worktree',
        label: 'New git worktree',
        hint: 'Runs in an isolated worktree instead of your checkout.',
        kind: 'toggle',
        argv: ['--worktree'],
      },
      {
        id: 'trust',
        label: 'Trust workspace + MCPs',
        hint: 'Skips the trust and MCP approval prompts (headless only).',
        kind: 'toggle',
        argv: ['--trust', '--approve-mcps'],
        risky: true,
      },
    ],
    deepResearch: {
      argv: ['--mode', 'plan', '--sandbox', 'enabled'],
      note: 'Plan mode proposes without editing, inside the sandbox.',
    },
  },

  {
    id: 'opencode',
    name: 'OpenCode',
    binary: 'opencode',
    logo: '/logos/opencode.svg',
    login: 'opencode auth login',
    docs: 'https://opencode.ai/docs/cli',
    head: ['opencode', 'run'],
    canResume: true,
    // cli_launch._build_opencode_cmd: JSON events, and --auto so a headless
    // turn approves what it was not explicitly told to deny.
    daemonAlways: {
      argv: ['--format', 'json', '--auto'],
      why: 'Forge reads JSON events and auto-approves so the turn cannot stall',
    },
    modelFlag: '--model',
    models: [
      { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro' },
    ],
    flags: [
      {
        id: 'agent',
        label: 'Agent',
        hint: 'build edits files, plan only proposes.',
        kind: 'select',
        recommended: true,
        options: [
          { value: 'build', label: 'Build (default)', argv: [] },
          { value: 'plan', label: 'Plan', argv: ['--agent', 'plan'] },
        ],
      },
      {
        id: 'format',
        label: 'Output format',
        hint: 'Formatted text for humans, raw JSON events for scripts.',
        kind: 'select',
        options: [
          { value: 'default', label: 'Text (default)', argv: [] },
          { value: 'json', label: 'JSON events', argv: ['--format', 'json'] },
        ],
      },
      {
        id: 'auto',
        label: 'Auto-approve',
        hint: 'Approves permission requests that are not explicitly denied.',
        kind: 'toggle',
        argv: ['--auto'],
        risky: true,
      },
      {
        id: 'continue',
        label: 'Continue last session',
        hint: 'Resumes the most recent session.',
        kind: 'toggle',
        argv: ['--continue'],
      },
      {
        id: 'session',
        label: 'Session id',
        hint: 'Resumes one specific session.',
        kind: 'value',
        template: ['--session', '{value}'],
        placeholder: 'ses_abc123',
      },
      {
        id: 'file',
        label: 'Attach file',
        hint: 'Adds a file to the message.',
        kind: 'value',
        template: ['--file', '{value}'],
        placeholder: 'src/app.ts',
      },
      {
        id: 'title',
        label: 'Session title',
        hint: 'Names the session so you can find it later.',
        kind: 'value',
        template: ['--title', '{value}'],
        placeholder: 'auth refactor',
      },
      {
        id: 'thinking',
        label: 'Show thinking',
        hint: 'Prints the model reasoning blocks.',
        kind: 'toggle',
        argv: ['--thinking'],
      },
      {
        id: 'share',
        label: 'Share session',
        hint: 'Publishes a shareable link for this session.',
        kind: 'toggle',
        argv: ['--share'],
      },
    ],
    deepResearch: {
      argv: ['--agent', 'plan', '--thinking'],
      note: 'The plan agent cannot write files, and thinking blocks are shown.',
    },
  },

  {
    id: 'copilot',
    name: 'GitHub Copilot',
    binary: 'copilot',
    logo: '/logos/github.svg',
    login: 'copilot login',
    docs: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
    head: ['copilot'],
    canResume: false,
    // Copilot's -p takes the prompt as its value, so it has to sit next to it.
    promptFlag: '-p',
    // cli_launch._build_copilot_cmd: every tool allowed (the phone answers the
    // permission prompts instead), quiet banner, JSON out.
    daemonAlways: {
      argv: ['--allow-all-tools', '--silent', '--output-format', 'json'],
      why: 'Forge reads JSON events; permission prompts come to your phone instead',
    },
    modelFlag: '--model',
    models: [
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', note: 'CLI default' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
    flags: [
      {
        id: 'allow-tool',
        label: 'Allow tool',
        hint: 'Narrow allowlist, e.g. shell(git status) or read.',
        kind: 'value',
        template: ['--allow-tool', '{value}'],
        placeholder: 'shell(git status)',
        recommended: true,
      },
      {
        id: 'deny-tool',
        label: 'Deny tool',
        hint: 'Always refused, and denial wins over allow.',
        kind: 'value',
        template: ['--deny-tool', '{value}'],
        placeholder: 'shell(git push)',
      },
      {
        id: 'output-format',
        label: 'Output format',
        hint: 'JSONL for automation, text for reading.',
        kind: 'select',
        options: [
          { value: 'text', label: 'Text (default)', argv: [] },
          { value: 'json', label: 'JSON', argv: ['--output-format', 'json'] },
        ],
      },
      {
        id: 'silent',
        label: 'Silent',
        hint: 'Drops session stats and logs so the output is clean to parse.',
        kind: 'toggle',
        argv: ['--silent'],
      },
      {
        id: 'no-ask-user',
        label: 'Never ask a question',
        hint: 'Needed when a run must not wait for a human.',
        kind: 'toggle',
        argv: ['--no-ask-user'],
      },
      {
        id: 'allow-all-urls',
        label: 'Allow all URLs',
        hint: 'Lets the agent fetch any URL.',
        kind: 'toggle',
        argv: ['--allow-all-urls'],
        risky: true,
      },
      {
        id: 'allow-all-tools',
        label: 'Allow all tools',
        hint: 'Approves every tool call. The agent then has your own rights.',
        kind: 'toggle',
        argv: ['--allow-all-tools'],
        risky: true,
      },
      {
        id: 'share',
        label: 'Export transcript',
        hint: 'Writes the session transcript to a markdown file.',
        kind: 'value',
        template: ['--share', '{value}'],
        placeholder: 'report.md',
      },
    ],
    deepResearch: {
      argv: ['--deny-tool', 'write', '--allow-all-urls', '--no-ask-user'],
      // Forge adds --allow-all-tools to every copilot run so the phone can
      // answer its prompts; a read-only pass has to give that up.
      drops: ['--allow-all-tools'],
      note: 'Writes are denied and URL access is allowed for source gathering.',
    },
  },

  {
    id: 'antigravity',
    name: 'Antigravity',
    binary: 'agy',
    logo: '/logos/antigravity.svg',
    login: 'agy',
    docs: 'https://antigravity.google/docs/cli',
    head: ['agy', '--print'],
    canResume: false,
    // cli_launch.build_headless_cmd(flavor='agy'): streamed JSON events.
    daemonAlways: {
      argv: ['--output-format', 'stream-json'],
      why: 'Forge streams the answer to your phone as the agent writes it',
    },
    modelFlag: '--model',
    models: [
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', note: 'fast' },
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    ],
    flags: [
      {
        id: 'output-format',
        label: 'Output format',
        hint: 'Streamed JSON events, or plain text.',
        kind: 'select',
        options: [
          { value: 'text', label: 'Text (default)', argv: [] },
          { value: 'stream-json', label: 'Stream JSON', argv: ['--output-format', 'stream-json'] },
        ],
      },
      {
        id: 'workspace',
        label: 'Workspace',
        hint: 'Folder the agent works in.',
        kind: 'value',
        template: ['--workspace', '{value}'],
        placeholder: '~/projects/app',
      },
    ],
    deepResearch: {
      argv: [],
      note: 'Antigravity has no read-only flag yet, so the research brief itself forbids edits.',
    },
  },
]

/**
 * Resolve a profile from anything the caller might have: a catalog id
 * ('claude'), a binary name ('agy') or a display name ('Claude Code').
 * Unknown values fall back to the first profile rather than throwing — a stale
 * localStorage entry must not break the page.
 */
export function cliProfile(id: string | undefined | null): CliProfile {
  // Aliases first: the daemon's provider name and the CLI's binary are the two
  // spellings that arrive from the wire, and they must resolve exactly.
  const canonical = normalizeCliId(id)
  if (canonical) {
    const found = CLI_PROFILES.find((profile) => profile.id === canonical)
    if (found) return found
  }
  // Then the fuzzy forms a human might type ("Claude Code", "claude-code").
  const needle = String(id ?? '')
    .trim()
    .toLowerCase()
  if (!needle) return CLI_PROFILES[0]!
  return (
    CLI_PROFILES.find(
      (profile) =>
        profile.binary === needle ||
        profile.name.toLowerCase() === needle ||
        profile.name.toLowerCase().replace(/\s+/g, '') === needle.replace(/[\s-]+/g, ''),
    ) ?? CLI_PROFILES[0]!
  )
}

export function cliProfileList(): readonly CliProfile[] {
  return CLI_PROFILES
}

/** Flags that start switched on for a CLI. */
/** The flag state a CLI starts with: recommended toggles on, declared defaults selected. */
export function defaultFlagState(profile: CliProfile): FlagState {
  const state: FlagState = { toggles: {}, selects: {}, values: {} }
  for (const flag of profile.flags) {
    if (flag.kind === 'select') state.selects[flag.id] = flag.defaultOption ?? ''
    if (flag.kind === 'value') state.values[flag.id] = ''
    if (flag.kind === 'toggle' && flag.recommended) state.toggles[flag.id] = true
  }
  return state
}

export type FlagState = {
  toggles: Record<string, boolean>
  selects: Record<string, string>
  values: Record<string, string>
}

export type PromptBuild = {
  cli: string
  prompt: string
  model?: string
  flags?: FlagState
  deepResearch?: boolean
  cwd?: string
}

export type BuiltCommand = {
  /** argv exactly as it would be exec'd — no shell parsing involved. */
  argv: string[]
  /** The same command quoted for a POSIX shell (macOS / Linux). */
  shell: string
  /** The same command quoted for Windows PowerShell. */
  powershell: string
  /** One plain-English line per flag included, for people new to terminals. */
  explain: string[]
  /** The prompt text after deep-research wrapping (may equal the input). */
  prompt: string
}

/**
 * Flags that hand a run full freedom. A read-only pass — deep research, or the
 * permission mode "plan" — must never carry one, whichever panel switch put it
 * there. The laptop drops them too (cli_launch.apply_codex_permission for codex,
 * _build_opencode_cmd for opencode, --permission-mode plan for claude), so the
 * preview and the machine agree on how much rope the run has.
 */
const FULL_ACCESS_FLAGS = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--force',
  '--auto',
  '--allow-all-tools',
]

export function buildCliCommand(build: PromptBuild): BuiltCommand {
  const profile = cliProfile(build.cli)
  const flags = build.flags ?? defaultFlagState(profile)
  const prompt = build.deepResearch ? wrapForDeepResearch(build.prompt) : build.prompt.trim()

  const argv: string[] = [...profile.head]
  const explain: string[] = []
  const seen = new Set<string>()

  const push = (pieces: string[], why: string) => {
    const key = pieces.join(' ')
    if (!pieces.length || seen.has(key)) return
    seen.add(key)
    argv.push(...pieces)
    if (why) explain.push(`${key}  →  ${why}`)
  }

  if (build.model) push([profile.modelFlag, build.model], `use the ${build.model} model`)

  for (const flag of profile.flags) {
    if (flag.kind === 'toggle') {
      if (flags.toggles[flag.id]) push(flag.argv ?? [], flag.hint)
      continue
    }
    if (flag.kind === 'select') {
      const chosen = flags.selects[flag.id]
      const option = flag.options?.find((item) => item.value === chosen)
      if (option?.argv?.length) push(option.argv, `${flag.label}: ${option.label}`)
      continue
    }
    const value = (flags.values[flag.id] ?? '').trim()
    if (!value || !flag.template) continue
    push(flag.template.map((piece) => piece.replace('{value}', value)), flag.hint)
  }

  if (build.deepResearch) {
    // A deep-research flag wins over the same flag chosen in the panel, so the
    // command can never end up with `--sandbox workspace-write --sandbox read-only`.
    const overriding = new Set([
      ...profile.deepResearch.argv.filter((piece) => piece.startsWith('-')),
      ...(profile.deepResearch.drops ?? []),
    ])
    for (let index = argv.length - 1; index >= 0; index -= 1) {
      const piece = argv[index]!
      if (!overriding.has(piece)) continue
      // Drop the flag and the value that follows it (`--sandbox read-only`).
      const takesValue = argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('-')
      argv.splice(index, takesValue ? 2 : 1)
    }
    push(profile.deepResearch.argv, `deep research: ${profile.deepResearch.note}`)
  }

  // Two switches that mean the same thing (`--yolo` and `--sandbox
  // danger-full-access` are the same promise) leave only the first in argv: a
  // command carrying both looks like it was never read, and the CLIs differ on
  // which one wins.
  let sawFullAccess = false
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const piece = argv[index]!
    if (!FULL_ACCESS_FLAGS.includes(piece)) continue
    if (!sawFullAccess) {
      sawFullAccess = true
      continue
    }
    argv.splice(index, 1)
    for (let line = explain.length - 1; line >= 0; line -= 1) {
      const key = explain[line]!.split('  →  ')[0]!
      if (key === piece || key.startsWith(`${piece} `)) explain.splice(line, 1)
    }
  }

  // A read-only pass strips every "let it do anything" flag, whatever switch
  // in the panel turned it on — deep research that can edit is not research.
  const readOnly =
    Boolean(build.deepResearch) ||
    permissionModeFor({ cli: build.cli, flags, deepResearch: build.deepResearch }) === 'plan'
  if (readOnly) {
    for (let index = argv.length - 1; index >= 0; index -= 1) {
      const piece = argv[index]!
      if (!FULL_ACCESS_FLAGS.includes(piece)) continue
      argv.splice(index, 1)
      for (let line = explain.length - 1; line >= 0; line -= 1) {
        const key = explain[line]!.split('  →  ')[0]!
        if (key === piece || key.startsWith(`${piece} `)) explain.splice(line, 1)
      }
    }
  }

  // The daemon's own flags go in last and win, exactly like deep research:
  // they are what lets the answer stream back to the phone, so a conflicting
  // choice in the panel is dropped (and its explanation with it) rather than
  // printed twice.
  const daemon = profile.daemonAlways
  const daemonArgv = (daemon?.argv ?? []).filter((piece) => !readOnly || !FULL_ACCESS_FLAGS.includes(piece))
  if (daemon && daemonArgv.length) {
    const overriding = new Set(daemonArgv.filter((piece) => piece.startsWith('-')))
    for (let index = argv.length - 1; index >= 0; index -= 1) {
      const piece = argv[index]!
      if (!overriding.has(piece)) continue
      const takesValue = argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('-')
      argv.splice(index, takesValue ? 2 : 1)
      for (let line = explain.length - 1; line >= 0; line -= 1) {
        const key = explain[line]!.split('  →  ')[0]!
        if (key === piece || key.startsWith(`${piece} `)) explain.splice(line, 1)
      }
    }
    argv.splice(profile.head.length, 0, ...daemonArgv)
    explain.unshift(`${daemonArgv.join(' ')}  →  ${daemon.why}`)
  }

  // A CLI with no directory flag runs with the process started in that
  // directory, so that is what the preview shows.
  const cwdPieces = build.cwd ? cwdArgv(profile, build.cwd) : []
  if (cwdPieces.length) push(cwdPieces, `work inside ${build.cwd}`)
  const cdInto = build.cwd && !cwdPieces.length ? build.cwd : ''
  if (cdInto) explain.push(`cd ${cdInto}  →  work inside ${cdInto}`)

  if (profile.promptFlag) argv.push(profile.promptFlag, prompt)
  else argv.push(prompt)

  const command = argv.map((piece) => quotePosix(piece)).join(' ')
  const psCommand = argv.map((piece) => quotePowerShell(piece)).join(' ')

  return {
    argv,
    shell: cdInto ? `cd ${quotePosix(cdInto)} && ${command}` : command,
    powershell: cdInto ? `cd ${quotePowerShell(cdInto)}; ${psCommand}` : psCommand,
    explain,
    prompt,
  }
}

/**
 * The flag that points a CLI at a working directory — or nothing, when the CLI
 * has no such flag and the daemon simply starts the process in that directory
 * (claude, copilot). In that case buildCliCommand shows `cd <dir> && …`, which
 * is what actually happens and pastes correctly into a terminal.
 */
function cwdArgv(profile: CliProfile, cwd: string): string[] {
  if (profile.id === 'codex') return ['-C', cwd]
  if (profile.id === 'cursor') return ['--workspace', cwd]
  if (profile.id === 'opencode') return ['--dir', cwd]
  if (profile.id === 'antigravity') return ['--workspace', cwd]
  return []
}

export function wrapForDeepResearch(prompt: string): string {
  const question = prompt.trim()
  if (!question) return ''
  return `${DEEP_RESEARCH_BRIEF}\n${question}\n${DEEP_RESEARCH_RULES}`
}

/** Single-quote for POSIX shells; embedded quotes become '\'' sequences. */
export function quotePosix(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Double-quote for PowerShell; embedded quotes and $ are escaped. */
export function quotePowerShell(value: string): string {
  if (value === '') return '""'
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `"${value.replace(/(["$`])/g, '`$1')}"`
}

/* ------------------------------------------------------------------ *
 * Bridging the flags panel to the daemon
 * ------------------------------------------------------------------ */

/**
 * The daemon on the laptop launches each CLI with a `permission_mode`
 * (lib/shared/daemon.ts → bridge/overlay/cli_launch.py). This maps the flags a
 * visitor picked in the browser onto that one field, so the UI and the machine
 * agree on how much freedom the agent gets:
 *
 *   deep research            → plan        (read-only investigation)
 *   a read-only/plan flag    → plan
 *   an "all power" flag      → bypassPermissions
 *   anything else            → acceptEdits (edits allowed, prompts still asked)
 */
export type PermissionModeId = 'bypassPermissions' | 'acceptEdits' | 'plan' | ''

export function permissionModeFor(build: {
  cli: string
  flags?: FlagState
  deepResearch?: boolean
}): PermissionModeId {
  if (build.deepResearch) return 'plan'
  const profile = cliProfile(build.cli)
  const flags = build.flags ?? defaultFlagState(profile)
  const on = (id: string) => Boolean(flags.toggles[id])
  const selected = (id: string) => flags.selects[id] ?? ''

  switch (profile.id) {
    case 'claude': {
      const mode = selected('permission-mode')
      if (mode === 'plan' || mode === 'bypassPermissions') return mode
      if (on('skip-permissions')) return 'bypassPermissions'
      return mode === 'default' ? '' : 'acceptEdits'
    }
    case 'codex':
      if (on('yolo') || selected('sandbox') === 'danger-full-access') return 'bypassPermissions'
      if (selected('sandbox') === 'read-only') return 'plan'
      return selected('ask-for-approval') === 'never' ? 'acceptEdits' : ''
    case 'cursor':
      if (['plan', 'ask'].includes(selected('mode'))) return 'plan'
      if (on('force') || on('trust')) return 'bypassPermissions'
      return 'acceptEdits'
    case 'opencode':
      if (selected('agent') === 'plan') return 'plan'
      if (on('auto')) return 'bypassPermissions'
      return 'acceptEdits'
    case 'copilot':
      if (on('allow-all-tools')) return 'bypassPermissions'
      if ((flags.values['deny-tool'] ?? '').includes('write')) return 'plan'
      return 'acceptEdits'
    default:
      return 'acceptEdits'
  }
}

/** One-line summary of what the current flags mean, for people not reading argv. */
export function summariseFlags(build: {
  cli: string
  flags?: FlagState
  deepResearch?: boolean
}): string {
  const profile = cliProfile(build.cli)
  const flags = build.flags ?? defaultFlagState(profile)
  const parts: string[] = []
  if (build.deepResearch) parts.push('deep research (read-only, evidence first)')
  for (const flag of profile.flags) {
    if (flag.kind === 'toggle' && flags.toggles[flag.id]) parts.push(flag.label.toLowerCase())
    if (flag.kind === 'select') {
      const chosen = flag.options?.find((option) => option.value === (flags.selects[flag.id] ?? ''))
      if (chosen?.argv?.length) parts.push(`${flag.label.toLowerCase()}: ${chosen.label.toLowerCase()}`)
    }
    if (flag.kind === 'value' && (flags.values[flag.id] ?? '').trim()) parts.push(flag.label.toLowerCase())
  }
  if (!parts.length) return 'No extra flags — the CLI runs with its own defaults and asks before acting.'
  return parts.join(' · ')
}
