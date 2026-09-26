'use client'

/**
 * use-machine.ts — the state machine of the physical box.
 *
 * One hook owns everything the hardware can do, so the chassis component is a
 * pure render of this state and nothing else:
 *
 *   power      off → booting → on → shutting-down → off
 *   stage      which boot screen is on the glass (see boot/boot-stages.ts)
 *   brightness / mute / cd tray / disk LED / pointer mode / pointer position
 *
 * Boot timing is one interval that only runs while `power === 'booting'`
 * (110 ms), so an idle machine costs zero work. Tapping the glass skips a
 * stage; `prefers-reduced-motion` and phone visitors get the fast sequence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  FAST_BOOT_FACTOR,
  bootStageAt,
  bootStageProgress,
  elapsedInStage,
  scaledBootSequence,
  totalBootMs,
  type BootStageId,
} from '@/components/computer/boot/boot-stages'
import {
  applySoundPrefs,
  isMuted,
  playBoot,
  playClick,
  playDisk,
  playPower,
  playShutdown,
  resetBootChime,
  setMuted,
  stopSong,
} from '@/lib/client/zero-sound'

export type PowerState = 'off' | 'booting' | 'on' | 'shutting-down'
export type PointerMode = 'direct' | 'track'

/** Remembered per browser tab so navigating away and back does not reboot. */
export const BOOT_MEMORY_KEY = 'zero.os.booted.v1'

const BOOT_TICK_MS = 110
const MIN_BRIGHTNESS = 0.55
const MAX_BRIGHTNESS = 1.3
const SHUTDOWN_SCREEN_MS = 1800

export type Machine = {
  power: PowerState
  stage: BootStageId
  /** 0..1 progress through the current boot stage — drives the progress bar. */
  stageProgress: number
  /** ms into the current stage — drives the typewriter lines. */
  stageElapsed: number
  brightness: number
  muted: boolean
  cdOpen: boolean
  diskActive: boolean
  pointerMode: PointerMode
  pointer: { x: number; y: number }
  /** Transient on-screen display text (brightness, pointer mode …). */
  osd: string
  /** 1 normally, FAST_BOOT_FACTOR for reduced motion / small screens. */
  bootFactor: number
  actions: MachineActions
}

export type MachineActions = {
  pressPower(): void
  pressReset(): void
  shutdown(): void
  restart(): void
  brightnessUp(): void
  brightnessDown(): void
  toggleMute(): void
  toggleCd(): void
  setPointerMode(mode: PointerMode): void
  setPointer(point: { x: number; y: number }): void
  /** Relative move in screen percentages — what the physical mouse reports. */
  movePointerBy(delta: { dx: number; dy: number }): void
  setDiskActive(active: boolean): void
  skipStage(): void
  say(message: string): void
}

export type UseMachineOptions = {
  /** Power on and boot by itself on mount. Default true. */
  autoBoot?: boolean
  /** Reuse a boot that already happened in this tab. Default true. */
  rememberBoot?: boolean
  onDesktop?: () => void
  onPoweredOff?: () => void
  onBootStage?: (stage: BootStageId) => void
}

