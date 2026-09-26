'use client'

/**
 * crt-screen.tsx — the glass.
 *
 * Holds the picture (boot screens or the desktop) plus the four effects that
 * make it read as a CRT, all of them extremely subtle by design:
 *
 *   zc-scanlines  4 % horizontal lines
 *   zc-pixelgrid  3 % phosphor triads — this is the "a little pixelated" layer
 *   zc-vignette   soft darkening at the edges, like a curved tube
 *   zc-glare      one diagonal highlight
 *
 * It also owns the virtual pointer: in `track` mode the pointer is drawn (and
 * the native cursor hidden) because a finger or the physical mouse is driving
 * it; in `direct` mode the visitor's real cursor is used and the drawn pointer
 * is hidden. Touching the glass always moves the pointer, so the machine works
 * like a touchscreen too — that is what makes it usable on a phone.
 *
 * Pointer updates are rAF-throttled: a drag fires ~120 events/second and the
 * machine must not re-render for each one.
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'

import type { PointerMode } from './use-machine'

export function CrtScreen({
  screenRef,
  powered,
  brightness,
  pointer,
  pointerMode,
  osd,
  wallpaper = false,
  children,
  onPointerTrack,
}: {
  screenRef: RefObject<HTMLDivElement | null>
  powered: boolean
  brightness: number
  pointer: { x: number; y: number }
  pointerMode: PointerMode
  osd: string
  /** Show the desktop wallpaper instead of the plain phosphor background. */
  wallpaper?: boolean
  children: ReactNode
  /** The finger/mouse moved over the glass: report the new pointer position. */
  onPointerTrack(point: { x: number; y: number }): void
}) {
  const frameRef = useRef(0)
  const pendingRef = useRef<{ x: number; y: number } | null>(null)

  const flush = useCallback(() => {
    frameRef.current = 0
    const point = pendingRef.current
    pendingRef.current = null
    if (point) onPointerTrack(point)
  }, [onPointerTrack])

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  const track = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const box = screenRef.current?.getBoundingClientRect()
      if (!box || box.width === 0 || box.height === 0) return
      pendingRef.current = {
        x: ((event.clientX - box.left) / box.width) * 100,
        y: ((event.clientY - box.top) / box.height) * 100,
      }
      if (!frameRef.current) frameRef.current = requestAnimationFrame(flush)
    },
    [flush, screenRef],
  )

  const state = powered ? (wallpaper ? 'desktop' : 'phosphor') : 'off'

  return (
    <div
      ref={screenRef}
      className="zc-screen"
      data-state={state}
      data-pointer={pointerMode}
      onPointerDown={track}
      onPointerMove={(event) => {
        // Only track while a finger/button is down, so a passing mouse does not
        // fight the visitor's own cursor.
        if (event.buttons === 0 && event.pointerType !== 'touch') return
        track(event)
      }}
    >
      <div className="zc-glass" style={{ filter: `brightness(${brightness})` }}>
        <div className="zc-screen-body">{children}</div>
        <div className="zc-scanlines" aria-hidden="true" />
        <div className="zc-pixelgrid" aria-hidden="true" />
        <div className="zc-vignette" aria-hidden="true" />
        <div className="zc-glare" aria-hidden="true" />
        {powered && pointerMode === 'track' ? (
          <span className="zc-pointer" style={{ left: `${pointer.x}%`, top: `${pointer.y}%` }} aria-hidden="true" />
        ) : null}
        {osd ? <div className="zc-osd">{osd}</div> : null}
      </div>
    </div>
  )
}
