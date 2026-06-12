import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ConductorAction, ConductorMessage, ConductorRisk } from '../../../shared/types'
import { useStore } from '../store'

/** Render trusted-after-sanitize markdown the same way the file viewer does. */
function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }) as string),
    [text]
  )
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

const RISK_LABEL: Record<ConductorRisk, string> = {
  safe: 'safe',
  write: 'creates work',
  destructive: 'destructive'
}

/** One proposed/run action with its approve/reject controls. */
function ActionCard({
  messageId,
  action
}: {
  messageId: string
  action: ConductorAction
}): JSX.Element {
  const approve = useStore((s) => s.approveConductorAction)
  const reject = useStore((s) => s.rejectConductorAction)
  const proposed = action.status === 'proposed'
  return (
    <div className={`conductor-action risk-${action.risk} status-${action.status}`}>
      <div className="conductor-action-head">
        <span className={`risk-chip risk-${action.risk}`}>{RISK_LABEL[action.risk]}</span>
        <span className="conductor-action-kind">{action.kind}</span>
        {action.status !== 'proposed' && (
          <span className={`conductor-action-status status-${action.status}`}>{action.status}</span>
        )}
      </div>
      <div className="conductor-action-summary">{action.summary}</div>
      {action.result && <div className="conductor-action-result">{action.result}</div>}
      {proposed && (
        <div className="conductor-action-buttons">
          <button className="btn primary" onClick={() => void approve(messageId, action.id)}>
            Approve
          </button>
          <button className="btn ghost" onClick={() => void reject(messageId, action.id)}>
            Reject
          </button>
        </div>
      )}
    </div>
  )
}

function MessageView({ message }: { message: ConductorMessage }): JSX.Element {
  const approveAll = useStore((s) => s.approveAllConductorActions)
  const actions = message.actions ?? []
  const proposedNonDestructive = actions.filter(
    (a) => a.status === 'proposed' && a.risk !== 'destructive'
  )
  return (
    <div className={`conductor-msg role-${message.role}`}>
      <div className="conductor-msg-role">{message.role === 'user' ? 'You' : 'Maestro'}</div>
      <div className="conductor-msg-body">
        {message.pending && !message.text ? (
          <div className="conductor-thinking">Thinking…</div>
        ) : message.role === 'assistant' ? (
          <Markdown text={message.text} />
        ) : (
          <div className="conductor-usertext">{message.text}</div>
        )}
        {message.error && <div className="conductor-error">{message.error}</div>}
        {actions.length > 0 && (
          <div className="conductor-actions">
            {proposedNonDestructive.length > 1 && (
              <button
                className="btn"
                title="Run every non-destructive proposed action"
                onClick={() => void approveAll(message.id)}
              >
                Approve all ({proposedNonDestructive.length})
              </button>
            )}
            {actions.map((a) => (
              <ActionCard key={a.id} messageId={message.id} action={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const EXAMPLES = [
  'What’s the status of all my sessions and tasks right now?',
  'Add a dark-mode toggle to <repo> and start building it.',
  'Queue a prompt to run the tests in every session.',
  'Which of my worktree tasks are ready to merge?'
]

const FOCUSED_EXAMPLES = [
  'What’s the current state of this session?',
  'Add a feature here and start building it.',
  'Queue a prompt to run the tests.',
  'Is this task ready to merge?'
]

/**
 * Header control to focus ("tag") the chat on a single session. Picking a
 * session scopes the planner to it; "All sessions" clears the focus.
 */
function FocusPicker(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const tagId = useStore((s) => s.conductorTagId)
  const setTag = useStore((s) => s.setConductorTag)
  return (
    <label className="conductor-focus" title="Scope this chat to one session">
      <span className="conductor-focus-mark">📍</span>
      <select
        className="conductor-focus-select"
        value={tagId ?? ''}
        onChange={(e) => setTag(e.target.value || null)}
      >
        <option value="">All sessions</option>
        {sessions.map((s) => (
          <option key={s.config.id} value={s.config.id}>
            {s.config.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The Conductor chat surface (the app-level "Maestro" home). Renders the
 * persisted conversation, lets the user approve/reject the AI's proposed
 * management actions, and sends new messages. State lives in the store; main
 * pushes every change via onConductorChanged.
 */
export function ConductorPane(): JSX.Element {
  const messages = useStore((s) => s.conductorMessages)
  const sendConductor = useStore((s) => s.sendConductor)
  const clearConductor = useStore((s) => s.clearConductor)
  const focused = useStore((s) => s.sessions.find((x) => x.config.id === s.conductorTagId))
  const busy = messages.some((m) => m.pending)
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // Stick to the bottom as the conversation grows / streams in.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const send = (): void => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setText('')
    void sendConductor(trimmed)
  }

  return (
    <div className="conductor-pane">
      <div className="conductor-header">
        <div className="conductor-title">✦ Maestro — Conductor</div>
        <div className="row">
          <FocusPicker />
          <button
            className="btn ghost"
            title="Clear conversation"
            disabled={messages.length === 0}
            onClick={() => void clearConductor()}
          >
            Clear chat
          </button>
        </div>
      </div>

      <div className="conductor-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="conductor-empty">
            <p>
              {focused ? (
                <>
                  Focused on <strong>{focused.config.name}</strong> — I’ll answer about this
                  session and propose actions scoped to it. Switch to “All sessions” in the header
                  for the cross-repo view.
                </>
              ) : (
                <>
                  I’m your conductor across every repo and session. Ask for an overview, or describe
                  work in plain language and I’ll propose actions you approve with a click.
                </>
              )}
            </p>
            <ul>
              {(focused ? FOCUSED_EXAMPLES : EXAMPLES).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : (
          messages.map((m) => <MessageView key={m.id} message={m} />)
        )}
      </div>

      <div className="conductor-composer">
        <textarea
          className="conductor-input"
          placeholder={
            busy
              ? 'Maestro is thinking…'
              : focused
                ? `Ask Maestro about ${focused.config.name}…`
                : 'Ask Maestro, or describe what you want built…'
          }
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="btn primary" disabled={busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
    </div>
  )
}
