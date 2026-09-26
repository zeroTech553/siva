'use client'

/**
 * machine-shell.tsx — the chassis: bezel, chin, drive bays, controls, stand.
 *
 * This is the FRONT view of an all-in-one 90s machine: the tube faces you, the
 * drives and every switch are on the chin below the glass, and the stand sits
 * under it. The keyboard and mouse are rendered by zero-computer.tsx in front.
 *
 * Every control here is a real <button> wired to `machine.actions`:
 *
 *   ⏻  power      boots the machine, or shuts it down (with the safe-to-power-off screen)
 *   RST reset     cold reboots straight back into the BIOS
 *   −  +          brightness, with an on-screen readout
 *   ♪             speaker mute
 *   PTR           pointer mode: direct (native cursor) / track (drawn cursor)
 *   CD            ejects the tray (and the OS opens the CD player)
 *   3.5           the floppy: it clicks, the LED flashes, and it does nothing else
 */

import type { ReactNode } from 'react'

import { playClick, playDisk, playError } from '@/lib/client/zero-sound'

import type { Machine } from './use-machine'

export function MachineShell({
  machine,
  screen,
  busy = false,
  model = 'ZT-486DX',
  onCd,
  onFloppy,
}: {
  machine: Machine
  /** The rendered CRT glass (see crt-screen.tsx). */
  screen: ReactNode
  /** External activity — the HDD LED follows the agent/terminal working. */
  busy?: boolean
  model?: string
  onCd?: () => void
  onFloppy?: () => void
}) {
  const powered = machine.power !== 'off'
  const { actions } = machine

  return (
    <div className="zc-chassis" data-powered={powered ? 'yes' : 'no'}>
      <div className="zc-bezel">
        <div className="zc-bezel-top">
          <span className="zc-brand">
            ZERO<i>·</i>OS
          </span>
          <span className="zc-model">{model}</span>
        </div>

        {screen}

        <div className="zc-chin">
          <div className="zc-bays">
            <button
              type="button"
              className={`zc-bay zc-bay-cd${machine.cdOpen ? ' zc-bay-open' : ''}`}
              aria-label={machine.cdOpen ? 'Close the CD-ROM tray' : 'Eject the CD-ROM tray'}
              aria-pressed={machine.cdOpen}
              onClick={() => {
                actions.toggleCd()
                onCd?.()
              }}
            >
              <span className="zc-bay-slot" />
              <span className="zc-bay-label">CD-ROM 4X</span>
              <span className="zc-bay-eject" aria-hidden="true">
                ⏏
              </span>
            </button>
            <button
              type="button"
              className="zc-bay zc-bay-floppy"
              aria-label="Floppy drive (3.5 inch)"
              onClick={() => {
                void playDisk()
                void playError()
                onFloppy?.()
              }}
            >
              <span className="zc-bay-slot" />
              <span className="zc-bay-label">3.5&quot; 1.44M</span>
            </button>
          </div>

          <div className="zc-leds" aria-hidden="true">
            <span className={`zc-led${powered ? ' zc-led-on' : ''}`} title="Power" />
            <span className={`zc-led${busy || machine.diskActive ? ' zc-led-busy' : ''}`} title="Hard disk" />
            <span className={`zc-led${machine.cdOpen ? ' zc-led-cd' : ''}`} title="CD-ROM" />
          </div>

          <div className="zc-controls">
            <button
              type="button"
              className="zc-knob"
              aria-label="Brightness down"
              title="Brightness down"
              onClick={actions.brightnessDown}
            >
              −
            </button>
            <button
              type="button"
              className="zc-knob"
              aria-label="Brightness up"
              title="Brightness up"
              onClick={actions.brightnessUp}
            >
              +
            </button>
            <button
              type="button"
              className={`zc-knob${machine.muted ? ' zc-knob-off' : ''}`}
              aria-label={machine.muted ? 'Unmute the speaker' : 'Mute the speaker'}
              aria-pressed={machine.muted}
              title={machine.muted ? 'Sound off' : 'Sound on'}
              onClick={actions.toggleMute}
            >
              {machine.muted ? '✕' : '♪'}
            </button>
            <button
              type="button"
              className={`zc-knob zc-knob-wide${machine.pointerMode === 'track' ? ' zc-knob-on' : ''}`}
              aria-label="Pointer mode"
              aria-pressed={machine.pointerMode === 'track'}
              title="Direct = your own cursor. Track = the mouse below drives the cursor."
              onClick={() => actions.setPointerMode(machine.pointerMode === 'direct' ? 'track' : 'direct')}
            >
              {machine.pointerMode === 'direct' ? 'PTR·DIR' : 'PTR·TRK'}
            </button>
            <button
              type="button"
              className="zc-switch"
              aria-label="Reset the machine"
              title="Reset"
              onClick={actions.pressReset}
            >
              RST
            </button>
            <button
              type="button"
              className={`zc-power${powered ? ' zc-power-on' : ''}`}
              aria-label={powered ? 'Turn the machine off' : 'Turn the machine on'}
              aria-pressed={powered}
              title="Power"
              onClick={() => {
                void playClick()
                actions.pressPower()
              }}
            >
              <span aria-hidden="true">⏻</span>
            </button>
          </div>
        </div>
      </div>

      <div className="zc-stand" aria-hidden="true">
        <span className="zc-neck" />
        <span className="zc-base" />
      </div>
    </div>
  )
}
