'use client'

/**
 * prompt-composer.tsx — "type it in English, it runs on your laptop".
 *
 * One component, used in two places so the two can never drift:
 *   • the landing page's last section   (components/landing/prompt-section.tsx)
 *   • the Prompt window inside Zero OS  (components/console/console-os.tsx)
 *
 * What it does for real:
 *   1. builds the exact argv for the chosen CLI, model and flags
 *      (lib/shared/cli-flags.ts — the same shapes bridge/overlay/cli_launch.py
 *      launches on the laptop);
 *   2. starts a job on the laptop through the daemon (useAgentConsole);
 *   3. renders the event stream that comes back, including permission prompts.
 *
 * `agent` may be passed in from outside (the console owns one instance and
 * shares it with the Agent window, so the laptop is never polled twice). When
 * it is not passed, this component owns one; the internal instance is inert
 * unless a machine is paired.
 */

import { useMemo, useState } from 'react'

import { ConsoleTranscript } from '@/components/agent/console-transcript'
import { useAgentConsole, type AgentConsole } from '@/components/agent/use-agent-console'
import { CliPicker } from '@/components/cli/cli-picker'
import { CommandPreview } from '@/components/cli/command-preview'
import { FlagPanel } from '@/components/cli/flag-panel'
import { ModelPicker } from '@/components/cli/model-picker'
import { OsButton, OsNote, OsPill } from '@/components/computer/os/os-ui'
import { commandForPrompt, type CliSelection } from '@/lib/client/use-cli-selection'
import type { PairedMachine } from '@/lib/client/use-paired-machine'
import { permissionModeFor, summariseFlags } from '@/lib/shared/cli-flags'

const EXAMPLES = [
  'Explain what this repository does and where I should start reading.',
  'Find every TODO and FIXME, then fix the ones that are one-liners.',
  'Add tests for lib/shared and make them pass.',
  'Turn the last 20 git commits into release notes.',
  'Why does the build fail on a clean checkout? Fix the root cause.',
]

