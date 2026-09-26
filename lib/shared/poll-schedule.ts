/**
 * lib/shared/poll-schedule.ts — the pure maths behind polite client polling.
 *
 * Forge's browser polls three things: "is my laptop paired yet?", "is it still
 * online?" and "did the agent produce more output?". On Vercel's free tier every
 * one of those polls is a serverless invocation, so the client has to behave:
 *
 *   • start fast (a human is watching the pairing code)
 *   • slow down when nothing is changing (adaptive backoff)
 *   • speed straight back up the moment something changes or the tab is refocused
 *
 * `createPollPlan()` is a tiny state machine with no timers and no DOM, so
 * `tests/poll-schedule.test.mjs` can assert the exact delay sequence.
 */

export type PollSchedule = {
  /** Fastest interval, in ms. Used right after a change or a refocus. */
  baseMs: number
  /** Slowest interval, in ms. The floor for an idle tab. */
  maxMs: number
  /** Multiplier applied to the delay after each unchanged round. */
  backoff: number
  /**
   * Multiplier applied to the delay after a CHANGE. Values below 1 speed the
   * loop back up (clamped at baseMs), which is what you want: something moved,
   * so keep watching closely.
   */
  stepIn: number
  /** Consecutive unchanged rounds before backoff starts. */
  idleRounds: number
}

export type PollOutcome = 'changed' | 'same' | 'error'

/** Pairing, and anything else a human is watching. */
export const DEFAULT_POLL_SCHEDULE: PollSchedule = {
  baseMs: 1500,
  maxMs: 15000,
  backoff: 1.6,
  stepIn: 0.5,
  idleRounds: 2,
}

/** Long-running presence polling (nothing is expected to change). */
export const PRESENCE_POLL_SCHEDULE: PollSchedule = {
  baseMs: 2500,
  maxMs: 30000,
  backoff: 1.7,
  stepIn: 0.6,
  idleRounds: 3,
}

/**
 * Streaming a running agent job. Feels live (≈3 rounds/second while events are
 * arriving) but backs off quickly when the CLI is thinking, and — because it
 * runs through startPolitePolling — costs nothing at all while the tab is
 * hidden. `stepIn < 1` re-accelerates the moment a new event lands.
 */
export const JOB_POLL_SCHEDULE: PollSchedule = {
  baseMs: 350,
  maxMs: 4000,
  backoff: 1.35,
  stepIn: 0.6,
  idleRounds: 4,
}

export type PollPlan = {
  /** Delay to use for the next tick. */
  delay(): number
  /** Feed one result back in; returns the delay for the next tick. */
  next(outcome: PollOutcome): number
  /** Drop back to baseMs (tab refocused, user acted). */
  reset(): number
  /** How many unchanged rounds in a row. */
  readonly idle: number
}

export function createPollPlan(schedule: Partial<PollSchedule> = {}): PollPlan {
  const config: PollSchedule = { ...DEFAULT_POLL_SCHEDULE, ...schedule }
  let delayMs = config.baseMs
  let idle = 0

  const clampDelay = (value: number) => Math.round(Math.min(Math.max(value, config.baseMs), config.maxMs))

  return {
    delay: () => delayMs,
    get idle() {
      return idle
    },
    next(outcome: PollOutcome) {
      if (outcome === 'changed') {
        idle = 0
        delayMs = clampDelay(delayMs * config.stepIn)
        return delayMs
      }
      if (outcome === 'error') {
        // Back off harder on errors: a dead endpoint should not be hammered.
        idle += 1
        delayMs = clampDelay(delayMs * config.backoff * config.backoff)
        return delayMs
      }
      idle += 1
      if (idle > config.idleRounds) delayMs = clampDelay(delayMs * config.backoff)
      return delayMs
    },
    reset() {
      idle = 0
      delayMs = config.baseMs
      return delayMs
    },
  }
}
