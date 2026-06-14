import { useEffect, useMemo, useState } from 'react'
import type { GitStatus, SessionInfo } from '../../../shared/types'
import { orderedSessions, useStore } from '../store'

/**
 * Per-session git-status query result. 'loading' while the query is in flight,
 * 'error' when it threw (shown as an unknown state, never crashes the view).
 */
type RowState =
  | { kind: 'loading' }
  | { kind: 'ok'; status: GitStatus }
  | { kind: 'error' }

/** Sort rank: lower sorts first. Repos needing attention float to the top. */
function rank(state: RowState): number {
  if (state.kind === 'ok') {
    const s = state.status
    if (!s.isRepo) return 4 // non-repos are listed separately; defensive only
    const dirty = s.staged + s.unstaged + s.untracked
    if (dirty > 0 || s.ahead > 0) return 0 // uncommitted or unpushed work
    return 3 // clean and in sync
  }
  if (state.kind === 'error') return 1 // unknown — surface near the top
  return 2 // still loading
}

/** Chips mirroring the sidebar Git panel: branch, ahead/behind, dirty counts. */
function StatusChips({ status }: { status: GitStatus }): JSX.Element {
  const { ahead, behind, staged, unstaged, untracked } = status
  const clean = staged + unstaged + untracked === 0
  return (
    <div className="git-chips repo-overview-chips">
      {status.branch ? (
        <span
          className="git-branch"
          title={status.upstream ? `tracking ${status.upstream}` : undefined}
        >
          ⎇ {status.branch}
        </span>
      ) : (
        <span className="git-branch detached" title="Detached HEAD">
          detached
        </span>
      )}
      {ahead > 0 && (
        <span className="git-chip" title={`${ahead} commit(s) ahead of upstream`}>
          ↑{ahead}
        </span>
      )}
      {behind > 0 && (
        <span className="git-chip" title={`${behind} commit(s) behind upstream`}>
          ↓{behind}
        </span>
      )}
      {staged > 0 && (
        <span className="git-chip staged" title={`${staged} staged file(s)`}>
          ●{staged}
        </span>
      )}
      {unstaged > 0 && (
        <span className="git-chip unstaged" title={`${unstaged} changed file(s)`}>
          ✎{unstaged}
        </span>
      )}
      {untracked > 0 && (
        <span className="git-chip untracked" title={`${untracked} untracked file(s)`}>
          +{untracked}
        </span>
      )}
      {clean && ahead === 0 && behind === 0 && <span className="git-chip clean">clean</span>}
    </div>
  )
}

/** One repo row: name + branch relationship + working-tree state, click to jump. */
function RepoRow({
  session,
  state,
  onJump
}: {
  session: SessionInfo
  state: RowState
  onJump: () => void
}): JSX.Element {
  const wt = session.config.worktree ?? null
  const flagged =
    state.kind === 'error' ||
    (state.kind === 'ok' &&
      state.status.isRepo &&
      (state.status.staged + state.status.unstaged + state.status.untracked > 0 ||
        state.status.ahead > 0))
  return (
    <div
      className={`repo-overview-row${flagged ? ' flagged' : ''}`}
      title={`Jump to "${session.config.name}"`}
      onClick={onJump}
    >
      <span className="repo-overview-main">
        <span className="repo-overview-name">{session.config.name}</span>
        {wt && (
          <span className="repo-overview-sub">
            {wt.branch} → {wt.baseBranch}
          </span>
        )}
      </span>
      {state.kind === 'loading' && <span className="repo-overview-note">…</span>}
      {state.kind === 'error' && (
        <span className="repo-overview-note error" title="Couldn't read git status">
          status unavailable
        </span>
      )}
      {state.kind === 'ok' && state.status.isRepo && <StatusChips status={state.status} />}
    </div>
  )
}

