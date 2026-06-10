import { useEffect, useState } from 'react'
import type { ProjectUsage, TokenTotals, UsageSnapshot } from '../../../shared/types'
import { useStore } from '../store'

const POLL_MS = 60_000
/** Projects shown individually in the expanded list; the rest roll up. */
const MAX_ROWS = 8

/** Same path encoding Claude Code uses for ~/.claude/projects dir names. */
function encodeFolder(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-')
}

function fmtCost(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

function fmtTokens(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

function totalTokens(t: TokenTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens
}

/** Strip the encoded drive prefix ('C--repos-foo' -> 'repos-foo') for unmatched dirs. */
function dirLabel(dir: string): string {
  return dir.replace(/^[A-Za-z]--/, '')
}

interface Row {
  key: string
  label: string
  /** Set when the project maps to an open Maestro session. */
  isSession: boolean
  total: TokenTotals
  today: TokenTotals
}

export function UsageWidget(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api
        .getUsage()
        .then((s) => {
          if (alive) setSnap(s)
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  if (!snap) {
    return (
      <div className="usage-widget">
        <div className="usage-bar">
          <span className="usage-coin">◍</span>
          <span className="usage-dim">reading usage…</span>
        </div>
      </div>
    )
  }

  const byDir = new Map(sessions.map((s) => [encodeFolder(s.config.folder), s.config.name]))
  const rows: Row[] = snap.perProject.map((p: ProjectUsage) => {
    const name = byDir.get(p.dir)
    return {
      key: p.dir,
      label: name ?? dirLabel(p.dir),
      isSession: name != null,
      total: p.total,
      today: p.today
    }
  })
  // Open sessions first, then by all-time cost (perProject is already cost-sorted).
  rows.sort((a, b) => Number(b.isSession) - Number(a.isSession) || b.total.costUSD - a.total.costUSD)
  const shown = rows.slice(0, MAX_ROWS)
  const rest = rows.slice(MAX_ROWS)
  const restTotal = rest.reduce((sum, r) => sum + r.total.costUSD, 0)
  const restToday = rest.reduce((sum, r) => sum + r.today.costUSD, 0)

  return (
    <div className="usage-widget">
      {open && (
        <div className="usage-panel">
          <div className="usage-summary">
            <div className="usage-stat">
              <span className="usage-stat-value">{fmtCost(snap.today.costUSD)}</span>
              <span className="usage-stat-label">today</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{fmtCost(snap.month.costUSD)}</span>
              <span className="usage-stat-label">this month</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{fmtCost(snap.total.costUSD)}</span>
              <span className="usage-stat-label">all time</span>
            </div>
          </div>

          <div className="usage-tokens" title="input / output / cache write / cache read">
            <span>in {fmtTokens(snap.total.inputTokens)}</span>
            <span>out {fmtTokens(snap.total.outputTokens)}</span>
            <span>cache w {fmtTokens(snap.total.cacheWriteTokens)}</span>
            <span>cache r {fmtTokens(snap.total.cacheReadTokens)}</span>
          </div>

          <div className="usage-section">per session</div>
          <div className="usage-rows">
            {shown.map((r) => (
              <div className="usage-row" key={r.key} title={`${r.key}\n${fmtTokens(totalTokens(r.total))} tokens all time`}>
                <span className={`usage-row-name${r.isSession ? ' live' : ''}`}>
                  {r.isSession && <span className="usage-live-dot" />}
                  {r.label}
                </span>
                <span className="usage-row-today">{r.today.costUSD > 0 ? fmtCost(r.today.costUSD) : '—'}</span>
                <span className="usage-row-total">{fmtCost(r.total.costUSD)}</span>
              </div>
            ))}
            {rest.length > 0 && (
              <div className="usage-row dim">
                <span className="usage-row-name">{rest.length} more projects</span>
                <span className="usage-row-today">{restToday > 0 ? fmtCost(restToday) : '—'}</span>
                <span className="usage-row-total">{fmtCost(restTotal)}</span>
              </div>
            )}
            <div className="usage-row head">
              <span className="usage-row-name" />
              <span className="usage-row-today">today</span>
              <span className="usage-row-total">total</span>
            </div>
          </div>

          {snap.perModel.length > 0 && (
            <>
              <div className="usage-section">per model</div>
              <div className="usage-rows">
                {snap.perModel.map(({ model, totals }) => (
                  <div className="usage-row" key={model} title={`${fmtTokens(totalTokens(totals))} tokens`}>
                    <span className="usage-row-name">{model.replace(/^claude-/, '')}</span>
                    <span className="usage-row-total">{fmtCost(totals.costUSD)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <div
        className="usage-bar"
        title="Claude API usage parsed from ~/.claude/projects — click to expand"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="usage-coin">◍</span>
        <span className="usage-today">{fmtCost(snap.today.costUSD)} today</span>
        <span className="usage-dim">· {fmtCost(snap.total.costUSD)} total</span>
        <span className="usage-chevron">{open ? '▾' : '▴'}</span>
      </div>
    </div>
  )
}
