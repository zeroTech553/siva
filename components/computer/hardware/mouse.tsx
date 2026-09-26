'use client'

/**
 * mouse.tsx — a real two-button mouse with a scroll wheel.
 *
 * Dragging the body moves the CRT pointer (relative movement, like a real mouse
 * on a mousepad — the pointer never teleports). A press-and-release without a
 * drag is a click, and the click lands on whatever is under the CRT pointer:
 *
 *   left button  → pointerdown/up/click on the element under the pointer
 *   right button → contextmenu (the desktop opens its menu)
 *   wheel        → wheel event at the pointer, so lists and terminals scroll
 *
 * `touch-action: none` in the CSS is what makes this work with a finger: the
 * drag moves the pointer instead of scrolling the landing page.
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'

import { playClick } from '@/lib/client/zero-sound'

const DRAG_THRESHOLD_PX = 8

export function MachineMouse({
  onMovePointer,
  onPrimaryClick,
  onSecondaryClick,
  onWheel,
  disabled = false,
}: {
  /** Relative movement in screen percentages: { dx: 3.2, dy: -1.1 }. */
  onMovePointer(delta: { dx: number; dy: number }): void
  onPrimaryClick(): void
  onSecondaryClick(): void
  onWheel(deltaY: number): void
  disabled?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const [pressed, setPressed] = useState<'left' | 'right' | null>(null)
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number; moved: number } | null>(null)

  const onBodyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return
      event.preventDefault()
      dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: 0 }
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [disabled],
  )

  const onBodyPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.lastX
      const dy = event.clientY - drag.lastY
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      drag.moved += Math.abs(dx) + Math.abs(dy)
      onMovePointer({ dx, dy })
    },
    [onMovePointer],
  )

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
  }, [])

  const buttonHandlers = (button: 'left' | 'right') => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (disabled) return
      event.preventDefault()
      event.stopPropagation()
      setPressed(button)
      dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: 0 }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.lastX
      const dy = event.clientY - drag.lastY
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      drag.moved += Math.abs(dx) + Math.abs(dy)
      // Dragging with a button held still moves the pointer (drag-select).
      onMovePointer({ dx, dy })
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      const wasClick = !drag || drag.moved < DRAG_THRESHOLD_PX
      dragRef.current = null
      setPressed(null)
      if (disabled || !wasClick) return
      void playClick()
      if (button === 'left') onPrimaryClick()
      else onSecondaryClick()
    },
    onPointerCancel: () => {
      dragRef.current = null
      setPressed(null)
    },
  })

  const onWheelHandler = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (disabled) return
    onWheel(event.deltaY)
  }

  return (
    <div
      className={`zc-mouse${dragging ? ' zc-mouse-drag' : ''}${disabled ? ' zc-mouse-off' : ''}`}
      onPointerDown={onBodyPointerDown}
      onPointerMove={onBodyPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheelHandler}
      onContextMenu={(event) => event.preventDefault()}
      role="presentation"
      title="Drag to move the pointer · left button clicks · right button opens the menu · wheel scrolls"
    >
      <span className="zc-mouse-cord" aria-hidden="true" />
      <div className="zc-mouse-buttons" aria-hidden="true">
        <button
          type="button"
          tabIndex={-1}
          className={`zc-mouse-btn zc-mouse-btn-left${pressed === 'left' ? ' zc-mouse-btn-down' : ''}`}
          aria-label="Mouse left button"
          {...buttonHandlers('left')}
        />
        <span className={`zc-mouse-wheel${pressed ? ' zc-mouse-wheel-active' : ''}`} />
        <button
          type="button"
          tabIndex={-1}
          className={`zc-mouse-btn zc-mouse-btn-right${pressed === 'right' ? ' zc-mouse-btn-down' : ''}`}
          aria-label="Mouse right button"
          {...buttonHandlers('right')}
        />
      </div>
      <span className="zc-mouse-palm" aria-hidden="true" />
    </div>
  )
}
