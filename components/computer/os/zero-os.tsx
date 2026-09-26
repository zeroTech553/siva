'use client'

/**
 * zero-os.tsx — the desktop: icons, windows, taskbar, Start menu, shutdown.
 *
 * This file is the *shell* of Zero OS. It owns no app behaviour at all: the
 * apps it shows come in through the `apps` prop, which is how the same OS runs
 * a demo desktop on the landing page and the real terminal/agent/files on
 * /console.
 *
 * Window state is `useWindowManager()` (a pure reducer, see window-manager.ts):
 *
 *   open / close      apps are single-instance — opening a running app focuses it
 *   focus             z-order: focusing assigns z = ++zTop, so paint order is state
 *   minimize          hides the window, focuses the next one down the stack
 *   maximize          fills the desktop area; double-clicking the title bar toggles
 *   cascade / tile    Start menu and desktop right-click menu arrangements
 *   taskbar toggle    clicking the active task minimizes it, any other focuses it
 *
 * Keyboard, from the machine's physical board (hardware/key-bus.ts):
 *   ZERO key   Start menu      ALT+TAB   next window      ESC   close a menu
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ZeroLogo } from '../zero-logo'
import { useHardwareKeys } from '../hardware/use-hardware-keys'
import { playClick, playDing, playWindowOpen } from '@/lib/client/zero-sound'

import { OsMenu, type OsMenuItem } from './os-menu'
import { OsShutdownDialog, type ShutdownChoice } from './os-shutdown'
import { OsTaskbar, type TaskbarTask } from './os-taskbar'
import { OsWindowFrame } from './os-window'
import { OsSprite } from './os-ui'
import { useWindowManager } from './use-window-manager'
import type { WindowRect } from './window-manager'

/**
 * Apps run inside the window manager but are declared outside it, so they need
 * a way to open another window (`open terminal` in the demo shell, "Connect"
 * from the About window). This context is that wire — one provider in ZeroOs,
 * `useOsApp()` anywhere below it.
 */
export type OsAppApi = {
  openApp(appId: string): void
  closeApp(appId: string): void
  isOpen(appId: string): boolean
}

const OsAppContext = createContext<OsAppApi | null>(null)

export function useOsApp(): OsAppApi | null {
  return useContext(OsAppContext)
}

export type OsApp = {
  /** Stable id; also the window-manager appId (apps are single-instance). */
  id: string
  title: string
  /** Short label for the taskbar button. */
  short: string
  /** Pixel-art sprite name in public/sprites/ (see pixel/sprites.mjs). */
  sprite?: string
  body: ReactNode
  status?: string
  /** Open automatically once the desktop appears. */
  autostart?: boolean
  /** Also show an icon on the desktop. Default true. */
  desktopIcon?: boolean
  rect?: Partial<WindowRect>
}

