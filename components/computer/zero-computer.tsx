'use client'

/**
 * zero-computer.tsx — the machine, assembled.
 *
 * This is the ONE component a page renders to get a working Zero OS computer:
 *
 *   <ZeroComputer size="sm">{(machine) => <ZeroOs … onShutdown={machine.actions.shutdown} />}</ZeroComputer>
 *
 * Composition, and which file owns what:
 *
 *   use-machine.ts     power, boot stage, brightness, sound, pointer (state)
 *   machine-shell.tsx  chassis, drives, LEDs, knobs, power/reset (hardware UI)
 *   crt-screen.tsx     the glass, CRT effects, virtual pointer
 *   keyboard.tsx       the real keyboard
 *   mouse.tsx          the real mouse
 *   boot/boot-screen.tsx  BIOS → loader → Zero OS splash → safe-to-power-off
 *
 * The screen content is a render prop so the machine can hand its own actions
 * (shutdown, restart, disk LED) to whatever desktop is running inside it.
 */

import { useCallback, useRef, type ReactNode } from 'react'

import { BootScreen } from './boot/boot-screen'
import { CrtScreen } from './hardware/crt-screen'
import { MachineKeyboard } from './hardware/keyboard'
import { MachineShell } from './hardware/machine-shell'
import { MachineMouse } from './hardware/mouse'
import { useMachine, type Machine } from './hardware/use-machine'
import { clickAtPoint, contextMenuAtPoint, scrollAtPoint } from './hardware/dom-input'

/** How far the CRT pointer travels per pixel of real mouse movement. */
const MOUSE_GAIN = 1.7

export type ZeroComputerSize = 'sm' | 'md' | 'lg'

export function ZeroComputer({
  size = 'md',
  caption,
  hint,
  autoBoot = true,
  rememberBoot = true,
  functionRow = false,
  busy = false,
  model = 'ZT-486DX',
  children,
}: {
  /** sm = landing hero (small), md = section, lg = full console. */
  size?: ZeroComputerSize
  caption?: ReactNode
  hint?: ReactNode
  autoBoot?: boolean
  rememberBoot?: boolean
  /** Show the Esc + F-row (never on phones). */
  functionRow?: boolean
  /** Lights the hard-disk LED while an agent or terminal is working. */
  busy?: boolean
  model?: string
  children: (machine: Machine) => ReactNode
}) {
  const machine = useMachine({ autoBoot, rememberBoot })
  const screenRef = useRef<HTMLDivElement>(null)

  const screenBox = () => screenRef.current?.getBoundingClientRect() ?? null

  const clientPoint = useCallback(() => {
    const box = screenBox()
    if (!box) return null
    return {
      x: box.left + (machine.pointer.x / 100) * box.width,
      y: box.top + (machine.pointer.y / 100) * box.height,
    }
  }, [machine.pointer.x, machine.pointer.y])

  const onMovePointer = useCallback(
    (delta: { dx: number; dy: number }) => {
      const box = screenBox()
      if (!box || box.width === 0 || box.height === 0) return
      machine.actions.movePointerBy({
        dx: (delta.dx / box.width) * 100 * MOUSE_GAIN,
        dy: (delta.dy / box.height) * 100 * MOUSE_GAIN,
      })
    },
    [machine.actions],
  )

  const onPrimaryClick = useCallback(() => {
    const point = clientPoint()
    if (point) clickAtPoint(point.x, point.y)
  }, [clientPoint])

  const onSecondaryClick = useCallback(() => {
    const point = clientPoint()
    if (point) contextMenuAtPoint(point.x, point.y)
  }, [clientPoint])

  const onWheel = useCallback(
    (deltaY: number) => {
      const point = clientPoint()
      if (point) scrollAtPoint(point.x, point.y, deltaY)
    },
    [clientPoint],
  )

  const powered = machine.power !== 'off'
  const booted = machine.stage === 'desktop'

  return (
    <div className={`zc-root zc-size-${size}`} data-power={machine.power}>
      <div className="zc-machine">
        <MachineShell
          machine={machine}
          busy={busy}
          model={model}
          screen={
            <CrtScreen
              screenRef={screenRef}
              powered={powered}
              brightness={machine.brightness}
              pointer={machine.pointer}
              pointerMode={machine.pointerMode}
              osd={machine.osd}
              wallpaper={booted}
              onPointerTrack={machine.actions.setPointer}
            >
              {booted ? children(machine) : (
                <BootScreen
                  stage={machine.stage}
                  stageElapsed={machine.stageElapsed}
                  progress={machine.stageProgress}
                  onSkip={machine.actions.skipStage}
                />
              )}
            </CrtScreen>
          }
        />

        <div className="zc-peripherals">
          <MachineKeyboard
            compact={size === 'sm'}
            functionRow={functionRow && size === 'lg'}
            disabled={!booted}
          />
          <MachineMouse
            disabled={!booted}
            onMovePointer={onMovePointer}
            onPrimaryClick={onPrimaryClick}
            onSecondaryClick={onSecondaryClick}
            onWheel={onWheel}
          />
        </div>
      </div>

      {caption ? <div className="zc-caption">{caption}</div> : null}
      {hint ? <p className="zc-hint">{hint}</p> : null}
    </div>
  )
}

export type { Machine }
