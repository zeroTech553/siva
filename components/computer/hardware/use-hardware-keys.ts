'use client'

import { useEffect, useRef } from 'react'

import { hardwareKeys, type HardwareKeyEvent, type KeyHandler } from './key-bus'

/**
 * Subscribe an app inside the CRT to the machine's physical keyboard.
 *
 * The handler is kept in a ref, so callers can pass an inline closure without
 * re-subscribing (and without losing keystrokes) on every render.
 */
export function useHardwareKeys(handler: KeyHandler, enabled = true) {
  const handlerRef = useRef<KeyHandler>(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled) return
    const unsubscribe = hardwareKeys.subscribe((event: HardwareKeyEvent) => handlerRef.current(event))
    return unsubscribe
  }, [enabled])
}
