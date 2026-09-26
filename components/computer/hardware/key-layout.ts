/**
 * key-layout.ts — the physical key layout, as data.
 *
 * One row is a CSS grid of 60 quarter-units (a full row = 15u, the classic
 * 60 % board), so a cap's `u` value maps exactly to `grid-column: span u*4`.
 * Editing the keyboard means editing this table; keyboard.tsx only renders it.
 *
 *   key    the DOM `key` value emitted on press
 *   code   the DOM `code`, used to light the cap when a REAL key is pressed
 *   label  what is printed on the cap
 *   shift  the shifted glyph (printed above the label, and emitted with Shift)
 *   u      width in key units (multiples of 0.25)
 *   kind   styling hint: modifier, space, navigation or a plain cap
 */

export type KeyKind = 'plain' | 'mod' | 'space' | 'nav'

export type KeyCap = {
  key: string
  code?: string
  label: string
  shift?: string
  u: number
  kind?: KeyKind
}

export const ROW_UNITS = 15
export const GRID_COLUMNS = ROW_UNITS * 4

function cap(key: string, label: string, shift?: string, u = 1, kind?: KeyKind, code?: string): KeyCap {
  return { key, code, label, shift, u, kind }
}

/** Esc + F-row. Hidden on very small screens (`compact` in keyboard.tsx). */
export const FUNCTION_ROW: KeyCap[] = [
  cap('Escape', 'ESC', undefined, 2, 'mod', 'Escape'),
  ...['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11'].map((name) =>
    cap(name, name.replace('F', ''), undefined, 1, 'plain', name),
  ),
  cap('F12', '12', undefined, 2, 'plain', 'F12'),
]

export const KEY_ROWS: KeyCap[][] = [
  [
    cap('`', '`', '~', 1, 'plain', 'Backquote'),
    ...[
      ['1', '!'],
      ['2', '@'],
      ['3', '#'],
      ['4', '$'],
      ['5', '%'],
      ['6', '^'],
      ['7', '&'],
      ['8', '*'],
      ['9', '('],
      ['0', ')'],
    ].map(([digit, symbol]) => cap(digit, digit, symbol, 1, 'plain', `Digit${digit}`)),
    cap('-', '-', '_', 1, 'plain', 'Minus'),
    cap('=', '=', '+', 1, 'plain', 'Equal'),
    cap('Backspace', '⌫', undefined, 2, 'mod', 'Backspace'),
  ],
  [
    cap('Tab', 'TAB', undefined, 1.5, 'mod', 'Tab'),
    ...['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'].map((letter) =>
      cap(letter, letter.toUpperCase(), undefined, 1, 'plain', `Key${letter.toUpperCase()}`),
    ),
    cap('[', '[', '{', 1, 'plain', 'BracketLeft'),
    cap(']', ']', '}', 1, 'plain', 'BracketRight'),
    cap('\\', '\\', '|', 1.5, 'plain', 'Backslash'),
  ],
  [
    cap('CapsLock', 'CAPS', undefined, 1.75, 'mod', 'CapsLock'),
    ...['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'].map((letter) =>
      cap(letter, letter.toUpperCase(), undefined, 1, 'plain', `Key${letter.toUpperCase()}`),
    ),
    cap(';', ';', ':', 1, 'plain', 'Semicolon'),
    cap("'", "'", '"', 1, 'plain', 'Quote'),
    cap('Enter', 'ENTER', undefined, 2.25, 'mod', 'Enter'),
  ],
  [
    cap('Shift', 'SHIFT', undefined, 2.25, 'mod', 'ShiftLeft'),
    ...['z', 'x', 'c', 'v', 'b', 'n', 'm'].map((letter) =>
      cap(letter, letter.toUpperCase(), undefined, 1, 'plain', `Key${letter.toUpperCase()}`),
    ),
    cap(',', ',', '<', 1, 'plain', 'Comma'),
    cap('.', '.', '>', 1, 'plain', 'Period'),
    cap('/', '/', '?', 1, 'plain', 'Slash'),
    cap('Shift', 'SHIFT', undefined, 1.75, 'mod', 'ShiftRight'),
    cap('ArrowUp', '▲', undefined, 1, 'nav', 'ArrowUp'),
  ],
  [
    cap('Control', 'CTRL', undefined, 1.25, 'mod', 'ControlLeft'),
    cap('Meta', 'ZERO', undefined, 1.25, 'mod', 'MetaLeft'),
    cap('Alt', 'ALT', undefined, 1.25, 'mod', 'AltLeft'),
    cap(' ', 'SPACE', undefined, 6, 'space', 'Space'),
    cap('Alt', 'ALT', undefined, 1, 'mod', 'AltRight'),
    cap('ArrowLeft', '◀', undefined, 1, 'nav', 'ArrowLeft'),
    cap('ArrowDown', '▼', undefined, 1, 'nav', 'ArrowDown'),
    cap('ArrowRight', '▶', undefined, 1, 'nav', 'ArrowRight'),
    cap('Control', 'CTRL', undefined, 1, 'mod', 'ControlRight'),
  ],
]

/** Look a cap up by DOM `code` — used to light the cap when a REAL key is hit. */
export function capByCode(code: string): KeyCap | undefined {
  return KEY_ROWS.flat().find((item) => item.code === code) ?? FUNCTION_ROW.find((item) => item.code === code)
}

/** What a cap emits, given the modifier state of the board. */
export function capValue(item: KeyCap, shiftActive: boolean): string {
  if (item.key === ' ') return ' '
  if (!shiftActive) return item.key
  if (item.shift) return item.shift
  if (item.key.length === 1) return item.key.toUpperCase()
  return item.key
}