export function PromptComposer({
  paired,
  selection,
  onNeedMachine,
  agent,
  compact = false,
}: {
  paired: PairedMachine
  selection: CliSelection
  /** Called instead of dispatching when there is no usable laptop. */
  onNeedMachine: () => void
  /** Share the console's agent instance (one poller, not two). */
  agent?: AgentConsole
  /** Tighter layout for a CRT window. */
  compact?: boolean
}) {
  const own = useAgentConsole({
    deviceId: agent ? '' : paired.deviceId,
    phoneSecret: agent ? '' : paired.phoneSecret,
    online: paired.online,
    daemonOnline: paired.daemonOnline,
  })
  const box = agent ?? own

  const [text, setText] = useState('')
  const [cwd, setCwd] = useState('')
  const [showFlags, setShowFlags] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [notice, setNotice] = useState('')

  const canDispatch = paired.hasSession && paired.online && paired.daemonOnline
  const permissionMode = permissionModeFor({
    cli: selection.cli,
    flags: selection.flags,
    deepResearch: selection.deepResearch,
  })

  // The preview always shows the real argv — with your text once you have typed any.
  const preview = useMemo(
    () => commandForPrompt(selection, text.trim() || '<your prompt>', cwd.trim()),
    // selection.command already tracks every field that feeds the build.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.command, text, cwd],
  )

  function send() {
    if (!text.trim()) {
      setNotice('Type what you want the agent to do first.')
      return
    }
    if (!canDispatch) {
      setSubmitted(false)
      setNotice(
        paired.hasSession
          ? 'The laptop is not reachable right now — start the Forge bridge on it, then send again.'
          : 'This runs on a real laptop, so pair one first.',
      )
      onNeedMachine()
      return
    }
    setNotice('')
    setSubmitted(true)
    void box.sendPrompt({
      text: preview.prompt,
      cwd: cwd.trim() || box.cwd,
      permissionMode,
      provider: selection.cli,
      // The same model the preview shows in the command line.
      model: selection.model,
    })
    setText('')
  }

  return (
    <div className={`prompt-composer${compact ? ' prompt-composer-compact' : ''}`}>
      <div className="prompt-pickers">
        <CliPicker
          profiles={selection.profiles}
          value={selection.cli}
          onChange={(cli) => selection.setCli(cli)}
          label="Run it with"
          compact={compact}
        />
        <ModelPicker
          profile={selection.profile}
          value={selection.model}
          customValue={selection.customModel}
          onSelect={selection.setModel}
          onCustom={selection.setCustomModel}
        />
        <label className="prompt-research">
          <input
            type="checkbox"
            checked={selection.deepResearch}
            onChange={(event) => selection.setDeepResearch(event.target.checked)}
          />
          <img src="/sprites/research.png" alt="" width={16} height={16} />
          <span>
            Deep research
            <OsNote>Investigate and cite first; change nothing.</OsNote>
          </span>
        </label>
      </div>

      <textarea
        className="prompt-text"
        rows={compact ? 4 : 5}
        value={text}
        placeholder={`Tell ${selection.profile.name} what to do…  e.g. “Fix the failing test in lib/shared and explain why it broke.”`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          send()
        }}
      />

      <div className="prompt-chips" aria-label="Example prompts">
        {EXAMPLES.map((example) => (
          <button type="button" key={example} className="prompt-chip" onClick={() => setText(example)}>
            {example}
          </button>
        ))}
      </div>

      <div className="prompt-row">
        <input
          className="prompt-cwd"
          value={cwd}
          placeholder={box.cwd ? `Folder: ${box.cwd}` : 'Folder on the laptop (optional)'}
          onChange={(event) => setCwd(event.target.value)}
          spellCheck={false}
        />
        <OsButton variant="primary" onClick={send} disabled={box.working}>
          {box.working ? 'Working…' : `Send to ${selection.profile.name}`}
        </OsButton>
        {box.working ? <OsButton onClick={() => void box.stopJob()}>Stop</OsButton> : null}
        <OsButton onClick={() => setShowFlags((open) => !open)}>{showFlags ? 'Hide flags' : 'Flags…'}</OsButton>
      </div>

      <p className="prompt-summary">
        <OsPill
          tone={
            permissionMode === 'plan' ? 'idle' : permissionMode === 'bypassPermissions' ? 'warn' : 'good'
          }
        >
          {permissionMode === 'plan'
            ? 'read-only'
            : permissionMode === 'bypassPermissions'
              ? 'full power'
              : 'edits allowed'}
        </OsPill>
        <span>
          {summariseFlags({
            cli: selection.cli,
            flags: selection.flags,
            deepResearch: selection.deepResearch,
          })}
        </span>
      </p>

      {showFlags ? (
        <FlagPanel
          profile={selection.profile}
          flags={selection.flags}
          deepResearch={selection.deepResearch}
          onToggle={selection.toggleFlag}
          onSelect={selection.setFlagSelect}
          onValue={selection.setFlagValue}
          onDeepResearch={selection.setDeepResearch}
          onReset={selection.resetFlags}
        />
      ) : null}

      {!compact ? <CommandPreview command={preview} title={`What ${selection.profile.name} runs`} /> : null}

      {notice ? <p className="prompt-notice">{notice}</p> : null}
      {box.error ? <p className="prompt-notice prompt-notice-bad">{box.error}</p> : null}

      {submitted && canDispatch ? (
        <div className="prompt-result">
          <div className="prompt-result-head">
            <strong>Running on {paired.hostname || 'your laptop'}</strong>
            <OsPill tone={box.working ? 'warn' : 'good'}>{box.job?.status ?? (box.working ? 'starting' : 'done')}</OsPill>
          </div>
          <div className="prompt-result-body">
            <ConsoleTranscript events={box.events} emptyHint="Waiting for the first word from the CLI…" />
          </div>
          {box.job?.pending_permission ? (
            <div className="prompt-ask">
              <span>
                Allow <strong>{box.job.pending_permission.tool_name || 'this tool'}</strong>
                {box.job.pending_permission.detail ? ` — ${box.job.pending_permission.detail}` : ''}?
              </span>
              <div className="os-actions">
                <OsButton variant="primary" onClick={() => void box.answerPermission(true)}>
                  Allow
                </OsButton>
                <OsButton onClick={() => void box.answerPermission(false)}>Deny</OsButton>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
