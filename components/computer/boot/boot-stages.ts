/**
 * Zero OS boot sequence — pure data + timing maths, no React and no timers.
 *
 * A real machine shows three distinct things before you get a desktop, and so
 * does this one:
 *
 *   1. `bios`     firmware POST: memory count, drive detection, keyboard/mouse
 *   2. `windows`  the four-pane "Starting…" loader with a block progress bar
 *                  (an homage to 90s OS boot screens, drawn from scratch)
 *   3. `zeroos`   the Zero OS logo splash while the desktop is loaded
 *   4. `desktop`  the window manager is yours
 *
 * `bootStageAt(elapsedMs)` is the only thing the component needs to render, and
 * because it is pure it is unit-tested in `tests/boot-stages.test.mjs`.
 *
 * Every stage can be skipped by tapping the screen, and `prefers-reduced-motion`
 * users get `FAST_BOOT_FACTOR` timings automatically (see use-machine.ts).
 */

export type BootStageId = 'off' | 'bios' | 'windows' | 'zeroos' | 'desktop' | 'safe'

export type BootStep = {
  id: BootStageId
  /** Shown in the machine's status readout, not on the glass. */
  label: string
  durationMs: number
}

export const FAST_BOOT_FACTOR = 0.35

export const BIOS_LINES: readonly string[] = [
  'ZERO BIOS v2.14  (C) 2026 zeroTech',
  'CPU: Zero386DX-33   FPU: integrated',
  'Memory test: 8192K OK',
  'Detecting IDE drives ...',
  '  primary master   : ZERO-HDD  540MB',
  '  primary slave    : ZERO-CD   4X',
  '  secondary master : none',
  'Keyboard detected   Mouse on COM1',
  'Plug and Play devices: 0',
]

export const WINDOWS_BOOT_LINES: readonly string[] = [
  'Starting Zero OS',
  'Loading HIMEM.SYS ... OK',
  'Loading display driver ... OK',
  'Starting network client ... OK',
]

export const ZERO_OS_SPLASH_LINES: readonly string[] = [
  'Loading window manager',
  'Mounting your laptop',
  'Warming the phosphor',
]

export const SAFE_TO_POWER_OFF = 'It is now safe to turn off your computer.'

export const BOOT_SEQUENCE: readonly BootStep[] = [
  { id: 'bios', label: 'Firmware POST', durationMs: 2400 },
  { id: 'windows', label: 'OS loader', durationMs: 2600 },
  { id: 'zeroos', label: 'Zero OS splash', durationMs: 2000 },
  { id: 'desktop', label: 'Desktop', durationMs: Number.POSITIVE_INFINITY },
]

export const BOOT_STEPS_BEFORE_DESKTOP = BOOT_SEQUENCE.length - 1

/** Total time from power-on to desktop, at the given speed factor. */
export function totalBootMs(factor = 1): number {
  return BOOT_SEQUENCE.slice(0, BOOT_STEPS_BEFORE_DESKTOP).reduce(
    (sum, step) => sum + step.durationMs * factor,
    0,
  )
}

/** The same sequence with timed stages multiplied by `factor`. `desktop` never ends. */
export function scaledBootSequence(factor = 1): BootStep[] {
  return BOOT_SEQUENCE.map((step) =>
    Number.isFinite(step.durationMs) ? { ...step, durationMs: Math.round(step.durationMs * factor) } : step,
  )
}

/** Which stage the machine is showing `elapsedMs` after power-on. */
export function bootStageAt(elapsedMs: number, factor = 1): BootStageId {
  if (elapsedMs < 0) return 'off'
  let elapsed = 0
  for (const step of scaledBootSequence(factor)) {
    if (!Number.isFinite(step.durationMs)) return step.id
    if (elapsedMs < elapsed + step.durationMs) return step.id
    elapsed += step.durationMs
  }
  return 'desktop'
}

/** Index of the stage at `elapsedMs`, for the progress readout. */
export function bootStepIndexAt(elapsedMs: number, factor = 1): number {
  const stage = bootStageAt(elapsedMs, factor)
  const index = scaledBootSequence(factor).findIndex((step) => step.id === stage)
  return index < 0 ? 0 : index
}

/** How far through the current stage, 0..1 — drives the block progress bar. */
export function bootStageProgress(elapsedMs: number, factor = 1): number {
  const sequence = scaledBootSequence(factor)
  let elapsed = 0
  for (const step of sequence) {
    if (!Number.isFinite(step.durationMs)) return 1
    if (elapsedMs < elapsed + step.durationMs) {
      return step.durationMs === 0 ? 1 : (elapsedMs - elapsed) / step.durationMs
    }
    elapsed += step.durationMs
  }
  return 1
}

/** Lines the current stage should have typed by `elapsedMs`. */
export function visibleBootLines(stage: BootStageId, elapsedInStageMs: number, linesPerSecond = 5): string[] {
  const lines =
    stage === 'bios' ? BIOS_LINES : stage === 'windows' ? WINDOWS_BOOT_LINES : stage === 'zeroos' ? ZERO_OS_SPLASH_LINES : []
  if (!lines.length) return []
  const shown = Math.max(1, Math.ceil((elapsedInStageMs / 1000) * linesPerSecond))
  return lines.slice(0, Math.min(shown, lines.length))
}

/** Milliseconds into the current stage. */
export function elapsedInStage(elapsedMs: number, factor = 1): number {
  const sequence = scaledBootSequence(factor)
  let elapsed = 0
  for (const step of sequence) {
    if (!Number.isFinite(step.durationMs)) return elapsedMs - elapsed
    if (elapsedMs < elapsed + step.durationMs) return elapsedMs - elapsed
    elapsed += step.durationMs
  }
  return 0
}
