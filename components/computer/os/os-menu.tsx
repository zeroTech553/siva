'use client'

/**
 * os-menu.tsx — one menu component, two jobs.
 *
 *   variant="start"    the Start menu, anchored above the taskbar, with the
 *                      vertical brand strip 90s menus had
 *   variant="context"  the desktop right-click menu, positioned where the click
 *                      happened (percentages of the desktop area)
 *
 * Both close on Escape, on a click outside, and after any item is chosen.
 */

import { useEffect, useRef, type CSSProperties } from 'react'

import { playClick } from '@/lib/client/zero-sound'

import { OsSprite } from './os-ui'

export type OsMenuItem = {
  id: string
  label?: string
  hint?: string
  sprite?: string
  divider?: boolean
  onClick?: () => void
}

export function OsMenu({
  items,
  variant = 'start',
  position,
  brand = 'Zero OS',
  onClose,
}: {
  items: OsMenuItem[]
  variant?: 'start' | 'context'
  /** Where a context menu appears, in percent of the desktop area. */
  position?: { x: number; y: number }
  brand?: string
  onClose(): void
}) {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const node = ref.current
      if (!node) return
      if (event.target instanceof Node && node.contains(event.target)) return
      // Let the Start button handle its own toggle so it does not reopen.
      if (event.target instanceof Element && event.target.closest('[data-zos-menu-anchor]')) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const style: CSSProperties | undefined =
    variant === 'context' && position
      ? {
          left: `${Math.min(position.x, 72)}%`,
          top: `${Math.min(position.y, 62)}%`,
        }
      : undefined

  return (
    <nav
      ref={ref}
      className={`zos-menu zos-menu-${variant}`}
      style={style}
      aria-label={variant === 'start' ? 'Start menu' : 'Desktop menu'}
      role="menu"
    >
      {variant === 'start' ? (
        <span className="zos-menu-brand" aria-hidden="true">
          {brand}
        </span>
      ) : null}
      <ul className="zos-menu-list">
        {items.map((item) =>
          item.divider ? (
            <li key={item.id} className="zos-menu-divider" role="separator" />
          ) : (
            <li key={item.id}>
              <button
                type="button"
                role="menuitem"
                className="zos-menu-item"
                onClick={() => {
                  void playClick()
                  item.onClick?.()
                  onClose()
                }}
              >
                {item.sprite ? <OsSprite name={item.sprite} size={16} /> : <span className="zos-menu-bullet" aria-hidden="true" />}
                <span className="zos-menu-label">{item.label}</span>
                {item.hint ? <span className="zos-menu-hint">{item.hint}</span> : null}
              </button>
            </li>
          ),
        )}
      </ul>
    </nav>
  )
}
