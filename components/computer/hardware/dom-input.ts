/**
 * dom-input.ts — the small amount of DOM plumbing that makes the on-screen
 * keyboard and mouse behave like real hardware.
 *
 * Everything here is a side effect on the page, kept out of the components so
 * the components stay readable:
 *
 *   typeIntoFocusedField()  a key press reaches the focused input/textarea,
 *                           using React's own value setter so onChange fires
 *   sendKeyToFocused()      a key press reaches a non-input listener (xterm.js
 *                           reads keyCode off the event, so we set it by hand)
 *   clickAtPoint()          the mouse's left button, at CRT coordinates
 *   contextMenuAtPoint()    the mouse's right button
 *   scrollAtPoint()         the mouse wheel
 */

import type { HardwareKeyEvent } from './key-bus'

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}

export function isEditable(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return false
  if (element.disabled || element.readOnly) return false
  if (element instanceof HTMLInputElement) {
    return ['text', 'search', 'url', 'tel', 'password', 'number', 'email', ''].includes(element.type)
  }
  return true
}

export function isContentEditable(element: Element | null): boolean {
  return Boolean(element instanceof HTMLElement && element.isContentEditable)
}

function keyCodeFor(event: HardwareKeyEvent): number {
  if (event.code) {
    if (event.code.startsWith('Key')) return event.code.charCodeAt(3) - 32 + 65
    if (event.code.startsWith('Digit')) return Number(event.code.slice(5)) + 48
  }
  if (event.key.length === 1) return event.key.toUpperCase().charCodeAt(0)
  return KEY_CODES[event.key] ?? 0
}

function keyboardEvent(type: string, event: HardwareKeyEvent): KeyboardEvent {
  const init: KeyboardEventInit = {
    key: event.key,
    code: event.code ?? '',
    bubbles: true,
    cancelable: true,
    shiftKey: Boolean(event.shift),
    ctrlKey: Boolean(event.ctrl),
    altKey: Boolean(event.alt),
  }
  const synthetic = new KeyboardEvent(type, init)
  const keyCode = keyCodeFor(event)
  // xterm.js (and some legacy listeners) still read keyCode/which.
  Object.defineProperty(synthetic, 'keyCode', { get: () => keyCode })
  Object.defineProperty(synthetic, 'which', { get: () => keyCode })
  return synthetic
}

/**
 * Type one key into the focused field. Returns true when the key was consumed
 * here, false when the caller should also broadcast it on the key bus.
 */
export function typeIntoFocusedField(key: string, event?: HardwareKeyEvent): boolean {
  const element = document.activeElement
  if (!isEditable(element)) return false

  if (key === 'Enter' || key === 'Tab' || key === 'Escape') {
    element.dispatchEvent(keyboardEvent('keydown', event ?? { key, source: 'hardware' }))
    if (key === 'Enter') {
      const form = element.form
      if (form) form.requestSubmit?.()
    }
    return true
  }

  const isTextArea = element instanceof HTMLTextAreaElement
  const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const start = element.selectionStart ?? element.value.length
  const end = element.selectionEnd ?? element.value.length

  let next = element.value
  if (key === 'Backspace') {
    next = start === end ? element.value.slice(0, Math.max(0, start - 1)) + element.value.slice(end)
      : element.value.slice(0, start) + element.value.slice(end)
  } else if (key === 'Delete') {
    next = element.value.slice(0, start) + element.value.slice(Math.min(element.value.length, end + 1))
  } else if (key.length === 1) {
    next = element.value.slice(0, start) + key + element.value.slice(end)
  } else {
    element.dispatchEvent(keyboardEvent('keydown', event ?? { key, source: 'hardware' }))
    return true
  }

  setter?.call(element, next)
  const caret = key === 'Backspace' ? Math.max(0, start - (start === end ? 1 : 0)) : start + key.length
  element.dispatchEvent(new Event('input', { bubbles: true }))
  try {
    element.setSelectionRange(caret, caret)
  } catch {
    // number/email inputs reject setSelectionRange; the value is still set.
  }
  return true
}

/** Broadcast a key to non-input listeners (xterm.js, games, the demo terminal). */
export function sendKeyToFocused(event: HardwareKeyEvent) {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  target?.dispatchEvent(keyboardEvent('keydown', event))
  target?.dispatchEvent(keyboardEvent('keyup', event))
}

export function clickAtPoint(x: number, y: number, options: { button?: number } = {}): boolean {
  const hit = document.elementFromPoint(x, y)
  if (!(hit instanceof HTMLElement)) return false
  if (hit.closest('[data-zc-ignore-click]')) return false
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: options.button ?? 0,
  }
  hit.dispatchEvent(new MouseEvent('pointerdown', { ...init, pointerId: 1, isPrimary: true } as PointerEventInit))
  hit.dispatchEvent(new MouseEvent('pointerup', { ...init, pointerId: 1, isPrimary: true } as PointerEventInit))
  hit.dispatchEvent(new MouseEvent('click', init))
  return true
}

export function contextMenuAtPoint(x: number, y: number): boolean {
  const hit = document.elementFromPoint(x, y)
  if (!(hit instanceof HTMLElement)) return false
  if (hit.closest('[data-zc-ignore-click]')) return false
  hit.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 2 }),
  )
  return true
}

export function scrollAtPoint(x: number, y: number, deltaY: number): boolean {
  const hit = document.elementFromPoint(x, y)
  if (!(hit instanceof HTMLElement)) return false
  hit.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, deltaY }),
  )
  return true
}
