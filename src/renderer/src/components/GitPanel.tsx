import { useEffect, useState } from 'react'
import type {
  GitCommit,
  GitFileChange,
  GitStatus,
  RepoCheckpoint,
  SessionInfo
} from '../../../shared/types'
import { useStore } from '../store'

const HISTORY_LIMIT = 30

/** Compact "x ago" for a checkpoint's age. */
function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** Default checkpoint label, e.g. 'Checkpoint 14:05'. */
function defaultCheckpointLabel(): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `Checkpoint ${hh}:${mm}`
}

/**
 * Prompt for a label and snapshot the active repo's working tree. Shared by the
 * Git panel button and the command palette so both behave identically.
 */
export function promptAndCheckpoint(sessionId: string): void {
  const label = window.prompt(
    'Label this checkpoint (a snapshot of the current working tree):',
    defaultCheckpointLabel()
  )
  if (label === null) return // cancelled
  void useStore.getState().createCheckpoint(sessionId, label)
}

/** Dirty/ahead-behind chips for a repo's working tree + upstream. */
function StatusChips({ status }: { status: GitStatus }): JSX.Element {
  const { ahead, behind, staged, unstaged, untracked } = status
  const clean = staged + unstaged + untracked === 0
  return (
    <div className="git-chips">
      {status.branch ? (
        <span className="git-branch" title={status.upstream ? `tracking ${status.upstream}` : undefined}>
          ⎇ {status.branch}
        </span>
      ) : (
        <span className="git-branch detached" title="Detached HEAD">
          detached
        </span>
      )}
      {ahead > 0 && <span className="git-chip" title={`${ahead} commit(s) ahead of upstream`}>↑{ahead}</span>}
      {behind > 0 && <span className="git-chip" title={`${behind} commit(s) behind upstream`}>↓{behind}</span>}
      {staged > 0 && <span className="git-chip staged" title={`${staged} staged file(s)`}>●{staged}</span>}
      {unstaged > 0 && <span className="git-chip unstaged" title={`${unstaged} changed file(s)`}>✎{unstaged}</span>}
      {untracked > 0 && <span className="git-chip untracked" title={`${untracked} untracked file(s)`}>+{untracked}</span>}
      {clean && ahead === 0 && behind === 0 && <span className="git-chip clean">clean</span>}
    </div>
  )
}

/** CSS modifier for a changed file's status code (colors keyed on the first letter). */
function statusClass(status: string): string {
  if (status.startsWith('?')) return 'untracked'
  return status[0]?.toLowerCase() ?? 'm'
}

/** One row in the changed-files list; clicking opens the file's diff tab. */
function ChangedFile({ file, onOpen }: { file: GitFileChange; onOpen: () => void }): JSX.Element {
  const renamed = file.origPath ? `${file.origPath} → ` : ''
  return (
    <div
      className="git-file"
      title={`${renamed}${file.path} — click to view diff`}
      onClick={onOpen}
    >
      <span className={`git-file-status s-${statusClass(file.status)}`}>{file.status}</span>
      <span className="git-file-path">{file.path}</span>
    </div>
  )
}

/**
 * Sidebar Git panel: shows the active session's repo branch + working-tree
 * state, the changed files (click one to review its diff in a tab) and a
 * scrollable commit history. For a non-repo folder it offers to initialize one
 * (which also unlocks parallel tasks). Reloads on session switch and whenever
 * `gitNonce` is bumped (commits, merges, init).
 */
