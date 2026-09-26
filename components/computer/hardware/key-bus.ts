/**
 * key-bus.ts — the wire between the machine's PHYSICAL keyboard and whatever
 * app is running inside the screen.
 *
 * A real keyboard does two things at once, and so does this one:
 *
 *   1. types into whatever text field has focus (handled in dom-input.ts)
 *   2. sends the key to the OS/apps that listen (this bus)
 *
 * Apps inside the CRT subscribe with `useHardwareKeys()` and receive the same
 * key events whether the visitor tapped the on-screen keyboard, pressed a real
 * key, or clicked a key with the mouse. No React context needed, so the bus
 * works across the window-manager boundary.
 */

export type HardwareKeyEvent = {
  /** DOM `key` value: 'a', 'A', 'Enter', 'Backspace', ' ', 'ArrowUp', 'F1' … */
  key: string
  /** DOM `code` when known: 'KeyA', 'Digit1', 'Space' … */
  code?: string
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  /** Where the press came from — useful for the status readout. */
  source: 'hardware' | 'screen' | 'mirror'
}

export type KeyHandler = (event: HardwareKeyEvent) => void

export type KeyBus = {
  emit(event: HardwareKeyEvent): void
  subscribe(handler: KeyHandler): () => void
  listenerCount(): number
}

export function createKeyBus(): KeyBus {
  const handlers = new Set<KeyHandler>()
  return {
    emit(event) {
      for (const handler of [...handlers]) {
        try {
          handler(event)
        } catch {
          // One broken app must not silence the rest of the machine.
        }
      }
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    listenerCount: () => handlers.size,
  }
}

/**
 * The one bus for the machine on this page. Landing and console each render a
 * single `ZeroComputer`, so a module-level singleton is enough — and it keeps
 * the props shallow.
 */
export const hardwareKeys: KeyBus = createKeyBus()