export function ZeroOs({
  apps,
  hostname = 'ZERO-PC',
  brand = 'Zero OS',
  tray,
  onShutdown,
  onRestart,
  onNotice,
}: {
  apps: OsApp[]
  hostname?: string
  brand?: string
  /** Extra tray content (connection pills) rendered before the clock. */
  tray?: ReactNode
  /** The machine powers off (see hardware/use-machine.ts). */
  onShutdown?: () => void
  /** The machine reboots from the firmware POST. */
  onRestart?: () => void
  /** Transient message for the machine's on-screen display. */
  onNotice?: (message: string) => void
}) {
  const wm = useWindowManager()
  const areaRef = useRef<HTMLDivElement>(null)
  const [startOpen, setStartOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [shutdownOpen, setShutdownOpen] = useState(false)
  const [clock, setClock] = useState('--:--')

  const appById = useMemo(() => new Map(apps.map((app) => [app.id, app])), [apps])

  const openApp = (id: string) => {
    const app = appById.get(id)
    if (!app) return
    const wasOpen = wm.isOpen(id)
    wm.open(id, app.title, { rect: app.rect })
    if (!wasOpen) void playWindowOpen()
  }

  // -- autostart (once; the window manager makes a second call a no-op) --------
  useEffect(() => {
    for (const app of apps) {
      if (app.autostart) wm.open(app.id, app.title, { rect: app.rect })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- tray clock -------------------------------------------------------------
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    tick()
    const timer = window.setInterval(tick, 15000)
    return () => window.clearInterval(timer)
  }, [])

  // -- the machine's keyboard -------------------------------------------------
  useHardwareKeys((event) => {
    if (event.key === 'Meta') {
      setStartOpen((open) => !open)
      return
    }
    if (event.key === 'Tab' && event.alt) {
      wm.cycle()
      return
    }
    if (event.key === 'Escape') {
      setStartOpen(false)
      setContextMenu(null)
    }
  })

  const tasks: TaskbarTask[] = wm.state.windows.map((window) => ({
    window,
    sprite: appById.get(window.appId)?.sprite,
    label: appById.get(window.appId)?.short || window.title,
  }))

  const desktopItems: OsMenuItem[] = [
    ...apps
      .filter((app) => app.desktopIcon !== false)
      .map((app) => ({
        id: `open-${app.id}`,
        label: app.title,
        sprite: app.sprite,
        onClick: () => openApp(app.id),
      })),
    { id: 'd1', divider: true },
    { id: 'cascade', label: 'Cascade windows', onClick: () => wm.cascade() },
    { id: 'tile', label: 'Tile windows', onClick: () => wm.tile() },
    { id: 'minimize-all', label: 'Minimize all', onClick: () => wm.minimizeAll() },
    { id: 'restore-all', label: 'Restore all', onClick: () => wm.restoreAll() },
    { id: 'd2', divider: true },
    {
      id: 'shutdown',
      label: 'Shut Down…',
      onClick: () => setShutdownOpen(true),
    },
  ]

  const startItems: OsMenuItem[] = [
    ...apps.map((app) => ({
      id: `start-${app.id}`,
      label: app.title,
      sprite: app.sprite,
      onClick: () => openApp(app.id),
    })),
    { id: 's1', divider: true },
    {
      id: 'arrange',
      label: 'Arrange windows',
      hint: `${wm.visible.length} open`,
      onClick: () => wm.cascade(),
    },
    { id: 's2', divider: true },
    { id: 'shutdown', label: 'Shut Down…', onClick: () => setShutdownOpen(true) },
  ]

  const appApi = useMemo<OsAppApi>(
    () => ({
      openApp,
      closeApp: (appId: string) => {
        const window = wm.state.windows.find((item) => item.appId === appId)
        if (window) wm.close(window.id)
      },
      isOpen: (appId: string) => wm.isOpen(appId),
    }),
    // openApp/wm change identity per render; the API object is cheap to rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wm.state.windows],
  )

  function confirmShutdown(choice: ShutdownChoice) {
    setShutdownOpen(false)
    if (choice === 'restart') {
      onRestart?.()
      return
    }
    onShutdown?.()
  }

  return (
    <OsAppContext.Provider value={appApi}>
      <div className="zos-desktop" data-host={hostname}>
        <div
          ref={areaRef}
          className="zos-desktop-area"
          onPointerDown={() => {
            wm.focusDesktop()
            setStartOpen(false)
            setContextMenu(null)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            const box = areaRef.current?.getBoundingClientRect()
            if (!box) return
            setStartOpen(false)
            setContextMenu({
              x: ((event.clientX - box.left) / box.width) * 100,
              y: ((event.clientY - box.top) / box.height) * 100,
            })
          }}
        >
          <div className="zos-icons">
            {apps
              .filter((app) => app.desktopIcon !== false)
              .map((app) => (
                <button
                  key={app.id}
                  type="button"
                  className="zos-icon"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    void playClick()
                    openApp(app.id)
                  }}
                >
                  {app.sprite ? <OsSprite name={app.sprite} size={22} /> : <span className="zos-icon-tile" aria-hidden="true" />}
                  <span className="zos-icon-label">{app.short}</span>
                </button>
              ))}
          </div>

          <span className="zos-desktop-mark" aria-hidden="true">
            <ZeroLogo scale={1} />
            <em>{hostname}</em>
          </span>

          {wm.ordered.map((window) => {
            if (window.minimized) return null
            const app = appById.get(window.appId)
            return (
              <OsWindowFrame
                key={window.id}
                window={window}
                active={window.id === wm.state.activeId}
                sprite={app?.sprite}
                status={app?.status}
                areaRef={areaRef}
                onFocus={() => wm.focus(window.id)}
                onClose={() => wm.close(window.id)}
                onMinimize={() => wm.minimize(window.id)}
                onToggleMaximize={() => wm.toggleMaximize(window.id)}
                onMove={(x, y) => wm.move(window.id, x, y)}
                onResize={(w, h) => wm.resize(window.id, w, h)}
              >
                <div className="zos-app" onPointerDown={(event) => event.stopPropagation()}>
                  {app?.body}
                </div>
              </OsWindowFrame>
            )
          })}

          {startOpen ? (
            <OsMenu items={startItems} variant="start" brand={brand} onClose={() => setStartOpen(false)} />
          ) : null}
          {contextMenu ? (
            <OsMenu items={desktopItems} variant="context" position={contextMenu} onClose={() => setContextMenu(null)} />
          ) : null}
        </div>

        <OsTaskbar
          startOpen={startOpen}
          onToggleStart={() => setStartOpen((open) => !open)}
          tasks={tasks}
          activeId={wm.state.activeId}
          clock={clock}
          tray={tray}
          brand={brand}
          onSelect={(window) => {
            if (window.id === wm.state.activeId && !window.minimized) wm.minimize(window.id)
            else wm.focus(window.id)
          }}
        />

        <OsShutdownDialog open={shutdownOpen} onConfirm={confirmShutdown} onCancel={() => setShutdownOpen(false)} />

        <button
          type="button"
          className="zos-about"
          aria-label="About this machine"
          onClick={() => {
            void playDing()
            onNotice?.(`${brand} · ${hostname}`)
          }}
        >
          ?
        </button>
      </div>
    </OsAppContext.Provider>
  )
}
