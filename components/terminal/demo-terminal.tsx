'use client'

/**
 * demo-terminal.tsx — a working little shell for visitors with no laptop paired.
 *
 * The real terminal (machine-terminal.tsx) needs a paired machine; the landing
 * page still has to show what a terminal *feels* like, so this one answers a
 * handful of commands locally. It is not a fake picture: it parses input, keeps
 * a scrollback, and its `open` command really opens OS windows when it is
 * running inside Zero OS.
 *
 * Typing works three ways, all real:
 *   • the device's own keyboard, once the input has focus
 *   • the machine's on-screen keyboard (hardware/keyboard.tsx types into the
 *     focused input, which is this one)
 *   • tap/click anywhere in the pane to grab focus
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Line = { id: number; kind: 'in' | 'out' | 'err' | 'dim'; text: string }

const BANNER = [
  'Zero OS 1.0 [demo shell] — no laptop paired yet.',
  "Type 'help' for the commands this shell knows.",
  "Pair a laptop and this pane becomes a real PTY on that machine.",
]

export function DemoTerminal({
  hostname = 'zero-os',
  onOpenApp,
  onPair,
  installCommand,
  height = '100%',
}: {
  hostname?: string
  /** Called for `open <app>`; the OS opens that window. */
  onOpenApp?: (appId: string) => void
  /** Called for `pair`; the page scrolls to the pairing section. */
  onPair?: () => void
  /** Printed by `install` — the real one-liner for the visitor's platform. */
  installCommand?: string
  height?: string
}) {
  const [lines, setLines] = useState<Line[]>(() => BANNER.map((text, index) => ({ id: index, kind: 'dim', text })))
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const idRef = useRef(BANNER.length)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const push = useCallback((kind: Line['kind'], text: string) => {
    idRef.current += 1
    setLines((current) => [...current, { id: idRef.current, kind, text }])
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [lines])

  const help = useMemo(
    () =>
      [
        'help              this list',
        'whoami            who is typing',
        'ls                what this machine can do',
        'open <app>        open an OS window (terminal, agent, files, connect)',
        'ps                what would be running on a paired laptop',
        'install           print the one-line installer',
        'pair              jump to pairing',
        'zero --version    version',
        'clear             clear the scrollback',
      ].join('\n'),
    [],
  )

  const run = useCallback(
    (raw: string) => {
      const command = raw.trim()
      push('in', `${hostname}:~$ ${command}`)
      if (!command) return
      setHistory((current) => [command, ...current].slice(0, 40))
      setHistoryIndex(-1)

      const [head, ...rest] = command.split(/\s+/)
      const arg = rest.join(' ')

      switch (head?.toLowerCase()) {
        case 'help':
          push('out', help)
          return
        case 'whoami':
          push('out', 'visitor — this browser, no laptop paired')
          return
        case 'ls':
          push('out', 'agent/   terminal/   files/   connect/   zero-os.readme')
          return
        case 'cat':
          if (/readme/i.test(arg)) {
            push(
              'out',
              'Forge drives the terminal, files and coding agents of a laptop you own\nfrom any browser. The laptop dials out; nothing is inbound.',
            )
            return
          }
          push('err', `cat: ${arg || '?'}: no such file`)
          return
        case 'open': {
          const app = arg.toLowerCase()
          if (!app) {
            push('err', 'open: which app? try: terminal, agent, files, connect')
            return
          }
          if (onOpenApp) {
            onOpenApp(app)
            push('out', `opening ${app}…`)
            return
          }
          push('err', `open: ${app} is not available here`)
          return
        }
        case 'ps':
          push(
            'out',
            '  PID TTY          TIME CMD\n' +
              '    1 ?        00:00:04 zero-wm        (this window manager)\n' +
              '   42 -        00:00:00 agentremoted   (needs a paired laptop)\n' +
              '   43 -        00:00:00 forge-bridge   (needs a paired laptop)',
          )
          return
        case 'install':
          push('out', installCommand || 'Pair a laptop first: the installer needs a pairing code.')
          return
        case 'pair':
          if (onPair) onPair()
          push('out', 'Scrolling to pairing. Run the printed command on your laptop.')
          return
        case 'zero':
        case 'version':
        case 'ver':
          push('out', 'Zero OS 1.0 (Forge web client) — retro shell, real laptop.')
          return
        case 'clear':
        case 'cls':
          setLines([])
          return
        case 'sudo':
          push('err', 'sudo: not today. This is a demo shell.')
          return
        default:
          push('err', `${head}: command not found — type 'help'`)
      }
    },
    [help, hostname, installCommand, onOpenApp, onPair, push],
  )

  return (
    <div
      className="demo-term"
      style={{ height }}
      onPointerDown={() => inputRef.current?.focus()}
      role="group"
      aria-label="Demo terminal"
    >
      <div ref={scrollRef} className="demo-term-scroll">
        {lines.map((line) => (
          <pre key={line.id} className={`demo-term-line demo-term-${line.kind}`}>
            {line.text}
          </pre>
        ))}
        <form
          className="demo-term-input-row"
          onSubmit={(event) => {
            event.preventDefault()
            run(value)
            setValue('')
          }}
        >
          <span className="demo-term-prompt">{hostname}:~$</span>
          <input
            ref={inputRef}
            className="demo-term-input"
            value={value}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Terminal command"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                const next = Math.min(history.length - 1, historyIndex + 1)
                if (next < 0) return
                setHistoryIndex(next)
                setValue(history[next] ?? '')
                return
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                const next = historyIndex - 1
                setHistoryIndex(next)
                setValue(next < 0 ? '' : (history[next] ?? ''))
              }
            }}
          />
        </form>
      </div>
    </div>
  )
}
