'use client'

/**
 * command-preview.tsx — the command the flags build, in a form you can run.
 *
 * Three views of the same thing, because "runnable" depends on who is reading:
 *
 *   Shell        POSIX quoting, for macOS/Linux terminals
 *   PowerShell   backtick quoting, for Windows
 *   argv         the exact array Forge exec's on the laptop (what the bridge
 *                actually runs — see bridge/overlay/cli_launch.py)
 *
 * The `explain` lines come from lib/shared/cli-flags.ts: one plain sentence per
 * flag, so the command is not a wall of mystery text. The prompt itself is the
 * placeholder `<your prompt>` until the visitor types one.
 */

import { useState } from 'react'

import { OsButton } from '@/components/computer/os/os-ui'
import { playDing } from '@/lib/client/zero-sound'
import type { BuiltCommand } from '@/lib/shared/cli-flags'

type View = 'shell' | 'powershell' | 'argv'

const VIEWS: View[] = ['shell', 'powershell', 'argv']

export function CommandPreview({
  command,
  title = 'The command this builds',
}: {
  command: BuiltCommand
  title?: string
}) {
  const [view, setView] = useState<View>('shell')
  const [copied, setCopied] = useState(false)

  const text =
    view === 'shell'
      ? command.shell
      : view === 'powershell'
        ? command.powershell
        : command.argv.map((piece) => JSON.stringify(piece)).join(',\n')

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    setCopied(true)
    void playDing()
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="cli-command">
      <div className="cli-command-head">
        <span className="cli-field-label">{title}</span>
        <span className="cli-command-tabs" role="tablist" aria-label="Command format">
          {VIEWS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              className={`cli-tab${view === option ? ' cli-tab-on' : ''}`}
              onClick={() => setView(option)}
            >
              {option}
            </button>
          ))}
        </span>
        <OsButton onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy'}</OsButton>
      </div>

      <pre className="cli-command-body">{text}</pre>

      {command.explain.length ? (
        <ul className="cli-explain">
          {command.explain.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
