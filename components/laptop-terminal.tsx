'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { DeviceRpcError, deviceRpc } from '@/lib/device-rpc'
import { playClick, playErrorBeep } from '@/lib/desk-sound'

type ShellResult = {
  output?: string
  exit_code?: number
  cwd?: string
}

export function LaptopTerminal({
  deviceId,
  phoneSecret,
  cwd,
}: {
  deviceId: string
  phoneSecret: string
  cwd: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>(['Forge terminal. Commands run on the paired laptop.'])

  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [lines])

  async function run() {
    const text = command.trim()
    if (!text || busy) return
    setBusy(true)
    setLines((current) => [...current, `$ ${text}`])
    setCommand('')
    void playClick()
    try {
      const result = await deviceRpc<ShellResult>(deviceId, phoneSecret, '/api/shell', {
        method: 'POST',
        body: JSON.stringify({ command: text, cwd }),
      })
      const output = (result.output || '').replace(/\s+$/, '')
      setLines((current) => [...current, output || `(exit ${result.exit_code ?? 0})`])
    } catch (cause) {
      void playErrorBeep()
      setLines((current) => [
        ...current,
        cause instanceof DeviceRpcError ? cause.message : 'The laptop did not run that command.',
      ])
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    void run()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-foreground text-accent">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-5">
        {lines.map((line, index) => (
          <pre key={`${index}-${line.slice(0, 24)}`} className="whitespace-pre-wrap break-words">
            {line}
          </pre>
        ))}
      </div>
      <form
        className="flex items-center gap-2 border-t border-accent/30 p-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        <span className="font-mono text-[11px]">$</span>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-accent outline-none"
          placeholder={busy ? 'Running on laptop…' : 'ls, git status, npm test'}
          aria-label="Laptop shell command"
          disabled={busy}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </form>
    </div>
  )
}
