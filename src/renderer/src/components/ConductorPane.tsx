import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type {
  AttachmentInfo,
  BranchListing,
  ConductorAction,
  ConductorMessage,
  ConductorRisk,
  ConductorTaskModel,
  ConductorTaskOptions
} from '../../../shared/types'
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

const MODEL_CHOICES: { value: ConductorTaskModel; label: string }[] = [
  { value: 'inherit', label: 'Inherit (default)' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

/** Recognized image filename extensions (mirrors main's Attachments allowlist). */
const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp)$/i

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

/** A name main's attachment store accepts: keep a real image name, else derive one. */
function imageNameFor(file: File): string {
  return IMAGE_NAME_RE.test(file.name) ? file.name : `pasted.${EXT_BY_MIME[file.type] ?? 'png'}`
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_NAME_RE.test(file.name)
}

/**
 * The repo (session) a task-creating action targets, or null when the action
 * isn't configurable. Only create_worktree_task and author_feature WITH
 * implement get the options form — those are the ones that spawn a task.
 */
function taskTargetSessionId(action: ConductorAction): string | null {
  const a = action.args
  if (action.kind === 'create_worktree_task') {
    return typeof a.parentSessionId === 'string' && a.parentSessionId ? a.parentSessionId : null
  }
  if (action.kind === 'author_feature' && a.implement) {
    return typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : null
  }
  return null
}

/**
 * The approval card's options form for task-creating actions: base branch (the
 * repo's real local branches), model, and the PR / auto-merge completion
 * toggles. The two toggles are mutually exclusive — a task either opens a PR
 * or merges directly.
 */
function TaskOptionsForm({
  branches,
  opts,
  onChange
}: {
  branches: BranchListing
  opts: ConductorTaskOptions
  onChange(next: ConductorTaskOptions): void
}): JSX.Element {
  return (
    <div className="conductor-task-form">
      <label className="conductor-task-field">
        <span>Base branch</span>
        {branches.branches.length > 0 ? (
          <select
            value={opts.baseBranch}
            onChange={(e) => onChange({ ...opts, baseBranch: e.target.value })}
          >
            {branches.branches.map((b) => (
              <option key={b} value={b}>
                {b}
                {b === branches.defaultBranch ? ' (default)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={opts.baseBranch}
            placeholder="base branch"
            onChange={(e) => onChange({ ...opts, baseBranch: e.target.value })}
          />
        )}
      </label>
      <label className="conductor-task-field">
        <span>Model</span>
        <select
          value={opts.model}
          onChange={(e) => onChange({ ...opts, model: e.target.value as ConductorTaskModel })}
        >
          {MODEL_CHOICES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label
        className="conductor-task-check"
        title="Push the task branch and open a pull request into the base branch when claude finishes (needs the gh CLI)."
      >
        <input
          type="checkbox"
          checked={opts.createPr}
          onChange={(e) =>
            onChange({
              ...opts,
              createPr: e.target.checked,
              autoMerge: e.target.checked ? false : opts.autoMerge
            })
          }
        />
        <span>Create PR when task completes</span>
      </label>
      <label
        className="conductor-task-check"
        title="Merge the task branch into the base branch when claude finishes. Skipped with a warning if the base tree is dirty or the merge would conflict."
      >
        <input
          type="checkbox"
          checked={opts.autoMerge}
          onChange={(e) =>
            onChange({
              ...opts,
              autoMerge: e.target.checked,
              createPr: e.target.checked ? false : opts.createPr
            })
          }
        />
        <span>Auto-merge into base when done</span>
      </label>
    </div>
  )
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
  const targetId = taskTargetSessionId(action)
  const configurable = proposed && targetId !== null

  // Task options, loaded once per card: real local branches of the target repo
  // plus the repo's persisted defaults from the last approval.
  const [branches, setBranches] = useState<BranchListing | null>(null)
  const [opts, setOpts] = useState<ConductorTaskOptions | null>(null)

  useEffect(() => {
    if (!configurable || !targetId) return
    let alive = true
    void (async () => {
      const [listing, saved] = await Promise.all([
        window.api.gitBranches(targetId).catch(
          (): BranchListing => ({ branches: [], current: null, defaultBranch: null })
        ),
        window.api.getConductorTaskDefaults(targetId).catch(() => null)
      ])
      if (!alive) return
      const inList = (b: string | null | undefined): string | null =>
        b && (listing.branches.length === 0 || listing.branches.includes(b)) ? b : null
      const planned =
        typeof action.args.baseBranch === 'string' ? action.args.baseBranch.trim() : ''
      setBranches(listing)
      setOpts({
        baseBranch:
          inList(saved?.baseBranch) ??
          inList(planned) ??
          listing.defaultBranch ??
          listing.current ??
          '',
        model: saved?.model ?? 'inherit',
        createPr: saved?.createPr ?? false,
        autoMerge: saved?.autoMerge ?? false
      })
    })()
    return () => {
      alive = false
    }
    // action.args never changes for a given action id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configurable, targetId])

  const onApprove = (): void => {
    void approve(messageId, action.id, configurable && opts ? opts : undefined)
  }

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
      {configurable && branches && opts && (
        <TaskOptionsForm branches={branches} opts={opts} onChange={setOpts} />
      )}
      {action.result && <div className="conductor-action-result">{action.result}</div>}
      {proposed && (
        <div className="conductor-action-buttons">
          <button className="btn primary" onClick={onApprove}>
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
  const images = message.images ?? []
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
          message.text && <div className="conductor-usertext">{message.text}</div>
        )}
        {images.length > 0 && (
          <div className="conductor-msg-images">
            {images.map((img) =>
              img.thumb ? (
                <img key={img.path} src={img.thumb} alt="attached" title={img.path} />
              ) : (
                <span key={img.path} className="conductor-msg-image-path" title={img.path}>
                  🖼 {img.path.split(/[\\/]/).pop()}
                </span>
              )
            )}
          </div>
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
  // Images attached but not yet sent (already saved to disk by main).
  const [images, setImages] = useState<AttachmentInfo[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // Stick to the bottom as the conversation grows / streams in.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const addAttachment = (info: AttachmentInfo | null): void => {
    if (info) setImages((prev) => [...prev, info])
  }

  const removeImage = (img: AttachmentInfo): void => {
    setImages((prev) => prev.filter((p) => p.fileName !== img.fileName))
    void window.api.conductorDeleteAttachment(img.fileName)
  }

  /** Ctrl+V: images from the clipboard become attachments; text pastes normally. */
  const onPaste = (e: React.ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile)
    if (files.length > 0) {
      e.preventDefault()
      for (const f of files) {
        void f
          .arrayBuffer()
          .then((buf) => window.api.conductorAttachImageData(imageNameFor(f), new Uint8Array(buf)))
          .then(addAttachment)
      }
      return
    }
    // Some sources put only a bitmap (no File entry) on the clipboard — let
    // main read it natively. Never fires for plain text pastes.
    if (!e.clipboardData?.getData('text/plain')) {
      void window.api.conductorAttachClipboardImage().then(addAttachment)
    }
  }

  /** Image files dropped onto the composer become attachments. */
  const onDrop = (e: React.DragEvent): void => {
    const files = Array.from(e.dataTransfer?.files ?? []).filter(isImageFile)
    if (files.length === 0) return
    e.preventDefault()
    for (const f of files) {
      const path = window.api.pathForFile(f)
      if (path) {
        void window.api.conductorAttachImageFile(path).then(addAttachment)
      } else {
        void f
          .arrayBuffer()
          .then((buf) => window.api.conductorAttachImageData(imageNameFor(f), new Uint8Array(buf)))
          .then(addAttachment)
      }
    }
  }

  const send = (): void => {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || busy) return
    const attached = images.map((i) => ({
      path: i.absPath,
      ...(i.thumbDataUrl ? { thumb: i.thumbDataUrl } : {})
    }))
    setText('')
    setImages([])
    void sendConductor(trimmed, attached)
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
                  work in plain language and I’ll propose actions you approve with a click. Paste or
                  drop screenshots to have me look at them.
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

      <div
        className="conductor-composer"
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file')) {
            e.preventDefault()
          }
        }}
        onDrop={onDrop}
      >
        {images.length > 0 && (
          <div className="conductor-attach-row">
            {images.map((img) => (
              <div key={img.fileName} className="conductor-attach" title={img.absPath}>
                {img.thumbDataUrl ? (
                  <img src={img.thumbDataUrl} alt={img.fileName} />
                ) : (
                  <span className="conductor-attach-name">{img.fileName}</span>
                )}
                <button
                  className="conductor-attach-remove"
                  title="Remove image"
                  onClick={() => removeImage(img)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="conductor-composer-row">
          <textarea
            className="conductor-input"
            placeholder={
              busy
                ? 'Maestro is thinking…'
                : focused
                  ? `Ask Maestro about ${focused.config.name}… (paste images to share them)`
                  : 'Ask Maestro, or describe what you want built… (paste images to share them)'
            }
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button
            className="btn primary"
            disabled={busy || (!text.trim() && images.length === 0)}
            onClick={send}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