export function useMachine(options: UseMachineOptions = {}): Machine {
  const { autoBoot = true, rememberBoot = true } = options

  const [power, setPower] = useState<PowerState>('off')
  const [stage, setStage] = useState<BootStageId>('off')
  const [stageElapsed, setStageElapsed] = useState(0)
  const [stageProgress, setStageProgress] = useState(0)
  const [brightness, setBrightness] = useState(1)
  const [muted, setMutedState] = useState(false)
  const [cdOpen, setCdOpen] = useState(false)
  const [diskActive, setDiskActive] = useState(false)
  const [pointerMode, setPointerModeState] = useState<PointerMode>('direct')
  const [pointer, setPointerState] = useState({ x: 50, y: 50 })
  const [osd, setOsd] = useState('')
  const [bootFactor, setBootFactor] = useState(1)

  const bootStartRef = useRef(0)
  // The pointer lives in a ref as well as in state: a drag can fire several
  // move events inside one frame, and each one must add to the last position.
  const pointerRef = useRef({ x: 50, y: 50 })
  const skipOffsetRef = useRef(0)
  const stageRef = useRef<BootStageId>('off')
  const osdTimerRef = useRef(0)
  const diskTimerRef = useRef(0)
  const shutdownTimerRef = useRef(0)

  // Callbacks are read through a ref so the boot clock never restarts when a
  // parent re-renders with a new inline function.
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  const bootElapsed = useCallback(() => performance.now() - bootStartRef.current + skipOffsetRef.current, [])

  const say = useCallback((message: string) => {
    setOsd(message)
    window.clearTimeout(osdTimerRef.current)
    osdTimerRef.current = window.setTimeout(() => setOsd(''), 1400)
  }, [])

  const flashDisk = useCallback((ms = 320) => {
    setDiskActive(true)
    window.clearTimeout(diskTimerRef.current)
    diskTimerRef.current = window.setTimeout(() => setDiskActive(false), ms)
  }, [])

  // -- environment probe: sound prefs, motion preference, pointer kind ---------
  useEffect(() => {
    applySoundPrefs()
    setMutedState(isMuted())
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const smallScreen = window.innerWidth < 560
    setBootFactor(reduceMotion || smallScreen ? FAST_BOOT_FACTOR : 1)
    // A real mouse means the native cursor is useful; a finger means the
    // physical mouse object is the better pointing device.
    const finePointer = window.matchMedia?.('(pointer: fine)').matches ?? false
    setPointerModeState(finePointer ? 'direct' : 'track')
  }, [])

  // -- the boot clock ---------------------------------------------------------
  useEffect(() => {
    if (power !== 'booting') return
    const timer = window.setInterval(() => {
      const elapsed = bootElapsed()
      const nextStage = bootStageAt(elapsed, bootFactor)
      setStageElapsed(elapsedInStage(elapsed, bootFactor))
      setStageProgress(bootStageProgress(elapsed, bootFactor))
      if (nextStage === stageRef.current) return
      stageRef.current = nextStage
      setStage(nextStage)
      callbacksRef.current.onBootStage?.(nextStage)
      if (nextStage !== 'desktop') return
      window.clearInterval(timer)
      setPower('on')
      if (rememberBoot) {
        try {
          sessionStorage.setItem(BOOT_MEMORY_KEY, '1')
        } catch {
          // Private mode: the next visit simply boots again.
        }
      }
      callbacksRef.current.onDesktop?.()
    }, BOOT_TICK_MS)
    return () => window.clearInterval(timer)
  }, [power, bootFactor, bootElapsed, rememberBoot])

  useEffect(
    () => () => {
      window.clearTimeout(osdTimerRef.current)
      window.clearTimeout(diskTimerRef.current)
      window.clearTimeout(shutdownTimerRef.current)
    },
    [],
  )

  const powerOn = useCallback(
    (skipBoot: boolean) => {
      resetBootChime()
      stopSong()
      skipOffsetRef.current = 0
      bootStartRef.current = performance.now()
      setDiskActive(false)
      if (skipBoot) {
        skipOffsetRef.current = totalBootMs(bootFactor) + 1
        stageRef.current = 'desktop'
        setStage('desktop')
        setStageElapsed(0)
        setStageProgress(1)
        setPower('on')
        void playBoot()
        callbacksRef.current.onDesktop?.()
        return
      }
      stageRef.current = 'bios'
      setStage('bios')
      setStageElapsed(0)
      setStageProgress(0)
      setPower('booting')
      void playPower()
      flashDisk(600)
    },
    [bootFactor, flashDisk],
  )

  const powerOff = useCallback(() => {
    stopSong()
    stageRef.current = 'safe'
    setStage('safe')
    setPower('shutting-down')
    void playShutdown()
    window.clearTimeout(shutdownTimerRef.current)
    shutdownTimerRef.current = window.setTimeout(() => {
      stageRef.current = 'off'
      setStage('off')
      setPower('off')
      callbacksRef.current.onPoweredOff?.()
    }, SHUTDOWN_SCREEN_MS)
  }, [])

  const actions = useMemo<MachineActions>(
    () => ({
      pressPower() {
        void playClick()
        if (power === 'off') powerOn(false)
        else powerOff()
      },
      pressReset() {
        window.clearTimeout(shutdownTimerRef.current)
        powerOn(false)
        say('RESET')
      },
      shutdown: powerOff,
      restart() {
        window.clearTimeout(shutdownTimerRef.current)
        powerOn(false)
      },
      brightnessUp() {
        setBrightness((value) => {
          const next = Math.min(MAX_BRIGHTNESS, Number((value + 0.15).toFixed(2)))
          say(`Brightness ${Math.round(next * 100)}%`)
          return next
        })
      },
      brightnessDown() {
        setBrightness((value) => {
          const next = Math.max(MIN_BRIGHTNESS, Number((value - 0.15).toFixed(2)))
          say(`Brightness ${Math.round(next * 100)}%`)
          return next
        })
      },
      toggleMute() {
        const next = !isMuted()
        setMuted(next)
        setMutedState(next)
        say(next ? 'Sound off' : 'Sound on')
        if (!next) void playClick()
      },
      toggleCd() {
        void playDisk()
        setCdOpen((open) => !open)
        flashDisk()
      },
      setPointerMode(mode: PointerMode) {
        setPointerModeState(mode)
        say(mode === 'direct' ? 'Pointer: direct' : 'Pointer: trackpad')
      },
      setPointer(point: { x: number; y: number }) {
        const next = {
          x: Math.min(99, Math.max(1, point.x)),
          y: Math.min(99, Math.max(1, point.y)),
        }
        pointerRef.current = next
        setPointerState(next)
      },
      movePointerBy(delta: { dx: number; dy: number }) {
        const current = pointerRef.current
        const next = {
          x: Math.min(99, Math.max(1, current.x + delta.dx)),
          y: Math.min(99, Math.max(1, current.y + delta.dy)),
        }
        pointerRef.current = next
        setPointerState(next)
      },
      setDiskActive,
      skipStage() {
        if (power !== 'booting') return
        const elapsed = bootElapsed()
        const current = bootStageAt(elapsed, bootFactor)
        let end = 0
        for (const step of scaledBootSequence(bootFactor)) {
          if (Number.isFinite(step.durationMs)) end += step.durationMs
          if (step.id === current) break
        }
        skipOffsetRef.current += Math.max(0, end - elapsed)
        setStageElapsed(0)
        flashDisk(200)
      },
      say,
    }),
    [bootElapsed, bootFactor, flashDisk, power, powerOff, powerOn, say],
  )

  // -- first mount ------------------------------------------------------------
  useEffect(() => {
    if (!autoBoot) return
    let bootedBefore = false
    if (rememberBoot) {
      try {
        bootedBefore = sessionStorage.getItem(BOOT_MEMORY_KEY) === '1'
      } catch {
        bootedBefore = false
      }
    }
    powerOn(bootedBefore)
    // Once per mount. `powerOn` is stable enough that a dep here would only
    // risk a second boot in StrictMode, which is what the ref guards against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    power,
    stage,
    stageProgress,
    stageElapsed,
    brightness,
    muted,
    cdOpen,
    diskActive,
    pointerMode,
    pointer,
    osd,
    bootFactor,
    actions,
  }
}
