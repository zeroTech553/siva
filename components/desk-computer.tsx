'use client'

import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { playBootJingle, playClick } from '@/lib/desk-sound'

type DeskComputerProps = {
  children: ReactNode
  phosphor?: boolean
  caption?: string
  onMouseClick?: () => void
}

export function DeskComputer({ children, phosphor = false, caption, onMouseClick }: DeskComputerProps) {
  const deskRef = useRef<HTMLElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null)
  const [mouse, setMouse] = useState({ x: 78, y: 86 })
  const [pointer, setPointer] = useState({ x: 72, y: 58 })
  const [dragging, setDragging] = useState(false)

  function mapPointer(clientX: number, clientY: number) {
    const screen = screenRef.current
    if (!screen) return
    const box = screen.getBoundingClientRect()
    setPointer({
      x: Math.min(96, Math.max(4, ((clientX - box.left) / box.width) * 100)),
      y: Math.min(96, Math.max(4, ((clientY - box.top) / box.height) * 100)),
    })
  }

  function onDeskPointerMove(event: PointerEvent<HTMLElement>) {
    mapPointer(event.clientX, event.clientY)
    const drag = dragRef.current
    const desk = deskRef.current
    if (!drag || !desk || event.pointerId !== drag.pointerId) return
    const box = desk.getBoundingClientRect()
    setMouse({
      x: Math.min(92, Math.max(4, ((event.clientX - drag.dx - box.left) / box.width) * 100)),
      y: Math.min(92, Math.max(8, ((event.clientY - drag.dy - box.top) / box.height) * 100)),
    })
  }

  function onMousePointerDown(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    void playBootJingle()
    const node = event.currentTarget
    const box = node.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      dx: event.clientX - box.left,
      dy: event.clientY - box.top,
    }
    setDragging(true)
    node.setPointerCapture(event.pointerId)
  }

  function onMousePointerUp(event: PointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    void playClick()
    onMouseClick?.()
  }

  return (
    <main
      ref={deskRef}
      className="desk-root"
      onPointerMove={onDeskPointerMove}
      onPointerDown={() => {
        void playBootJingle()
      }}
    >
      <section className="crt-chassis">
        <div className="crt-bezel">
          <div ref={screenRef} className={phosphor ? 'crt-glass crt-glass-phosphor' : 'crt-glass'}>
            <div className="crt-scanlines" aria-hidden="true" />
            <div className="crt-screen-body">{children}</div>
            <span
              className="crt-pointer"
              style={{ left: `${pointer.x}%`, top: `${pointer.y}%` }}
              aria-hidden="true"
            />
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
        style={{ left: `${mouse.x}%`, top: `${mouse.y}%` }}
        aria-label="Slide the mouse"
        onPointerDown={onMousePointerDown}
        onPointerUp={onMousePointerUp}
        onPointerCancel={onMousePointerUp}
      >
        <span />
      </button>
      {caption ? <p className="desk-caption">{caption}</p> : null}
    </main>
  )
}
