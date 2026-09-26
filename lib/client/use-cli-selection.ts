'use client'

/**
 * use-cli-selection.ts — which CLI, which model, which flags. One hook, so the
 * agent selector, the flags panel, "Send a prompt" and the install command all
 * agree, wherever they are on the page.
 *
 * Choices are remembered per CLI in localStorage (`forge.cli.v1`), so switching
 * from Claude Code to Codex and back does not lose your flags. The chosen CLI is
 * also written to the console prefs (`forge.console.v1`) that /console restores.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { writeConsolePrefs } from '@/lib/client/forge-session'
import {
  buildCliCommand,
  cliProfile,
  cliProfileList,
  defaultFlagState,
  type BuiltCommand,
  type CliProfile,
  type FlagState,
} from '@/lib/shared/cli-flags'
import { normalizeCliId, type CliId } from '@/lib/shared/cli-flags'

export const CLI_SELECTION_KEY = 'forge.cli.v1'

export const CUSTOM_MODEL = '__custom__'

/** What the preview command shows where the visitor's prompt will go. */
export const PREVIEW_PROMPT = '<your prompt>'

type PerCli = { model: string; customModel: string; flags: FlagState }
type Stored = { cli: CliId; deepResearch: boolean; perCli: Partial<Record<CliId, PerCli>> }

function blankPerCli(profile: CliProfile): PerCli {
  return { model: '', customModel: '', flags: defaultFlagState(profile) }
}

function readStored(): Stored {
  const fallback: Stored = { cli: 'claude', deepResearch: false, perCli: {} }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const parsed = JSON.parse(localStorage.getItem(CLI_SELECTION_KEY) || '{}') as Partial<Stored>
    const cli = normalizeCliId(parsed.cli) || fallback.cli
    return { cli, deepResearch: Boolean(parsed.deepResearch), perCli: parsed.perCli ?? {} }
  } catch {
    return fallback
  }
}

export type CliSelection = {
  cli: CliId
  profile: CliProfile
  profiles: readonly CliProfile[]
  /** '' means "whatever the CLI defaults to". */
  model: string
  customModel: string
  flags: FlagState
  deepResearch: boolean
  command: BuiltCommand
  setCli(id: string): void
  setModel(id: string): void
  setCustomModel(value: string): void
  toggleFlag(id: string, on?: boolean): void
  setFlagSelect(id: string, value: string): void
  setFlagValue(id: string, value: string): void
  setDeepResearch(on: boolean): void
  resetFlags(): void
}

export function useCliSelection(initialCli?: string): CliSelection {
  const [cli, setCliId] = useState<CliId>(() => normalizeCliId(initialCli) || 'claude')
  const [deepResearch, setDeepResearchState] = useState(false)
  const [perCli, setPerCli] = useState<Partial<Record<CliId, PerCli>>>({})
  const [hydrated, setHydrated] = useState(false)

  const profile = cliProfile(cli)
  const current = perCli[cli] ?? blankPerCli(profile)

  // -- hydrate once -----------------------------------------------------------
  useEffect(() => {
    const stored = readStored()
    setPerCli(stored.perCli)
    setDeepResearchState(stored.deepResearch)
    if (!initialCli) setCliId(stored.cli)
    setHydrated(true)
  }, [initialCli])

  // -- persist ----------------------------------------------------------------
  useEffect(() => {
    if (!hydrated || typeof localStorage === 'undefined') return
    const stored: Stored = { cli, deepResearch, perCli }
    localStorage.setItem(CLI_SELECTION_KEY, JSON.stringify(stored))
    writeConsolePrefs({ provider: cli })
  }, [cli, deepResearch, hydrated, perCli])

  const patch = useCallback(
    (next: Partial<PerCli>) => {
      setPerCli((currentMap) => {
        const base = currentMap[cli] ?? blankPerCli(cliProfile(cli))
        return { ...currentMap, [cli]: { ...base, ...next } }
      })
    },
    [cli],
  )

  const setCli = useCallback((id: string) => {
    const normalized = normalizeCliId(id)
    if (normalized) setCliId(normalized)
  }, [])

  const model = current.customModel && current.model === CUSTOM_MODEL ? current.customModel : current.model

  const command = useMemo(
    () =>
      buildCliCommand({
        cli,
        prompt: PREVIEW_PROMPT,
        model,
        flags: current.flags,
        deepResearch,
      }),
    [cli, current.flags, current.model, current.customModel, deepResearch, model],
  )

  return {
    cli,
    profile,
    profiles: cliProfileList(),
    model,
    customModel: current.customModel,
    flags: current.flags,
    deepResearch,
    command,
    setCli,
    setModel: (id: string) => patch({ model: id }),
    setCustomModel: (value: string) => patch({ customModel: value, model: CUSTOM_MODEL }),
    toggleFlag: (id: string, on?: boolean) =>
      patch({ flags: { ...current.flags, toggles: { ...current.flags.toggles, [id]: on ?? !current.flags.toggles[id] } } }),
    setFlagSelect: (id: string, value: string) =>
      patch({ flags: { ...current.flags, selects: { ...current.flags.selects, [id]: value } } }),
    setFlagValue: (id: string, value: string) =>
      patch({ flags: { ...current.flags, values: { ...current.flags.values, [id]: value } } }),
    setDeepResearch: (on: boolean) => setDeepResearchState(on),
    resetFlags: () => patch({ flags: defaultFlagState(profile), model: '', customModel: '' }),
  }
}

/** Build the same command with a real prompt in it. */
export function commandForPrompt(selection: CliSelection, prompt: string, cwd?: string): BuiltCommand {
  return buildCliCommand({
    cli: selection.cli,
    prompt,
    model: selection.model,
    flags: selection.flags,
    deepResearch: selection.deepResearch,
    cwd,
  })
}
