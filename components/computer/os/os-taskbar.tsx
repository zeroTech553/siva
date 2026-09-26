'use client'

/**
 * os-taskbar.tsx — the bar at the bottom of the desktop.
 *
 *   Start button   toggles the Start menu (data-zos-menu-anchor keeps the menu's
 *                  outside-click handler from immediately reopening it)
 *   task buttons   one per open window; clicking the active one minimizes it,
 *                  clicking any other restores + focuses it — the 90s toggle
 *   tray           connection pills and the clock
 *
 * Task buttons scroll sideways instead of shrinking into nothing, because on a
 * phone there is room for about three of them.
 */

import type { ReactNode } from 'react'

import { playClick } from '@/lib/client/zero-sound'

import { OsSprite } from './os-ui'
import type { OsWindow } from './window-manager'

export type TaskbarTask = {
  window: OsWindow
  sprite?: string
  label: string
}

export function OsTaskbar({
  startOpen,
  onToggleStart,
  tasks,
  activeId,
  onSelect,
  clock,
  tray,
  brand = 'Zero',
}: {
  startOpen: boolean
  onToggleStart(): void
  tasks: TaskbarTask[]
  activeId: string | null
  onSelect(window: OsWindow): void
  clock: string
  tray?: ReactNode
  brand?: string
}) {
  return (
    <div className="zos-taskbar">
      <button
        type="button"
        className={`zos-start${startOpen ? ' zos-start-open' : ''}`}
        data-zos-menu-anchor="start"
        aria-expanded={startOpen}
        aria-label="Start menu"
        onClick={() => {
          void playClick()
          onToggleStart()
        }}
      >
        <span className="zos-start-mark" aria-hidden="true" />
        <span className="zos-start-text">{brand}</span>
      </button>

      <div className="zos-tasks">
        {tasks.map((task) => {
          const isActive = task.window.id === activeId && !task.window.minimized
          return (
            <button
              key={task.window.id}
              type="button"
              className={`zos-task${isActive ? ' zos-task-active' : ''}${task.window.minimized ? ' zos-task-min' : ''}`}
              aria-pressed={isActive}
              title={task.window.title}
              onClick={() => {
                void playClick()
                onSelect(task.window)
              }}
            >
              {task.sprite ? <OsSprite name={task.sprite} size={11} /> : null}
              <span className="zos-task-label">{task.label}</span>
            </button>
          )
        })}
      </div>

      <div className="zos-tray">
        {tray}
        <span className="zos-clock">{clock}</span>
      </div>
    </div>
  )
}
