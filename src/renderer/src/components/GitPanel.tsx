import { useEffect, useState } from 'react'
import type { GitCommit, GitStatus, SessionInfo } from '../../../shared/types'
import { useStore } from '../store'

const HISTORY_LIMIT = 30

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

/**
 * Sidebar Git panel: shows the active session's repo branch + working-tree
 * state and a scrollable commit history. For a non-repo folder it offers to
 * initialize one (which also unlocks parallel tasks). Reloads on session switch
 * and whenever `gitNonce` is bumped (commits, merges, init).
 */
export function GitPanel({ session }: { session: SessionInfo }): JSX.Element {
  const id = session.config.id
  const gitNonce = useStore((s) => s.gitNonce)
  const refreshGit = useStore((s) => s.refreshGit)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const st = await window.api.gitStatus(id)
      if (cancelled) return
      setStatus(st)
      const commits = st.isRepo ? await window.api.gitLog(id, HISTORY_LIMIT) : []
      if (!cancelled) setLog(commits)
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
          <button className="btn ghost" title="Refresh git status & history" onClick={refreshGit}>
            ⟳
          </button>
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