/**
 * All-repos git status roll-up: one row per open session whose folder is a git
 * repo, showing its branch, dirty (staged/unstaged/untracked) and ahead/behind
 * counts via the read-only window.api.gitStatus IPC. Repos with uncommitted or
 * unpushed work are flagged and sorted to the top; clean repos and non-repos
 * follow. Statuses are queried concurrently when the dialog opens (and on
 * Refresh), filling rows as they resolve so the UI never freezes. Clicking a
 * row activates that session and closes the dialog.
 */
export function RepoStatusOverview(): JSX.Element {
  const close = useStore((s) => s.closeRepoOverview)
  const setActive = useStore((s) => s.setActive)
  /** Sessions snapshotted at query time, so live status ticks don't reshuffle rows. */
  const [rows, setRows] = useState<SessionInfo[]>([])
  const [states, setStates] = useState<Record<string, RowState>>({})
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    const list = orderedSessions(useStore.getState().sessions)
    setRows(list)
    setStates(Object.fromEntries(list.map((s) => [s.config.id, { kind: 'loading' } as RowState])))
    setLoading(true)
    // Query every session concurrently; each row fills in as its query resolves.
    void Promise.all(
      list.map(async (s) => {
        let next: RowState
        try {
          next = { kind: 'ok', status: await window.api.gitStatus(s.config.id) }
        } catch {
          next = { kind: 'error' }
        }
        if (!cancelled) setStates((prev) => ({ ...prev, [s.config.id]: next }))
      })
    ).then(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [nonce])

  // Repo rows (incl. loading/error/unknown) vs non-repo rows, kept separate so a
  // non-repo never renders with all-zero counts that read as "clean".
  const { repoRows, nonRepoRows } = useMemo(() => {
    const repos: SessionInfo[] = []
    const nonRepos: SessionInfo[] = []
    for (const s of rows) {
      const st = states[s.config.id] ?? { kind: 'loading' }
      if (st.kind === 'ok' && !st.status.isRepo) nonRepos.push(s)
      else repos.push(s)
    }
    // Stable sort by attention rank, preserving the orderedSessions order within a rank.
    const ordered = new Map(rows.map((s, i) => [s.config.id, i]))
    repos.sort((a, b) => {
      const ra = rank(states[a.config.id] ?? { kind: 'loading' })
      const rb = rank(states[b.config.id] ?? { kind: 'loading' })
      if (ra !== rb) return ra - rb
      return (ordered.get(a.config.id) ?? 0) - (ordered.get(b.config.id) ?? 0)
    })
    return { repoRows: repos, nonRepoRows: nonRepos }
  }, [rows, states])

  const jump = (id: string): void => {
    setActive(id)
    close()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal modal-wide"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <div className="repo-overview-header">
          <h2>Repo status overview</h2>
          <span className="repo-overview-header-actions">
            {loading && <span className="repo-overview-loading">Loading…</span>}
            <button
              className="btn ghost"
              title="Re-query every repo's git status"
              disabled={loading}
              onClick={() => setNonce((n) => n + 1)}
            >
              ⟳ Refresh
            </button>
          </span>
        </div>

        {rows.length === 0 ? (
          <div className="repo-overview-empty">No sessions open.</div>
        ) : (
          <div className="repo-overview-list">
            {repoRows.length === 0 && !loading && (
              <div className="repo-overview-empty">No git repositories among the open sessions.</div>
            )}
            {repoRows.map((s) => (
              <RepoRow
                key={s.config.id}
                session={s}
                state={states[s.config.id] ?? { kind: 'loading' }}
                onJump={() => jump(s.config.id)}
              />
            ))}

            {nonRepoRows.length > 0 && (
              <>
                <div className="repo-overview-subhead">Not a git repository</div>
                {nonRepoRows.map((s) => (
                  <div
                    key={s.config.id}
                    className="repo-overview-row non-repo"
                    title={`Jump to "${s.config.name}"`}
                    onClick={() => jump(s.config.id)}
                  >
                    <span className="repo-overview-main">
                      <span className="repo-overview-name">{s.config.name}</span>
                    </span>
                    <span className="repo-overview-note">not a repo</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
