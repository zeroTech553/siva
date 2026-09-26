'use client'

/**
 * lib/client/polite-polling.ts — one loop for every "ask the server again" in
 * the browser, written so it costs as little as possible on Vercel's free tier.
 *
 * Rules, in order of importance:
 *
 *   1. A hidden tab polls ZERO times. The timer is cleared, not lengthened, so
 *      a backgrounded phone does not spend a single serverless invocation.
 *   2. Refocusing the tab ticks IMMEDIATELY (the user is looking again) and
 *      drops the delay back to baseMs.
 *   3. While nothing changes, the interval backs off adaptively toward maxMs.
 *      An error backs off twice as fast.
 *   4. Requests never overlap: the next tick is only armed after the previous
 *      one settles, so a slow relay can't produce a pile-up.
 *   5. Going offline pauses; coming back online ticks at once.
 *
 * Pure maths lives in lib/shared/poll-schedule.ts and is unit-tested there.
 */

import { createPollPlan, type PollSchedule } from '@/lib/shared/poll-schedule'

export type PolitePollOptions<T> = {
  /** Label used in error reports only. */
  name?: string
  /** One round of work. Must be safe to call repeatedly. */
  run: () => Promise<T>
  /** Called after every successful round, whether or not anything changed. */
  onValue?: (value: T) => void
  onError?: (error: unknown) => void
  /** Decides whether a round counts as a change (default: deep JSON compare). */
  changed?: (previous: T | undefined, next: T) => boolean
  schedule?: Partial<PollSchedule>
  /** While this returns false the loop stays parked (e.g. no pairing code yet). */
  enabled?: () => boolean
  /** Tick straight away on start instead of waiting one interval. Default true. */
  immediate?: boolean
}

export type PolitePoll = {
  /** Tear down: clears the timer and removes every listener. */
  stop(): void
  /** Force one round now and reset the backoff (user clicked something). */
  tick(): void
  isStopped(): boolean
  isPaused(): boolean
}

export function startPolitePolling<T>(options: PolitePollOptions<T>): PolitePoll {
  const {
    run,
    onValue,
    onError,
    changed = defaultChanged,
    enabled,
    immediate = true,
  } = options
  const plan = createPollPlan(options.schedule)

  let timer = 0
  let stopped = false
  let inFlight = false
  let last: T | undefined

  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false
  const parked = () => stopped || hidden() || offline() || (enabled ? !enabled() : false)

  function clearTimer() {
    if (timer) window.clearTimeout(timer)
    timer = 0
  }

  function arm(delay = plan.delay()) {
    clearTimer()
    if (parked()) return
    timer = window.setTimeout(() => void round(), delay)
  }

  async function round() {
    if (parked() || inFlight) return
    inFlight = true
    try {
      const value = await run()
      if (stopped) return
      const outcome = changed(last, value) ? 'changed' : 'same'
      last = value
      plan.next(outcome)
      onValue?.(value)
    } catch (error) {
      if (stopped) return
      plan.next('error')
      onError?.(error)
    } finally {
      inFlight = false
      arm()
    }
  }

  function onVisibility() {
    if (hidden()) {
      clearTimer() // rule 1: a hidden tab costs nothing
      return
    }
    plan.reset() // rule 2: the user is back, be responsive again
    void round()
  }

  function onFocus() {
    if (parked()) return
    plan.reset()
    void round()
  }

  function onOnlineState() {
    if (offline()) {
      clearTimer()
      return
    }
    plan.reset()
    void round()
  }

  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnlineState)
    window.addEventListener('offline', onOnlineState)
  }

  if (immediate && !parked()) void round()
  else arm()

  return {
    stop() {
      stopped = true
      clearTimer()
      if (typeof window === 'undefined') return
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnlineState)
      window.removeEventListener('offline', onOnlineState)
    },
    tick() {
      if (stopped) return
      plan.reset()
      if (parked()) {
        arm()
        return
      }
      void round()
    },
    isStopped: () => stopped,
    isPaused: () => hidden() || offline(),
  }
}

function defaultChanged<T>(previous: T | undefined, next: T): boolean {
  if (previous === undefined) return true
  try {
    return JSON.stringify(previous) !== JSON.stringify(next)
  } catch {
    return previous !== next
  }
}
