'use client'

import type { ReactNode } from 'react'
import { playClick } from '@/lib/desk-sound'

export function Win95Desktop({ children }: { children: ReactNode }) {
  return <div className="win95-desktop">{children}</div>
}

export function Win95Icons({
  items,
}: {
  items: Array<{ id: string; label: string; icon?: string; onClick: () => void }>
}) {
  return (
    <div className="win95-icons">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="win95-icon"
          onClick={() => {
            void playClick()
            item.onClick()
          }}
        >
          {item.icon ? <img src={item.icon} alt="" width={28} height={28} /> : <span className={`win95-glyph win95-glyph-${item.id}`} />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Win95Window({
  title,
  children,
  status,
  onClose,
  fit,
}: {
  title: string
  children: ReactNode
  status?: string
  onClose?: () => void
  fit?: boolean
}) {
  return (
    <section className={fit ? 'win95-window win95-window-fit' : 'win95-window'}>
      <header className="win95-title">
        <span className="min-w-0 truncate">{title}</span>
        {onClose ? (
          <button
            type="button"
            className="win95-x"
            aria-label="Close"
            onClick={() => {
              void playClick()
              onClose()
            }}
          >
            X
          </button>
        ) : null}
      </header>
      <div className="win95-body">{children}</div>
      {status ? <footer className="win95-status">{status}</footer> : null}
    </section>
  )
}

export function Win95Taskbar({
  startOpen,
  onToggleStart,
  items,
  clock,
}: {
  startOpen: boolean
  onToggleStart: () => void
  items: Array<{ id: string; label: string; active?: boolean; onClick: () => void }>
  clock: string
}) {
  return (
    <div className="win95-taskbar">
      <button
        type="button"
        className={startOpen ? 'win95-start win95-start-open' : 'win95-start'}
        onClick={() => {
          void playClick()
          onToggleStart()
        }}
      >
        Start
      </button>
      <div className="win95-tasks">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.active ? 'win95-task win95-task-active' : 'win95-task'}
            onClick={() => {
              void playClick()
              item.onClick()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <span className="win95-tray">{clock}</span>
    </div>
  )
}

export function Win95Menu({
  items,
}: {
  items: Array<{ id: string; label: string; onClick: () => void }>
}) {
  return (
    <nav className="win95-menu" aria-label="Start menu">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => {
            void playClick()
            item.onClick()
          }}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}

export function Win95Button({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      className="win95-btn"
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        void playClick()
        onClick?.()
      }}
    >
      {children}
    </button>
  )
}
