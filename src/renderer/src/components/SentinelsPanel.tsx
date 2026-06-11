import { useEffect, useState } from 'react'
import type {
  SentinelConfig,
  SentinelRun,
  SentinelSeverity,
  SessionInfo
} from '../../../shared/types'
import { useStore } from '../store'

const SEVERITY_RANK: Record<SentinelSeverity, number> = { info: 0, warning: 1, critical: 2 }

function worstSeverity(run: SentinelRun): SentinelSeverity {
  let worst: SentinelSeverity = 'info'
  for (const f of run.findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity
  }
  return worst
}

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

function triggerLabel(s: SentinelConfig): string {
  return s.trigger === 'commit' ? 'on commit' : `every ${s.intervalMinutes ?? 15}m`
}

/** Status glyph for a sentinel, derived from its most recent run. */
function StatusGlyph({ run, enabled }: { run: SentinelRun | null; enabled: boolean }): JSX.Element {
  if (!enabled) return <span className="sentinel-glyph off" title="Disabled">⏸</span>
  if (!run) return <span className="sentinel-glyph idle" title="Waiting for trigger">○</span>
  switch (run.status) {
    case 'running':
      return <span className="sentinel-glyph running" title="Running…">⟳</span>
    case 'ok':
      return <span className="sentinel-glyph ok" title="All clear">✓</span>
    case 'error':
      return <span className="sentinel-glyph error" title={run.summary}>!</span>
    case 'findings':
      return (
        <span className={`sentinel-glyph sev-${worstSeverity(run)}`} title="Has findings">
          {run.findings.length}
        </span>
      )
  }
}

function RunDetails({ run }: { run: SentinelRun }): JSX.Element {
  const openFile = useStore((s) => s.openFile)
  return (
    <div className="sentinel-run">
      <div className="sentinel-run-meta">
        {run.status === 'running' ? 'running' : timeAgo(run.finishedAt ?? run.startedAt) + ' ago'}
        {' · '}
        {run.reason}
      </div>
      {run.summary && (
        <div className={`sentinel-summary${run.status === 'error' ? ' error' : ''}`}>
          {run.summary}
        </div>
      )}
      {run.findings.map((f, i) => (
        <div key={i} className={`sentinel-finding sev-${f.severity}`}>
          <div className="sentinel-finding-title">
            <span className="sev-dot" />
            {f.title}
          </div>
          <div className="sentinel-finding-detail">{f.detail}</div>
          {f.file && (
            <div
              className="sentinel-finding-file"
              title="Open in viewer"
              onClick={(e) => {
                e.stopPropagation()
                openFile(run.sessionId, f.file!.replace(/\\/g, '/'))
              }}
            >
              {f.file}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Sidebar section listing the session's sentinels (background watcher agents).
 * Each row shows the outcome of the latest run; expanding it reveals the
 * summary and severity-tagged findings. Configs are edited via SentinelDialog.
 */
export function SentinelsPanel({ session }: { session: SessionInfo }): JSX.Element {
  const id = session.config.id
  const sentinels = session.config.sentinels ?? []
  const runs = useStore((s) => s.sentinelRuns[id])
  const loadSentinelRuns = useStore((s) => s.loadSentinelRuns)
  const runSentinel = useStore((s) => s.runSentinel)
  const openSentinelEditor = useStore((s) => s.openSentinelEditor)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    void loadSentinelRuns(id)
  }, [id, loadSentinelRuns])

  const latestRunOf = (sentinelId: string): SentinelRun | null =>
    runs?.find((r) => r.sentinelId === sentinelId) ?? null

  return (
    <div className="sentinels">
      <div className="sentinels-header">
        <span>Sentinels</span>
        <button
          className="btn ghost"
          title="New sentinel — a background agent watching this session's repo"
          onClick={() => openSentinelEditor(id, 'new')}
        >
          ＋
        </button>
      </div>
      {sentinels.length === 0 ? (
        <div className="sentinels-empty">
          Put an agent on watch — review incoming commits for convention violations or bugs, or
          poll for PRs.
        </div>
      ) : (
        sentinels.map((s) => {
          const latest = latestRunOf(s.id)
          const isOpen = expanded === s.id
          return (
            <div key={s.id} className="sentinel">
              <div
                className="sentinel-row"
                title={s.prompt}
                onClick={() => setExpanded(isOpen ? null : s.id)}
              >
                <StatusGlyph run={latest} enabled={s.enabled} />
                <span className="sentinel-name">{s.name}</span>
                <span className="sentinel-trigger">{triggerLabel(s)}</span>
                <button
                  className="btn ghost sentinel-btn"
                  title="Run now"
                  disabled={latest?.status === 'running'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setExpanded(s.id)
                    void runSentinel(id, s.id)
                  }}
                >
                  ▶
                </button>
                <button
                  className="btn ghost sentinel-btn"
                  title="Edit sentinel"
                  onClick={(e) => {
                    e.stopPropagation()
                    openSentinelEditor(id, s)
                  }}
                >
                  ✎
                </button>
                <span className="sentinel-chevron">{isOpen ? '▾' : '▸'}</span>
              </div>
              {isOpen &&
                (latest ? (
                  <RunDetails run={latest} />
                ) : (
                  <div className="sentinel-run sentinel-run-meta">
                    No runs yet — waiting for {triggerLabel(s)}.
                  </div>
                ))}
            </div>
          )
        })
      )}
    </div>
  )
}
