'use client'

import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { playBoot, playClick, playDisk, playError, playPower, resetBoot, stopSong } from '@/lib/desk-sound'

const KEY_ROWS: Array<Array<{ key: string; label: string; span?: number }>> = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((key) => ({ key, label: key })),
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'].map((key) => ({ key, label: key })),
  [
    ...['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'].map((key) => ({ key, label: key })),
    { key: 'Backspace', label: 'BS' },
  ],
  [
    { key: ' ', label: 'SPACE', span: 7 },
    { key: 'Enter', label: 'ENT', span: 3 },
  ],
]

type DeskComputerProps = {
  children: ReactNode
  phosphor?: boolean
  caption?: string
  wallpaper?: boolean
  busy?: boolean
  onCd?: () => void
  onReset?: () => void
}

export function DeskComputer({
  children,
  phosphor = false,
  caption,
  wallpaper = false,
  busy = false,
  onCd,
  onReset,
}: DeskComputerProps) {
  const deskRef = useRef<HTMLElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number; moved: number } | null>(null)
  const pointerRef = useRef({ x: 48, y: 42 })
  const [mouse, setMouse] = useState({ x: 78, y: 49 })
  const [pointer, setPointer] = useState({ x: 48, y: 42 })
  const [dragging, setDragging] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [powered, setPowered] = useState(true)
  const [brightness, setBrightness] = useState(1)
  const [cdOpen, setCdOpen] = useState(false)
  const [floppyFlash, setFloppyFlash] = useState(false)

  function setCursor(next: { x: number; y: number }) {
    pointerRef.current = next
    setPointer(next)
  }

  function clickThrough() {
    if (!powered) return
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
      x: Math.min(86, Math.max(8, ((event.clientX - 18 - box.left) / box.width) * 100)),
      y: Math.min(58, Math.max(0, ((box.bottom - event.clientY - 18) / box.height) * 100)),
    })
    setCursor({
      x: Math.min(96, Math.max(3, pointerRef.current.x + (dx / box.width) * 180)),
      y: Math.min(94, Math.max(3, pointerRef.current.y + (dy / box.height) * 180)),
    })
  }

  function onMousePointerDown(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
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

  function togglePower() {
    void playPower()
    if (powered) {
      resetBoot()
      stopSong()
      setPowered(false)
      return
    }
    setPowered(true)
    void playBoot()
  }

  function resetMachine() {
    void playPower()
    setPowered(true)
    resetBoot()
    void playBoot()
    onReset?.()
  }

  function insertCd() {
    void playDisk()
    setCdOpen((open) => !open)
    if (!cdOpen) onCd?.()
  }

  function punchFloppy() {
    void playDisk()
    void playError()
    setFloppyFlash(true)
    window.setTimeout(() => setFloppyFlash(false), 700)
  }

  function typeKey(key: string) {
    void playClick()
    const el = document.activeElement
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
    if (key === 'Enter') {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const next = key === 'Backspace' ? el.value.slice(0, -1) : el.value + key
    setter?.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const glassClass = phosphor
    ? 'crt-glass crt-glass-phosphor'
    : wallpaper
      ? 'crt-glass crt-glass-wallpaper'
      : 'crt-glass'

  return (
    <main ref={deskRef} className="desk-root" onPointerMove={onDeskPointerMove}>
      <div className="desk-wall" aria-hidden="true">
        <div className="desk-blinds" />
      </div>
      {caption ? <p className="desk-caption">{caption}</p> : null}

      <section className="desk-machines">
        <div className="crt-unit">
          <div className="crt-bezel">
            <div ref={screenRef} className={powered ? glassClass : 'crt-glass crt-glass-off'}>
              {powered ? (
                <>
                  <div className="crt-scanlines" aria-hidden="true" />
                  <div className="crt-screen-body" style={{ filter: `brightness(${brightness})` }}>
                    {children}
                  </div>
                  <span
                    className="crt-pointer"
                    style={{ left: `${pointer.x}%`, top: `${pointer.y}%` }}
                    aria-hidden="true"
                  />
                </>
              ) : (
                <div className="crt-off" />
              )}
            </div>
            <div className="crt-chin">
              <span>FORGE</span>
              <div className="crt-knobs">
                <button
                  type="button"
                  className={powered ? 'crt-knob crt-knob-on' : 'crt-knob'}
                  aria-label="Monitor power"
                  onClick={togglePower}
                />
                <button
                  type="button"
                  className="crt-knob"
                  aria-label="Brightness down"
                  onClick={() => setBrightness((value) => Math.max(0.45, Number((value - 0.15).toFixed(2))))}
                />
                <button
                  type="button"
                  className="crt-knob"
                  aria-label="Brightness up"
                  onClick={() => setBrightness((value) => Math.min(1.35, Number((value + 0.15).toFixed(2))))}
                />
              </div>
            </div>
          </div>
          <div className="crt-stand" aria-hidden="true">
            <span className="crt-neck" />
            <span className="crt-base" />
          </div>
        </div>

        <aside className="tower">
          <p className="tower-brand">486DX</p>
          <button
            type="button"
            className={cdOpen ? 'tower-drive is-open' : 'tower-drive'}
            aria-label={cdOpen ? 'Close CD-ROM tray' : 'Open CD-ROM tray'}
            onClick={insertCd}
          >
            <span className="tower-drive-slot" />
            <span>CD</span>
          </button>
          <button
            type="button"
            className={floppyFlash ? 'tower-drive is-flash' : 'tower-drive'}
            aria-label="Floppy drive"
            onClick={punchFloppy}
          >
            <span className="tower-drive-slot" />
            <span>3.5</span>
          </button>
          <div className="tower-leds">
            <span className={powered ? 'tower-led is-on' : 'tower-led'} title="Power" />
            <span className={busy && powered ? 'tower-led is-hdd' : 'tower-led'} title="Hard disk" />
          </div>
          <button type="button" className="tower-reset" onClick={resetMachine}>
            RST
          </button>
          <button
            type="button"
            className={powered ? 'tower-power is-on' : 'tower-power'}
            aria-label="Computer power"
            onClick={togglePower}
          />
        </aside>
      </section>

      <section className="desk-board">
        <div className="desk-keyboard">
          {KEY_ROWS.map((row, rowIndex) => (
            <div key={rowIndex} className="desk-key-row">
              {row.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="desk-key"
                  style={item.span ? { flex: item.span } : undefined}
                  aria-label={item.key === ' ' ? 'Space' : item.key}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    typeKey(item.key)
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>

      <button
        type="button"
        className={dragging ? 'desk-mouse desk-mouse-drag' : 'desk-mouse'}
        style={{ left: `${mouse.x}%`, bottom: `${6 + mouse.y}%` }}
        aria-label="Computer mouse. Drag to move the pointer, tap to click."
        onPointerDown={onMousePointerDown}
        onPointerUp={onMousePointerUp}
        onPointerCancel={onMousePointerUp}
      >
        <span className={pressed ? 'desk-mouse-btn desk-mouse-btn-down' : 'desk-mouse-btn'} />
      </button>
    </main>
  )
}
