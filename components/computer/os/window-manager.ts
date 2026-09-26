/**
 * Zero OS window manager — a pure state machine.
 *
 * There is no React, no DOM and no timers in this file: it is
 * `(state, action) => state`, which is what makes it unit-testable
 * (`tests/window-manager.test.mjs`) and easy to reason about.
 *
 * Geometry is expressed in PERCENT of the desktop area (0..100 on both axes)
 * so a window keeps its place when the CRT is resized between a phone and a
 * laptop. The desktop area is the space above the taskbar; the taskbar is not
 * part of it.
 *
 *   x, y = top-left corner   w, h = size   z = paint order (higher = on top)
 *
 * Every action returns a NEW state object; nothing is mutated in place.
 */

export type WindowRect = {
  x: number
  y: number
  w: number
  h: number
}

export type OsWindow = WindowRect & {
  /** Unique window id (`w1`, `w2`, …). */
  id: string
  /** Which app this window shows; used for single-instance reuse. */
  appId: string
  title: string
  /** Optional icon URL drawn in the title bar and on the taskbar. */
  icon: string
  z: number
  minimized: boolean
  maximized: boolean
  /** Geometry to return to when a maximized window is restored. */
  restored: WindowRect
}

export type WmState = {
  windows: OsWindow[]
  /** Window that has focus, or null when the desktop itself has focus. */
  activeId: string | null
  /** Monotonic z counter — focusing a window assigns `z = ++zTop`. */
  zTop: number
  /** Monotonic window counter — keeps ids stable and unique. */
  nextId: number
}

export type WmAction =
  | {
      type: 'open'
      appId: string
      title: string
      icon?: string
      rect?: Partial<WindowRect>
      /** Reuse an existing window for the same appId (default true). */
      singleton?: boolean
    }
  | { type: 'close'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'focusDesktop' }
  | { type: 'minimize'; id: string }
  | { type: 'toggleMaximize'; id: string }
  | { type: 'move'; id: string; x: number; y: number }
  | { type: 'resize'; id: string; w: number; h: number }
  | { type: 'rename'; id: string; title: string }
  | { type: 'cascade' }
  | { type: 'tile' }
  | { type: 'minimizeAll' }
  | { type: 'restoreAll' }
  | { type: 'cycle' }

/** Default window size, in percent of the desktop area. */
export const DEFAULT_RECT: WindowRect = { x: 8, y: 8, w: 62, h: 66 }
/** A window can never be dragged or resized smaller than this. */
export const MIN_RECT: WindowRect = { x: 0, y: 0, w: 34, h: 26 }
/** Offset between successive cascade positions. */
export const CASCADE_STEP = 5

export function initialWmState(): WmState {
  return { windows: [], activeId: null, zTop: 1, nextId: 1 }
}

/**
 * Keep a window usable: at least MIN_RECT of it stays on screen, so the title
 * bar can always be grabbed again and the close button is always reachable.
 */
export function clampRect(rect: WindowRect): WindowRect {
  const w = clamp(rect.w, MIN_RECT.w, 100)
  const h = clamp(rect.h, MIN_RECT.h, 100)
  return {
    w,
    h,
    x: clamp(rect.x, MIN_RECT.w - w, 100 - MIN_RECT.w),
    y: clamp(rect.y, 0, 100 - MIN_RECT.h),
  }
}

/** Where the next opened window appears: a cascade down-right from the corner. */
export function cascadeRect(index: number, rect: WindowRect = DEFAULT_RECT): WindowRect {
  const step = (index % 6) * CASCADE_STEP
  return clampRect({ ...rect, x: 4 + step, y: 3 + step })
}

/** Side-by-side columns for every visible window (Start ▸ Tile). */
export function tileRects(count: number): WindowRect[] {
  const visible = Math.max(count, 1)
  const columns = Math.ceil(Math.sqrt(visible))
  const rows = Math.ceil(visible / columns)
  const rects: WindowRect[] = []
  for (let index = 0; index < visible; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    rects.push(
      clampRect({
        x: column * (100 / columns),
        y: row * (100 / rows),
        w: 100 / columns,
        h: 100 / rows,
      }),
    )
  }
  return rects
}

export function windowsByZ(state: WmState): OsWindow[] {
  return [...state.windows].sort((a, b) => a.z - b.z)
}

export function visibleWindows(state: WmState): OsWindow[] {
  return windowsByZ(state).filter((window) => !window.minimized)
}

export function findWindow(state: WmState, id: string | null): OsWindow | undefined {
  if (!id) return undefined
  return state.windows.find((window) => window.id === id)
}

/** The window that should take focus after one is minimized or closed. */
function nextFocus(state: WmState, ignoreId: string): string | null {
  const candidates = state.windows
    .filter((window) => window.id !== ignoreId && !window.minimized)
    .sort((a, b) => b.z - a.z)
  return candidates[0]?.id ?? null
}

