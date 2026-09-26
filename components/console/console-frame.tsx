'use client'

/**
 * console-frame.tsx — /console: the full-size Zero OS machine.
 *
 * This file owns exactly four things and nothing else:
 *
 *   1. the session + laptop presence      → lib/client/use-paired-machine.ts
 *   2. one agent instance for the desktop → components/agent/use-agent-console.ts
 *   3. the visitor's CLI/model/flags      → lib/client/use-cli-selection.ts
 *   4. unpairing (Control Panel ▸ Reset)
 *
 * The chassis is components/computer/zero-computer.tsx and the desktop is
 * components/console/console-os.tsx. If no laptop is paired with this browser,
 * the visitor is sent back to the landing page — there is nothing to console.
 */

import { useRouter } from 'next/navigation'

import { useAgentConsole } from '@/components/agent/use-agent-console'
import { ZeroComputer } from '@/components/computer/zero-computer'
import { OsNote } from '@/components/computer/os/os-ui'
import { ConsoleOs } from '@/components/console/console-os'
import { useCliSelection } from '@/lib/client/use-cli-selection'
import { usePairedMachine } from '@/lib/client/use-paired-machine'

export function ConsoleFrame() {
  const router = useRouter()
  const paired = usePairedMachine({ onNoMachine: () => router.replace('/') })
  const agent = useAgentConsole({
    deviceId: paired.deviceId,
    phoneSecret: paired.phoneSecret,
    online: paired.online,
    daemonOnline: paired.daemonOnline,
  })
  const selection = useCliSelection()

  function unpair() {
    paired.forget() // DELETEs the device on the relay and clears local state
    localStorage.removeItem('agentremote.profiles') // legacy key from older builds
    router.replace('/')
  }

  return (
    <main className="console-page">
      <ZeroComputer
        size="lg"
        busy={agent.working}
        functionRow
        caption="Your computer, in your pocket."
        hint={
          paired.ready && !paired.online ? (
            <OsNote>
              Laptop offline — start the Forge bridge on {paired.hostname} and this desktop wakes up by
              itself.
            </OsNote>
          ) : (
            <OsNote>⏻ power · RST reboot · drag the mouse · type on the keyboard · Start ▸ Shut down.</OsNote>
          )
        }
      >
        {(machine) =>
          paired.ready ? (
            <ConsoleOs
              machine={machine}
              paired={paired}
              agent={agent}
              selection={selection}
              onUnpair={unpair}
            />
          ) : (
            <div className="zos-desktop zos-desktop-connecting">
              <p className="zos-connecting-line">Connecting to your laptop…</p>
            </div>
          )
        }
      </ZeroComputer>
    </main>
  )
}