export function GitPanel({ session }: { session: SessionInfo }): JSX.Element {
  const id = session.config.id
  const gitNonce = useStore((s) => s.gitNonce)
  const refreshGit = useStore((s) => s.refreshGit)
  const openDiff = useStore((s) => s.openDiff)
  const restoreCheckpoint = useStore((s) => s.restoreCheckpoint)
  const deleteCheckpoint = useStore((s) => s.deleteCheckpoint)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [log, setLog] = useState<GitCommit[]>([])
  const [checkpoints, setCheckpoints] = useState<RepoCheckpoint[]>([])
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const st = await window.api.gitStatus(id)
      if (cancelled) return
      setStatus(st)
      const [changed, commits, cps] = st.isRepo
        ? await Promise.all([
            window.api.gitChangedFiles(id),
            window.api.gitLog(id, HISTORY_LIMIT),
            window.api.listCheckpoints(id)
          ])
        : [[], [], []]
      if (cancelled) return
      setFiles(changed)
      setLog(commits)
      setCheckpoints(cps)
    })()
    return () => {
      cancelled = true
    }
  }, [id, gitNonce])

  const onInit = async (): Promise<void> => {
    if (
      !window.confirm(
        `Initialize a new git repository in "${session.config.name}"?\n\n` +
          `Your files are left untracked — only an empty initial commit is added.`
      )
    )
      return
    setBusy(true)
    try {
      const info = await window.api.gitInit(id)
      if (!info.isRepo) window.alert('Could not initialize a git repository here.')
    } catch (err) {
      window.alert(`Couldn't initialize a git repository:\n\n${(err as Error).message}`)
    } finally {
      setBusy(false)
      refreshGit()
    }
  }

  return (
    <div className="git-panel">
      <div className="git-header">
        <span onClick={() => setOpen((v) => !v)} className="git-title-toggle">
          <span className="git-chevron">{open ? '▾' : '▸'}</span>
          Git
        </span>
        {status?.isRepo && (
          <span className="git-header-actions">
            <button
              className="btn ghost"
              title="Checkpoint: snapshot the working tree so you can restore it later"
              onClick={() => promptAndCheckpoint(id)}
            >
              ⛿ Checkpoint
            </button>
            <button className="btn ghost" title="Refresh git status & history" onClick={refreshGit}>
              ⟳
            </button>
          </span>
        )}
      </div>

      {!status ? (
        <div className="git-empty">…</div>
      ) : !status.isRepo ? (
        <div className="git-empty">
          <div className="git-empty-text">Not a git repository.</div>
          <button className="btn" disabled={busy} onClick={() => void onInit()}>
            {busy ? 'Initializing…' : 'Initialize repository'}
          </button>
        </div>
      ) : (
        <>
          <StatusChips status={status} />
          {files.length > 0 && (
            <div className="git-files">
              {files.map((f) => (
                <ChangedFile key={f.path} file={f} onOpen={() => openDiff(id, f.path)} />
              ))}
            </div>
          )}
          {checkpoints.length > 0 && (
            <div className="git-checkpoints">
              <div className="git-subhead">Checkpoints</div>
              {checkpoints.map((c) => (
                <div
                  key={c.id}
                  className="git-checkpoint"
                  title={`${c.label} · ${new Date(c.createdAt).toLocaleString()}`}
                >
                  <span className="git-checkpoint-body">
                    <span className="git-checkpoint-label">{c.label}</span>
                    <span className="git-checkpoint-meta">{timeAgo(c.createdAt)}</span>
                  </span>
                  <span className="git-checkpoint-actions">
                    <button
                      className="btn ghost"
                      title="Restore the working tree to this checkpoint"
                      onClick={() => void restoreCheckpoint(id, c.id, c.label)}
                    >
                      Restore
                    </button>
                    <button
                      className="btn ghost"
                      title="Delete this checkpoint"
                      onClick={() => void deleteCheckpoint(id, c.id)}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {open && (
            <div className="git-history">
              {log.length === 0 ? (
                <div className="git-empty-text">No commits yet.</div>
              ) : (
                log.map((c) => (
                  <div
                    key={c.hash}
                    className="git-commit"
                    title={`${c.shortHash} · ${c.author} · ${c.relDate}\n${c.subject}`}
                  >
                    <span className="git-commit-hash">{c.shortHash}</span>
                    <span className="git-commit-body">
                      <span className="git-commit-subject">
                        {c.refs && <GitRefs refs={c.refs} />}
                        {c.subject}
                      </span>
                      <span className="git-commit-meta">
                        {c.author} · {c.relDate}
                      </span>
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Render git ref decorations (HEAD, branches, tags) as small chips. */
function GitRefs({ refs }: { refs: string }): JSX.Element {
  const parts = refs
    .split(',')
    .map((r) => r.trim().replace(/^HEAD -> /, ''))
    .filter(Boolean)
  return (
    <>
      {parts.map((r) => (
        <span key={r} className={`git-ref${r.startsWith('tag: ') ? ' tag' : ''}`}>
          {r.replace(/^tag: /, '')}
        </span>
      ))}
    </>
  )
}
