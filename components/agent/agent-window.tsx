'use client'

// The agent console window: transcript, pending permission / question
// prompts, and the composer. State comes from use-agent-console.ts.

import { useEffect, useRef, type KeyboardEvent } from 'react'

import type { AgentConsole } from '@/components/agent/use-agent-console'
import { ConsoleTranscript } from '@/components/agent/console-transcript'
import { Win95Button } from '@/components/os/win95'
import { optionLabel, questionLabel } from '@/lib/shared/daemon'

export function AgentWindow({
  agent,
  agentName,
  online,
  daemonOnline,
  emptyHint,
}: {
  agent: AgentConsole
  agentName: string
  online: boolean
  daemonOnline: boolean
  emptyHint: string
}) {
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = transcriptRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [agent.events, agent.job?.pending_permission, agent.job?.pending_question])

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    void agent.sendPrompt()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={transcriptRef} className="forge-work-log">
        <ConsoleTranscript events={agent.events} emptyHint={emptyHint} />
        {agent.job?.pending_permission ? (
          <section className="forge-ask">
            <p>
              Allow {agent.job.pending_permission.tool_name || 'this tool'}
              {agent.job.pending_permission.detail ? ` — ${agent.job.pending_permission.detail}` : ''}?
            </p>
            <div>
              <Win95Button onClick={() => void agent.answerPermission(true)}>Allow</Win95Button>
              <Win95Button onClick={() => void agent.answerPermission(false)}>Deny</Win95Button>
            </div>
          </section>
        ) : null}
        {agent.job?.pending_question?.questions?.length ? (
          <section className="forge-ask">
            {agent.job.pending_question.questions.map((question, index) => (
              <div key={`${agent.job?.pending_question?.request_id}-${index}`}>
                <p>{questionLabel(question)}</p>
                <div>
                  {(question.options || []).map((option) => {
                    const label = optionLabel(option)
                    return (
                      <Win95Button key={label} onClick={() => void agent.answerQuestion(question, label)}>
                        {label}
                      </Win95Button>
                    )
                  })}
                </div>
              </div>
            ))}
            <Win95Button onClick={() => void agent.cancelQuestion()}>Skip</Win95Button>
          </section>
        ) : null}
      </div>
      {agent.error ? <p className="forge-work-error">{agent.error}</p> : null}
      <form
        className="forge-prompt"
        onSubmit={(event) => {
          event.preventDefault()
          void agent.sendPrompt()
        }}
      >
        <textarea
          value={agent.prompt}
          onChange={(event) => agent.setPrompt(event.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder={daemonOnline ? `Ask ${agentName}…` : 'Waiting for the laptop daemon…'}
          disabled={!online}
          aria-label="Prompt"
        />
        {agent.working ? (
          <Win95Button onClick={() => void agent.stopJob()}>Stop</Win95Button>
        ) : (
          <Win95Button type="submit">Send</Win95Button>
        )}
      </form>
    </div>
  )
}
