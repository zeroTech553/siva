'use client'

/**
 * boot-screen.tsx — what is on the glass before the desktop exists.
 *
 * Pure presentation: `use-machine.ts` decides the stage and how far through it
 * we are, this file draws it. Stages, timings and the typed lines all come from
 * `boot-stages.ts` (unit-tested in tests/boot-stages.test.mjs).
 *
 *   bios     firmware POST, typed line by line, cyan on black
 *   windows  four-pane loader + "Starting Zero OS" + block progress bar
 *   zeroos   the Zero OS logo splash while the desktop is loaded
 *   safe     the classic "it is now safe to turn off your computer"
 *   off      dark glass
 */

import { LoaderPanes, ZeroLogo, ZeroMark } from '../zero-logo'
import { SAFE_TO_POWER_OFF, visibleBootLines, type BootStageId } from './boot-stages'

const PROGRESS_BLOCKS = 12

export function BootScreen({
  stage,
  stageElapsed,
  progress,
  onSkip,
}: {
  stage: BootStageId
  stageElapsed: number
  progress: number
  onSkip: () => void
}) {
  if (stage === 'off') return <div className="zc-black" aria-hidden="true" />

  if (stage === 'safe') {
    return (
      <div className="zc-boot zc-boot-safe" role="status" aria-live="polite">
        <ZeroMark size={22} className="zc-boot-safe-mark" />
        <p>{SAFE_TO_POWER_OFF}</p>
      </div>
    )
  }

  if (stage === 'bios') {
    return (
      <div className="zc-boot zc-boot-bios" onPointerDown={onSkip} role="status" aria-live="polite">
        {visibleBootLines('bios', stageElapsed).map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p className="zc-boot-cursor">Press DEL to enter SETUP_</p>
        <SkipHint visible={stageElapsed > 700} />
      </div>
    )
  }

  if (stage === 'windows') {
    return (
      <div className="zc-boot zc-boot-loader" onPointerDown={onSkip} role="status" aria-live="polite">
        <LoaderPanes className="zc-boot-panes" />
        <p className="zc-boot-loader-title">Starting Zero OS</p>
        <BlockBar progress={progress} />
        <ul className="zc-boot-loader-lines">
          {visibleBootLines('windows', stageElapsed, 2).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <SkipHint visible={stageElapsed > 800} />
      </div>
    )
  }

  if (stage === 'zeroos') {
    return (
      <div className="zc-boot zc-boot-splash" onPointerDown={onSkip} role="status" aria-live="polite">
        <ZeroLogo scale={2} className="zc-boot-logo" />
        <p className="zc-boot-splash-sub">The retro operating system for the laptop you already own</p>
        <ul className="zc-boot-splash-lines">
          {visibleBootLines('zeroos', stageElapsed, 1.6).map((line) => (
            <li key={line}>
              <span className="zc-boot-dot" />
              {line}
            </li>
          ))}
        </ul>
        <p className="zc-boot-version">Zero OS 1.0 · zeroTech</p>
        <SkipHint visible={stageElapsed > 900} />
      </div>
    )
  }

  return null
}

function BlockBar({ progress }: { progress: number }) {
  const filled = Math.round(Math.min(1, Math.max(0, progress)) * PROGRESS_BLOCKS)
  return (
    <div className="zc-blockbar" aria-hidden="true">
      {Array.from({ length: PROGRESS_BLOCKS }, (_, index) => (
        <span key={index} className={index < filled ? 'zc-block zc-block-on' : 'zc-block'} />
      ))}
    </div>
  )
}

function SkipHint({ visible }: { visible: boolean }) {
  if (!visible) return null
  return <p className="zc-boot-skip">tap the glass to skip</p>
}