export function reduceWindows(state: WmState, action: WmAction): WmState {
  switch (action.type) {
    case 'open': {
      const singleton = action.singleton !== false
      if (singleton) {
        const existing = state.windows.find((window) => window.appId === action.appId)
        if (existing) return reduceWindows(state, { type: 'focus', id: existing.id })
      }
      const id = `w${state.nextId}`
      const rect = clampRect({ ...DEFAULT_RECT, ...action.rect })
      const placed = action.rect ? rect : cascadeRect(state.windows.length, rect)
      const zTop = state.zTop + 1
      const window: OsWindow = {
        id,
        appId: action.appId,
        title: action.title,
        icon: action.icon ?? '',
        z: zTop,
        minimized: false,
        maximized: false,
        restored: placed,
        ...placed,
      }
      return { ...state, windows: [...state.windows, window], activeId: id, zTop, nextId: state.nextId + 1 }
    }

    case 'close': {
      const windows = state.windows.filter((window) => window.id !== action.id)
      if (windows.length === state.windows.length) return state
      return {
        ...state,
        windows,
        activeId: state.activeId === action.id ? nextFocus(state, action.id) : state.activeId,
      }
    }

    case 'focus': {
      const target = findWindow(state, action.id)
      if (!target) return state
      if (state.activeId === target.id && !target.minimized && target.z === state.zTop) return state
      const zTop = state.zTop + 1
      return {
        ...state,
        zTop,
        activeId: target.id,
        windows: state.windows.map((window) =>
          window.id === target.id ? { ...window, z: zTop, minimized: false } : window,
        ),
      }
    }

    case 'focusDesktop':
      return state.activeId === null ? state : { ...state, activeId: null }

    case 'minimize': {
      const target = findWindow(state, action.id)
      if (!target || target.minimized) return state
      return {
        ...state,
        activeId: state.activeId === target.id ? nextFocus(state, target.id) : state.activeId,
        windows: state.windows.map((window) =>
          window.id === target.id ? { ...window, minimized: true } : window,
        ),
      }
    }

    case 'toggleMaximize': {
      const target = findWindow(state, action.id)
      if (!target) return state
      const zTop = state.zTop + 1
      const next = target.maximized
        ? { ...target, maximized: false, ...target.restored, z: zTop }
        : {
            ...target,
            maximized: true,
            restored: { x: target.x, y: target.y, w: target.w, h: target.h },
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            z: zTop,
          }
      return {
        ...state,
        zTop,
        activeId: target.id,
        windows: state.windows.map((window) => (window.id === target.id ? next : window)),
      }
    }

    case 'move': {
      const target = findWindow(state, action.id)
      if (!target || target.maximized) return state
      const rect = clampRect({ ...target, x: action.x, y: action.y })
      return {
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id ? { ...window, x: rect.x, y: rect.y } : window,
        ),
      }
    }

    case 'resize': {
      const target = findWindow(state, action.id)
      if (!target || target.maximized) return state
      const rect = clampRect({ ...target, w: action.w, h: action.h })
      return {
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id ? { ...window, w: rect.w, h: rect.h } : window,
        ),
      }
    }

    case 'rename':
      return {
        ...state,
        windows: state.windows.map((window) =>
          window.id === action.id ? { ...window, title: action.title } : window,
        ),
      }

    case 'cascade': {
      let index = 0
      return {
        ...state,
        windows: state.windows.map((window) => {
          if (window.minimized) return window
          const rect = cascadeRect(index, { w: window.w, h: window.h, x: 0, y: 0 })
          index += 1
          return { ...window, maximized: false, restored: rect, ...rect }
        }),
      }
    }

    case 'tile': {
      const shown = state.windows.filter((window) => !window.minimized)
      const rects = tileRects(shown.length)
      let index = 0
      return {
        ...state,
        windows: state.windows.map((window) => {
          if (window.minimized) return window
          const rect = rects[index] ?? cascadeRect(index)
          index += 1
          return { ...window, maximized: false, restored: rect, ...rect }
        }),
      }
    }

    case 'minimizeAll':
      return {
        ...state,
        activeId: null,
        windows: state.windows.map((window) => (window.minimized ? window : { ...window, minimized: true })),
      }

    case 'restoreAll': {
      const zTop = state.zTop + state.windows.length
      let step = 0
      return {
        ...state,
        zTop,
        windows: state.windows.map((window) => {
          step += 1
          return window.minimized ? { ...window, minimized: false, z: state.zTop + step } : window
        }),
      }
    }

    case 'cycle': {
      // Alt+Tab. Naively "focus the next window in z order" only ever toggles
      // between the two most recent windows, because focusing RAISES z. So this
      // rotates instead: the current top window is sent to the bottom of the
      // stack and the window underneath it takes focus. Every window is visited
      // in turn, and the focused one is always the one painted on top.
      const ordered = [...state.windows].sort((a, b) => b.z - a.z) // top first
      if (ordered.length < 2) return state
      const demoted = ordered[0]!
      const nextTop = ordered[1]!
      const bottomZ = Math.min(...state.windows.map((window) => window.z)) - 1
      const zTop = state.zTop + 1
      return {
        ...state,
        zTop,
        activeId: nextTop.id,
        windows: state.windows.map((window) => {
          if (window.id === demoted.id) return { ...window, z: bottomZ }
          if (window.id === nextTop.id) return { ...window, z: zTop, minimized: false }
          return window
        }),
      }
    }

    default:
      return state
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), Math.max(min, max))
}
