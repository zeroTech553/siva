'use client'

/**
 * keyboard.tsx — a real keyboard, not a picture of one.
 *
 * What makes it real:
 *
 *   • every cap is a <button>; pressing one types into whatever field has focus
 *     inside the CRT (dom-input.typeIntoFocusedField), and reaches non-input
 *     listeners such as xterm.js (dom-input.sendKeyToFocused)
 *   • Shift / Caps / Ctrl / Alt are real modifiers: Shift+a emits 'A', CapsLock
 *     latches, and the shifted glyph printed on the cap is what you get
 *   • the ZERO key (Meta) opens the Start menu, like a real OS key
 *   • typing on a REAL keyboard lights the matching cap here, so the board
 *     always shows what the machine is receiving
 *   • the same key is broadcast on the hardware key bus for apps inside the OS
 *
 * The caps are `tabIndex={-1}` and the board is `aria-hidden`: a screen-reader
 * user should use their own keyboard, and the on-screen board must not add 60
 * tab stops to the page.
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import { playKey } from '@/lib/client/zero-sound'

import { sendKeyToFocused, typeIntoFocusedField } from './dom-input'
import { hardwareKeys, type HardwareKeyEvent } from './key-bus'
import { FUNCTION_ROW, GRID_COLUMNS, KEY_ROWS, capValue, type KeyCap } from './key-layout'

const FLASH_MS = 110

export function MachineKeyboard({
  compact = false,
  functionRow = false,
  disabled = false,
  onMetaKey,
}: {
  /** Drop the board to the smallest usable layout on phones. */
  compact?: boolean
  /** Show the Esc + F-row (never on compact). */
  functionRow?: boolean
  /** Powered off: caps still render, but do nothing. */
  disabled?: boolean
  /** The ZERO/Meta key was pressed — the OS opens its Start menu. */
  onMetaKey?: () => void
}) {
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set())
  const [mirrored, setMirrored] = useState<ReadonlySet<string>>(new Set())
  const [shift, setShift] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  const timers = useRef(new Map<string, number>())

  // React's setter takes a value OR an updater, so the parameter has to be the
  // full Dispatch<SetStateAction<…>> — a plain "(next) => void" won't accept one.
  const setOf =
    (setter: Dispatch<SetStateAction<ReadonlySet<string>>>) =>
    (code: string, on: boolean) => {
    setter((current) => {
      const next = new Set(current)
      if (on) next.add(code)
      else next.delete(code)
      return next
    })
  }
  const flashOn = useCallback(setOf(setFlash), [])
  const mirrorOn = useCallback(setOf(setMirrored), [])

  const flashCap = useCallback(
    (code?: string) => {
      if (!code) return
      flashOn(code, true)
      const existing = timers.current.get(code)
      if (existing) window.clearTimeout(existing)
      timers.current.set(
        code,
        window.setTimeout(() => {
          flashOn(code, false)
          timers.current.delete(code)
        }, FLASH_MS),
      )
    },
    [flashOn],
  )

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
    },
    [],
  )

  // -- mirror the visitor's real keyboard -------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      mirrorOn(event.code, true)
      if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') setShift(true)
      if (event.code === 'ControlLeft' || event.code === 'ControlRight') setCtrl(true)
      if (event.code === 'AltLeft' || event.code === 'AltRight') setAlt(true)
      if (event.code === 'CapsLock') setCapsLock(event.getModifierState?.('CapsLock') ?? true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      mirrorOn(event.code, false)
      if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') setShift(false)
      if (event.code === 'ControlLeft' || event.code === 'ControlRight') setCtrl(false)
      if (event.code === 'AltLeft' || event.code === 'AltRight') setAlt(false)
    }
    const onBlur = () => {
      setMirrored(new Set())
      setShift(false)
      setCtrl(false)
      setAlt(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [mirrorOn])

  // -- press a cap ------------------------------------------------------------
  const press = useCallback(
    (item: KeyCap) => {
      if (disabled) return
      flashCap(item.code)

      const isModifier = item.key === 'Shift' || item.key === 'Control' || item.key === 'Alt' || item.key === 'CapsLock'
      if (item.key === 'Shift') setShift(true)
      if (item.key === 'Control') setCtrl(true)
      if (item.key === 'Alt') setAlt(true)
      if (item.key === 'CapsLock') setCapsLock((value) => !value)
      const shiftActive = (shift || capsLock) && item.key.length === 1
      const key = capValue(item, shiftActive)
      const event: HardwareKeyEvent = { key, code: item.code, shift: shiftActive, ctrl, alt, source: 'screen' }

      void playKey()
      if (!isModifier && item.key !== 'Meta') {
        const consumed = typeIntoFocusedField(key, event)
        if (!consumed) sendKeyToFocused(event)
      }
      hardwareKeys.emit(event)
      // The ZERO key is the OS key: it opens the Start menu, like the Meta key
      // on a real keyboard. Apps can also listen for it on the key bus.
      if (item.key === 'Meta') onMetaKey?.()
    },
    [alt, capsLock, ctrl, disabled, flashCap, onMetaKey, shift],
  )

  const release = useCallback((item: KeyCap) => {
    if (item.key === 'Shift') setShift(false)
    if (item.key === 'Control') setCtrl(false)
    if (item.key === 'Alt') setAlt(false)
  }, [])

  // A finger can slide off a cap; never leave a modifier latched.
  useEffect(() => {
    const clear = () => {
      setShift(false)
      setCtrl(false)
      setAlt(false)
    }
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
    return () => {
      window.removeEventListener('pointerup', clear)
      window.removeEventListener('pointercancel', clear)
    }
  }, [])

  const rows = functionRow && !compact ? [FUNCTION_ROW, ...KEY_ROWS] : KEY_ROWS

  const modifierOn = (item: KeyCap) =>
    (item.key === 'Shift' && shift) ||
    (item.key === 'Control' && ctrl) ||
    (item.key === 'Alt' && alt) ||
    (item.key === 'CapsLock' && capsLock)

  return (
    <div
      className={`zc-keyboard${compact ? ' zc-keyboard-compact' : ''}${disabled ? ' zc-keyboard-off' : ''}`}
      aria-hidden="true"
    >
      <div className="zc-keyboard-frame">
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="zc-key-row"
            style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}
          >
            {row.map((item, itemIndex) => {
              const code = item.code ?? `${item.key}-${itemIndex}`
              const isDown = flash.has(code) || mirrored.has(code) || modifierOn(item)
              return (
                <button
                  key={code}
                  type="button"
                  tabIndex={-1}
                  className={[
                    'zc-key',
                    item.kind === 'mod' ? 'zc-key-mod' : '',
                    item.kind === 'space' ? 'zc-key-space' : '',
                    item.kind === 'nav' ? 'zc-key-nav' : '',
                    isDown ? 'zc-key-down' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ gridColumn: `span ${Math.round(item.u * 4)}` }}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    press(item)
                  }}
                  onPointerUp={() => release(item)}
                  onPointerCancel={() => release(item)}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  {item.shift ? <span className="zc-key-shift">{item.shift}</span> : null}
                  <span className="zc-key-main">{item.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
