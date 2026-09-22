'use client'

// The Control Panel window: CLI choice, project, working directory,
// permission mode, plus new-chat and reset-pairing actions.

import type { AgentConsole } from '@/components/agent/use-agent-console'
import { Win95Button } from '@/components/os/win95'
import { PERMISSION_MODES, pingProviders, providerLabel } from '@/lib/shared/daemon'

export function ControlPanel({
  agent,
  fallbackProvider,
  onResetPairing,
}: {
  agent: AgentConsole
  fallbackProvider: string
  onResetPairing: () => void
}) {
  const providers = pingProviders(agent.ping)
  return (
    <div className="os-pane">
      <label>
        CLI
        <select value={agent.provider} onChange={(event) => agent.updateProvider(event.target.value)}>
          {(providers.length ? providers : [fallbackProvider]).map((name) => (
            <option key={name} value={name}>
              {providerLabel(name)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Project
        <select value={agent.cwd} onChange={(event) => agent.updateCwd(event.target.value)}>
          {agent.projects.map((project) => (
            <option key={project.id} value={project.cwd}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Directory
        <input
          value={agent.cwd}
          onChange={(event) => agent.setCwd(event.target.value)}
          aria-label="Working directory"
        />
      </label>
      <label>
        Mode
        <select value={agent.permissionMode} onChange={(event) => agent.setPermissionMode(event.target.value)}>
          {PERMISSION_MODES.map((mode) => (
            <option key={mode.id || 'default'} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      {agent.cliMessage ? <p>{agent.cliMessage}</p> : null}
      <div className="os-actions">
        <Win95Button onClick={agent.startNewChat}>New chat</Win95Button>
        <Win95Button onClick={onResetPairing}>Reset pairing</Win95Button>
      </div>
    </div>
  )
}
