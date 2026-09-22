export type CliId = 'claude' | 'codex' | 'cursor' | 'opencode' | 'copilot' | 'antigravity'

export type CliOption = {
  id: CliId
  name: string
  logo: string
  binary: string
  login: string
}

export const CLI_CATALOG: readonly CliOption[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    logo: '/logos/claude-code.svg',
    binary: 'claude',
    login: 'claude login',
  },
  {
    id: 'codex',
    name: 'Codex',
    logo: '/logos/codex.svg',
    binary: 'codex',
    login: 'codex login',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    logo: '/logos/cursor.svg',
    binary: 'agent',
    login: 'agent login',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    logo: '/logos/opencode.svg',
    binary: 'opencode',
    login: 'opencode auth login',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    logo: '/logos/github.svg',
    binary: 'copilot',
    login: 'copilot login',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    logo: '/logos/antigravity.svg',
    binary: 'agy',
    login: 'agy',
  },
]

const ALIASES: Record<string, CliId> = {
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

export function normalizeCliId(value: string | undefined | null): CliId | '' {
  if (!value) return ''
  return ALIASES[value.trim().toLowerCase()] || ''
}

export function cliOption(id: string | undefined | null) {
  const normalized = normalizeCliId(id)
  return CLI_CATALOG.find((item) => item.id === normalized) || CLI_CATALOG[0]!
}
