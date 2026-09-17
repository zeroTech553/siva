'use client'

import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { playBoot, playClick } from '@/lib/desk-sound'

type DeskComputerProps = {
  children: ReactNode
  phosphor?: boolean
  caption?: string
  wallpaper?: boolean
}

export function DeskComputer({ children, phosphor = false, caption, wallpaper = false }: DeskComputerProps) {
  const deskRef = useRef<HTMLElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number; moved: number } | null>(null)
  const pointerRef = useRef({ x: 48, y: 42 })
  const [mouse, setMouse] = useState({ x: 72, y: 0 })
  const [pointer, setPointer] = useState({ x: 48, y: 42 })
  const [dragging, setDragging] = useState(false)
  const [pressed, setPressed] = useState(false)

  function setCursor(next: { x: number; y: number }) {
    pointerRef.current = next
    setPointer(next)
  }

  function clickThrough() {
    const screen = screenRef.current
    if (!screen) return
    const box = screen.getBoundingClientRect()
    const x = box.left + (pointerRef.current.x / 100) * box.width
    const y = box.top + (pointerRef.current.y / 100) * box.height
    const hit = document.elementFromPoint(x, y)
    if (!(hit instanceof HTMLElement)) return
    if (hit.closest('.desk-mouse')) return
    hit.click()
  }

  function onDeskPointerMove(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    const desk = deskRef.current
    if (!drag || !desk || event.pointerId !== drag.pointerId) return
    const dx = event.clientX - drag.lastX
    const dy = event.clientY - drag.lastY
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    drag.moved += Math.abs(dx) + Math.abs(dy)
    const box = desk.getBoundingClientRect()
    setMouse({
      x: Math.min(84, Math.max(8, ((event.clientX - 18 - box.left) / box.width) * 100)),
      y: Math.min(24, Math.max(0, ((box.bottom - event.clientY - 22) / box.height) * 100)),
    })
    setCursor({
      x: Math.min(96, Math.max(3, pointerRef.current.x + (dx / box.width) * 160)),
      y: Math.min(94, Math.max(3, pointerRef.current.y + (dy / box.height) * 160)),
    })
  }

  function onMousePointerDown(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    void playBoot()
    setPressed(true)
    setDragging(true)
    dragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: 0,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onMousePointerUp(event: PointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return
    const wasClick = (dragRef.current.moved || 0) < 10
    dragRef.current = null
    setDragging(false)
    setPressed(false)
    void playClick()
    if (wasClick) clickThrough()
  }

  return (
    <main
      ref={deskRef}
      className="desk-root"
      onPointerMove={onDeskPointerMove}
      onPointerDown={() => {
        void playBoot()
      }}
    >
      <section className="crt-chassis">
        <div className="crt-bezel">
          <div
            ref={screenRef}
            className={phosphor ? 'crt-glass crt-glass-phosphor' : wallpaper ? 'crt-glass crt-glass-wallpaper' : 'crt-glass'}
          >
            <div className="crt-scanlines" aria-hidden="true" />
            <div className="crt-screen-body">{children}</div>
            <span className="crt-pointer" style={{ left: `${pointer.x}%`, top: `${pointer.y}%` }} aria-hidden="true" />
          </div>
        </div>
        <div className="crt-badge">
          <span>FORGE</span>
          <span>486DX</span>
        </div>
      </section>
      <div className="desk-keyboard" aria-hidden="true">
        {Array.from({ length: 28 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <button
        type="button"
        className={dragging ? 'desk-mouse desk-mouse-drag' : 'desk-mouse'}
        style={{ left: `${mouse.x}%`, bottom: `${8 + mouse.y}%` }}
        aria-label="Computer mouse. Drag to move the pointer, tap to click."
        onPointerDown={onMousePointerDown}
        onPointerUp={onMousePointerUp}
        onPointerCancel={onMousePointerUp}
      >
        <span className={pressed ? 'desk-mouse-btn desk-mouse-btn-down' : 'desk-mouse-btn'} />
      </button>
      {caption ? <p className="desk-caption">{caption}</p> : null}
    </main>
  )
}
