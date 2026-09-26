'use client'

/**
 * os-window.tsx — one OS window: title bar, caption buttons, body, status bar.
 *
 * Dragging and resizing are plain pointer math, expressed in PERCENT of the
 * desktop area so a window keeps its place when the CRT changes size between a
 * phone and a laptop:
 *
 *   dx% = (event.clientX - startX) / desktopRect.width * 100
 *
 * `setPointerCapture` on the title bar is what makes a drag survive the finger
 * leaving the (tiny) title bar, which matters most on a phone.
 *
 * This component holds no window state of its own — geometry and z-order come
 * from the window manager (window-manager.ts) and are reported back through
 * onMove / onResize.
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'

import { playMinimize, playWindowClose } from '@/lib/client/zero-sound'

import { OsCaptionButton, OsSprite } from './os-ui'
import type { OsWindow } from './window-manager'

type DragState = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  originW: number
  originH: number
  box: DOMRect
}

export function OsWindowFrame({
  window,
  active,
  children,
  status,
  areaRef,
  sprite,
  onFocus,
  onClose,
  onMinimize,
  onToggleMaximize,
  onMove,
  onResize,
}: {
  window: OsWindow
  active: boolean
  children: ReactNode
  status?: string
  /** The desktop element whose box percentages are measured against. */
  areaRef: RefObject<HTMLElement | null>
  /** Pixel-art icon name (public/sprites/<name>.png); falls back to a square. */
  sprite?: string
  onFocus(): void
  onClose(): void
  onMinimize(): void
  onToggleMaximize(): void
  onMove(x: number, y: number): void
  onResize(w: number, h: number): void
}) {
  const dragRef = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
      onFocus()
      if (window.maximized) return
      const box = areaRef.current?.getBoundingClientRect()
      if (!box || box.width === 0 || box.height === 0) return
      event.preventDefault()
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: window.x,
        originY: window.y,
        originW: window.w,
        originH: window.h,
        box,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      if (mode === 'move') setDragging(true)
      else setResizing(true)
    },
    [areaRef, onFocus, window.h, window.maximized, window.w, window.x, window.y],
  )

  const onDragMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const dx = ((event.clientX - drag.startX) / drag.box.width) * 100
      const dy = ((event.clientY - drag.startY) / drag.box.height) * 100
      if (mode === 'move') onMove(drag.originX + dx, drag.originY + dy)
      else onResize(drag.originW + dx, drag.originH + dy)
    },
    [onMove, onResize],
  )

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    setResizing(false)
  }, [])

  return (
    <section
      className={[
        'zos-window',
        active ? 'zos-window-active' : '',
        window.maximized ? 'zos-window-max' : '',
        dragging ? 'zos-window-dragging' : '',
        resizing ? 'zos-window-resizing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: `${window.x}%`,
        top: `${window.y}%`,
        width: `${window.w}%`,
        height: `${window.h}%`,
        zIndex: window.z,
      }}
      role="group"
      aria-label={window.title}
      onPointerDown={onFocus}
    >
      <header
        className="zos-title"
        onPointerDown={(event) => beginDrag(event, 'move')}
        onPointerMove={(event) => onDragMove(event, 'move')}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onToggleMaximize}
      >
        {sprite ? <OsSprite name={sprite} size={12} /> : <span className="zos-title-dot" aria-hidden="true" />}
        <span className="zos-title-text">{window.title}</span>
        <span className="zos-title-buttons">
          <OsCaptionButton
            glyph="_"
            label="Minimize"
            onClick={() => {
              void playMinimize()
              onMinimize()
            }}
          />
          <OsCaptionButton
            glyph={window.maximized ? '❐' : '□'}
            label={window.maximized ? 'Restore' : 'Maximize'}
            onClick={onToggleMaximize}
          />
          <OsCaptionButton
            glyph="✕"
            label="Close"
            onClick={() => {
              void playWindowClose()
              onClose()
            }}
          />
        </span>
      </header>

      <div className="zos-window-body">{children}</div>

      {status ? (
        <footer className="zos-status">
          <span className="zos-status-text">{status}</span>
        </footer>
      ) : null}

      {window.maximized ? null : (
        <span
          className="zos-grip"
          aria-hidden="true"
          onPointerDown={(event) => beginDrag(event, 'resize')}
          onPointerMove={(event) => onDragMove(event, 'resize')}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      )}
    </section>
  )
}
