'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { DeviceRpcError, deviceRpc } from '@/lib/client/device-rpc'

type ShellResult = {
  output?: string
  exit_code?: number
  cwd?: string
}

type Line = {
  kind: 'prompt' | 'out' | 'err'
  text: string
}

export function LaptopTerminal({
  deviceId,
  phoneSecret,
  cwd,
  hostname,
  onCwdChange,
}: {
  deviceId: string
  phoneSecret: string
  cwd: string
  hostname?: string
  onCwdChange?: (cwd: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef<string[]>([])
  const historyIndex = useRef(-1)
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [shellCwd, setShellCwd] = useState(cwd)
  const [lines, setLines] = useState<Line[]>([
    { kind: 'out', text: 'Laptop shell. Commands run on the paired machine via /api/shell.' },
  ])

  useEffect(() => {
    if (cwd && cwd !== shellCwd) setShellCwd(cwd)
  }, [cwd, shellCwd])

  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [lines, busy])

  function promptLabel() {
    const short = shortPath(shellCwd)
    return `${hostname || 'laptop'}:${short}$`
  }

  async function run(raw = command) {
    const text = raw.trim()
    if (!text || busy) return
    if (text === 'clear' || text === 'cls') {
      setLines([])
      setCommand('')
      return
    }
    historyRef.current = [...historyRef.current.filter((item) => item !== text), text]
    historyIndex.current = -1
    setBusy(true)
    setLines((current) => [...current, { kind: 'prompt', text: `${promptLabel()} ${text}` }])
    setCommand('')
    try {
      const wrapped = wrapShellCommand(text, shellCwd)
      const result = await deviceRpc<ShellResult>(deviceId, phoneSecret, '/api/shell', {
        method: 'POST',
        body: JSON.stringify({ command: wrapped, cwd: shellCwd || undefined }),
      })
      const parsed = parseShellOutput(result.output || '', shellCwd)
      if (parsed.cwd && parsed.cwd !== shellCwd) {
        setShellCwd(parsed.cwd)
        onCwdChange?.(parsed.cwd)
      }
      const output = parsed.output.replace(/\s+$/, '')
      setLines((current) => {
        const next = [...current]
        if (output) next.push({ kind: result.exit_code ? 'err' : 'out', text: output })
        else if (result.exit_code) next.push({ kind: 'err', text: `exit ${result.exit_code}` })
        return next
      })
    } catch (cause) {
      setLines((current) => [
        ...current,
        {
          kind: 'err',
          text: cause instanceof DeviceRpcError ? cause.message : 'The laptop did not run that command.',
        },
      ])
    } finally {
      setBusy(false)
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void run()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const history = historyRef.current
      if (!history.length) return
      const next = historyIndex.current < 0 ? history.length - 1 : Math.max(0, historyIndex.current - 1)
      historyIndex.current = next
      setCommand(history[next] || '')
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const history = historyRef.current
      if (historyIndex.current < 0) return
      const next = historyIndex.current + 1
      if (next >= history.length) {
        historyIndex.current = -1
        setCommand('')
        return
      }
      historyIndex.current = next
      setCommand(history[next] || '')
    }
  }

  return (
    <section className="laptop-term" onClick={() => inputRef.current?.focus()}>
      <header className="laptop-term-bar">
        <span>Laptop terminal</span>
        <span className="laptop-term-cwd">{shellCwd || 'waiting for cwd'}</span>
      </header>
      <div ref={scroller} className="laptop-term-scroll">
        {lines.map((line, index) => (
          <pre key={`${index}-${line.kind}`} className={line.kind === 'err' ? 'laptop-term-err' : undefined}>
            {line.text}
          </pre>
        ))}
        {busy ? <pre className="laptop-term-busy">running on laptop…</pre> : null}
      </div>
      <form
        className="laptop-term-form"
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        <label className="sr-only" htmlFor="laptop-shell">
          Laptop shell command
        </label>
        <span className="laptop-term-ps1">{promptLabel()}</span>
        <input
          id="laptop-shell"
          ref={inputRef}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? 'running…' : 'ls, cd, git status'}
          disabled={busy}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
        />
      </form>
    </section>
  )
}

function isWindowsPath(cwd: string) {
  return /^[A-Za-z]:[\\/]/.test(cwd)
}

function wrapShellCommand(command: string, cwd: string) {
  if (isWindowsPath(cwd)) {
    return `${command} & echo __FORGE_CWD__ & cd`
  }
  return `${command}\nprintf '\\n__FORGE_CWD__:%s\\n' "$(pwd)"`
}

function parseShellOutput(output: string, fallback: string) {
  const unix = output.match(/__FORGE_CWD__:([^\r\n]+)/)
  if (unix?.[1] && looksLikePath(unix[1])) {
    return { output: output.replace(/\n?__FORGE_CWD__:[^\r\n]+/, ''), cwd: unix[1].trim() }
  }
  const marker = output.lastIndexOf('__FORGE_CWD__')
  if (marker >= 0) {
    const after = output
      .slice(marker + '__FORGE_CWD__'.length)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => looksLikePath(line))
    return {
      output: output.slice(0, marker).replace(/\s+$/, ''),
      cwd: after || fallback,
    }
  }
  return { output, cwd: fallback }
}

function looksLikePath(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return false
  return trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)
}

function shortPath(cwd: string) {
  if (!cwd) return '~'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}
