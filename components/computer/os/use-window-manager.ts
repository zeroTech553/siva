'use client'

/**
 * use-window-manager.ts — the React binding for the window manager.
 *
 * All logic lives in `window-manager.ts` (pure, unit-tested). This file is only
 * `useReducer` plus the derived views the desktop needs, so a component never
 * has to sort or filter windows itself.
 */

import { useCallback, useMemo, useReducer } from 'react'

import {
  findWindow,
  initialWmState,
  reduceWindows,
  visibleWindows,
  windowsByZ,
  type OsWindow,
  type WmAction,
  type WmState,
} from './window-manager'

export type WindowManager = {
  state: WmState
  dispatch: (action: WmAction) => void
  /** Paint order, back to front. */
  ordered: OsWindow[]
  /** Paint order, minimized windows excluded. */
  visible: OsWindow[]
  active: OsWindow | null
  isOpen(appId: string): boolean
  open(appId: string, title: string, options?: { icon?: string; rect?: Partial<{ x: number; y: number; w: number; h: number }> }): void
  close(id: string): void
  focus(id: string): void
  minimize(id: string): void
  toggleMaximize(id: string): void
  move(id: string, x: number, y: number): void
  resize(id: string, w: number, h: number): void
  rename(id: string, title: string): void
  cascade(): void
  tile(): void
  minimizeAll(): void
  restoreAll(): void
  cycle(): void
  focusDesktop(): void
}

export function useWindowManager(): WindowManager {
  const [state, dispatch] = useReducer(reduceWindows, undefined, initialWmState)

  const ordered = useMemo(() => windowsByZ(state), [state])
  const visible = useMemo(() => visibleWindows(state), [state])
  const active = findWindow(state, state.activeId) ?? null

  const open = useCallback(
    (
      appId: string,
      title: string,
      options: { icon?: string; rect?: Partial<{ x: number; y: number; w: number; h: number }> } = {},
    ) => {
      dispatch({ type: 'open', appId, title, icon: options.icon ?? '', rect: options.rect })
    },
    [],
  )

  return {
    state,
    dispatch,
    ordered,
    visible,
    active,
    isOpen: (appId: string) => state.windows.some((window) => window.appId === appId),
    open,
    close: (id) => dispatch({ type: 'close', id }),
    focus: (id) => dispatch({ type: 'focus', id }),
    minimize: (id) => dispatch({ type: 'minimize', id }),
    toggleMaximize: (id) => dispatch({ type: 'toggleMaximize', id }),
    move: (id, x, y) => dispatch({ type: 'move', id, x, y }),
    resize: (id, w, h) => dispatch({ type: 'resize', id, w, h }),
    rename: (id, title) => dispatch({ type: 'rename', id, title }),
    cascade: () => dispatch({ type: 'cascade' }),
    tile: () => dispatch({ type: 'tile' }),
    minimizeAll: () => dispatch({ type: 'minimizeAll' }),
    restoreAll: () => dispatch({ type: 'restoreAll' }),
    cycle: () => dispatch({ type: 'cycle' }),
    focusDesktop: () => dispatch({ type: 'focusDesktop' }),
  }
}
