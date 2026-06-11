import { useState } from 'react'
import type { AutoExpandRun, AutoExpandRunStatus } from '../../../shared/types'
import { DEFAULT_AUTO_EXPAND } from '../../../shared/types'
import { useStore } from '../store'

const STATUS_LABEL: Record<AutoExpandRunStatus, string> = {
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  error: 'Failed'
}

const PHASE_LABEL: Record<AutoExpandRun['phase'], string> = {
  ideating: 'Generating ideas…',
  evaluating: 'Picking the best idea…',
  implementing: 'Writing specs & spinning off the task…',
  done: 'Implementing in its task session'
}

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/** One pipeline run: status line, ideas, the evaluator's pick, task link. */
function RunCard({ run }: { run: AutoExpandRun }): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const setActive = useStore((s) => s.setActive)
  const closeAutoExpand = useStore((s) => s.closeAutoExpand)
  const [open, setOpen] = useState(run.status === 'running')

  const task = run.taskSessionId
    ? sessions.find((s) => s.config.id === run.taskSessionId)
    : null

  const openTask = (): void => {
    if (!task) return
    closeAutoExpand()
    setActive(task.config.id)
  }

  return (
    <div className={`autoexpand-run run-${run.status}`}>
      <div className="autoexpand-run-head" onClick={() => setOpen(!open)}>
        <span className={`autoexpand-status run-${run.status}`}>{STATUS_LABEL[run.status]}</span>
        <span className="autoexpand-run-title">
          {run.chosenTitle ?? (run.status === 'running' ? PHASE_LABEL[run.phase] : run.reason)}
        </span>
        <span className="autoexpand-run-meta">
          {run.reason} · {timeAgo(run.startedAt)}
        </span>
        <span className="sentinel-chevron">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="autoexpand-run-body">
          {run.status === 'running' && <div className="field-hint">{PHASE_LABEL[run.phase]}</div>}
          {run.verdict && (
            <div className={`autoexpand-verdict${run.status === 'error' ? ' error' : ''}`}>
              {run.verdict}
            </div>
          )}
          {run.ideas.length > 0 && (
            <ul className="autoexpand-ideas">
              {run.ideas.map((idea, i) => (
                <li
                  key={i}
                  className={idea.title === run.chosenTitle ? 'chosen' : undefined}
                  title={idea.rationale}
                >
                  <strong>{idea.title}</strong>
                  {idea.title === run.chosenTitle && ' ✦'} — {idea.description}
                </li>
              ))}
            </ul>
          )}
          {task && (
            <button className="btn ghost" onClick={openTask}>
              ↪ Open task session
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Config + history dialog for the self-expanding-features pipeline. The user
 * names a branch for the expansion to grow on (created automatically when
 * missing); on the chosen cadence an idea agent proposes features, an
 * evaluator picks the best one and writes its specs, and Maestro implements
 * it as a worktree task branched off — and merging back into — that branch.
 */
export function AutoExpandDialog(): JSX.Element {
  const close = useStore((s) => s.closeAutoExpand)
  // Mounted only while autoExpandSessionId is non-null, so this is safe.
  const sessionId = useStore((s) => s.autoExpandSessionId)!
  const session = useStore((s) => s.sessions.find((x) => x.config.id === sessionId))
  const runs = useStore((s) => s.autoExpandRuns[sessionId]) ?? []
  const saveAutoExpand = useStore((s) => s.saveAutoExpand)
  const runAutoExpand = useStore((s) => s.runAutoExpand)

  const existing = session?.config.autoExpand ?? null
  const [enabled, setEnabled] = useState(existing?.enabled ?? false)
  const [branch, setBranch] = useState(existing?.branch ?? DEFAULT_AUTO_EXPAND.branch)
  const [intervalMinutes, setIntervalMinutes] = useState(
    existing?.intervalMinutes ?? DEFAULT_AUTO_EXPAND.intervalMinutes
  )
  const [guidance, setGuidance] = useState(existing?.guidance ?? '')
  const [maxConcurrent, setMaxConcurrent] = useState(
    existing?.maxConcurrent ?? DEFAULT_AUTO_EXPAND.maxConcurrent
  )
  const [error, setError] = useState<string | null>(null)

  const config = (): { branch: string } | null => {
    const trimmed = branch.trim()
    if (!trimmed) {
      setError('A branch name is required — the expansion grows on it.')
      return null
    }
    return { branch: trimmed }
  }

  const save = async (): Promise<void> => {
    const valid = config()
    if (!valid) return
    await saveAutoExpand(sessionId, {
      enabled,
      branch: valid.branch,
      intervalMinutes: Math.max(1, intervalMinutes),
      guidance: guidance.trim(),
      maxConcurrent: Math.max(1, maxConcurrent)
    })
    setError(null)
  }

  const runNow = async (): Promise<void> => {
    const valid = config()
    if (!valid) return
    // Persist first so the run uses what's on screen (branch, guidance, …).
    await saveAutoExpand(sessionId, {
      enabled,
      branch: valid.branch,
      intervalMinutes: Math.max(1, intervalMinutes),
      guidance: guidance.trim(),
      maxConcurrent: Math.max(1, maxConcurrent)
    })
    setError(null)
    await runAutoExpand(sessionId)
  }

  const running = runs.some((r) => r.status === 'running')

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Auto-expand features</h2>
        <div className="field-hint">
          Let <strong>{session?.config.name ?? 'this session'}</strong> grow itself: on a timer, an
          idea agent proposes new features for the repo, an evaluator agent picks the best one and
          writes its specs, and Maestro implements it in a worktree task session branched off the
          branch below. You stay in control — review each task and merge it (into that branch) when
          you&apos;re happy.
        </div>

        <div className="field-row">
          <label className="field">
            <span>Expansion branch</span>
            <input
              autoFocus
              placeholder={DEFAULT_AUTO_EXPAND.branch}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && close()}
            />
          </label>
          <label className="field">
            <span>Every (minutes)</span>
            <input
              type="number"
              min={1}
              value={intervalMinutes}
              onChange={(e) =>
                setIntervalMinutes(Number(e.target.value) || DEFAULT_AUTO_EXPAND.intervalMinutes)
              }
            />
          </label>
          <label className="field">
            <span>Max parallel tasks</span>
            <input
              type="number"
              min={1}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(Number(e.target.value) || 1)}
            />
          </label>
          <label className="field checkbox-field">
            <span>Enabled</span>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </label>
        </div>
        <div className="field-hint">
          The branch is created automatically if it doesn&apos;t exist (your checkout is never
          touched). Each accepted idea becomes a <code>feature/…</code> worktree task off it.
        </div>

        <label className="field">
          <span>Guidance for the idea agent (optional)</span>
          <textarea
            className="sentinel-prompt"
            rows={3}
            placeholder="Themes to explore, constraints, areas to avoid…"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && close()}
          />
        </label>

        <div className="field-hint">
          Each run spawns two headless, read-only claude agents (ideas + evaluation) and then a
          full implementation task — runs spend real API tokens, so prefer a generous interval.
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="autoexpand-runs">
          {runs.length === 0 ? (
            <div className="feature-empty">
              No runs yet — enable the timer or hit <strong>Run now</strong>.
            </div>
          ) : (
            runs.map((r) => <RunCard key={r.id} run={r} />)
          )}
        </div>

        <div className="modal-actions">
          <button
            className="btn"
            style={{ marginRight: 'auto' }}
            disabled={running}
            title={running ? 'A pipeline run is already in flight' : 'Run the pipeline once, right now'}
            onClick={() => void runNow()}
          >
            ▶ Run now
          </button>
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
