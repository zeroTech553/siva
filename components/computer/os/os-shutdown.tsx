'use client'

/**
 * os-shutdown.tsx — the classic "Shut Down" dialog.
 *
 * A modal in the 90s sense: one small window over a dimmed desktop, a radio
 * list, OK and Cancel. It never touches machine state itself — it reports the
 * choice upward, and `use-machine.ts` plays the shutdown screen and cuts power.
 * Escape and Cancel are the same thing.
 */

import { useEffect, useState } from 'react'

import { playClick } from '@/lib/client/zero-sound'

import { OsButton } from './os-ui'

export type ShutdownChoice = 'shutdown' | 'restart'

const CHOICES: Array<{ id: ShutdownChoice; label: string; hint: string }> = [
  { id: 'shutdown', label: 'Shut down the computer', hint: 'Zero OS closes and the glass goes dark.' },
  { id: 'restart', label: 'Restart the computer', hint: 'Boots again from the firmware POST.' },
]

export function OsShutdownDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean
  onConfirm(choice: ShutdownChoice): void
  onCancel(): void
}) {
  const [choice, setChoice] = useState<ShutdownChoice>('shutdown')

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
      if (event.key === 'Enter') onConfirm(choice)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [choice, onCancel, onConfirm, open])

  if (!open) return null

  return (
    <div className="zos-modal" role="presentation" onPointerDown={onCancel}>
      <section className="zos-dialog" role="dialog" aria-modal="true" aria-label="Shut Down Zero OS" onPointerDown={(event) => event.stopPropagation()}>
        <header className="zos-title zos-title-dialog">
          <span className="zos-title-text">Shut Down Zero OS</span>
        </header>
        <div className="zos-dialog-body">
          <p className="zos-dialog-question">Are you sure you want to:</p>
          <div className="zos-radio-list">
            {CHOICES.map((item) => (
              <label key={item.id} className={`zos-radio${choice === item.id ? ' zos-radio-on' : ''}`}>
                <input
                  type="radio"
                  name="zos-shutdown"
                  checked={choice === item.id}
                  onChange={() => {
                    void playClick()
                    setChoice(item.id)
                  }}
                />
                <span className="zos-radio-dot" aria-hidden="true" />
                <span className="zos-radio-text">
                  <span className="zos-radio-label">{item.label}</span>
                  <span className="zos-radio-hint">{item.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <footer className="zos-dialog-actions">
          <OsButton
            variant="primary"
            onClick={() => {
              onConfirm(choice)
            }}
          >
            OK
          </OsButton>
          <OsButton onClick={onCancel}>Cancel</OsButton>
        </footer>
      </section>
    </div>
  )
}
