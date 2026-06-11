import { useEffect, useRef, useState } from 'react'
import type { ProjectUsage, TokenTotals, UsageProjection, UsageSnapshot } from '../../../shared/types'
import { useStore } from '../store'

const POLL_MS = 60_000
/** Projects shown individually in the popup list; the rest roll up. */
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

/** Share of a total as a whole-ish percentage; '<1%' for tiny non-zero slices. */
function fmtPct(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '—'
  const pct = (part / whole) * 100
  if (pct < 1) return '<1%'
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
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

function fmtDur(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 1) return 'less than a minute'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function fmtClock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** One-line burn-rate verdict for the current 5h window. */
function runOutLabel(p: UsageProjection, now: number): { text: string; warn: boolean } {
  if (p.runsOutAt != null) {
    const left = p.runsOutAt - now
    if (left <= 0) return { text: 'token limit reached — window resets in ' + fmtDur(p.blockEndAt - now), warn: true }
    return { text: `at this rate you run out of tokens in ${fmtDur(left)}`, warn: true }
  }
  if (p.maxBlockTokens > 0) {
    return { text: `on pace until the window resets (${fmtDur(p.blockEndAt - now)} left)`, warn: false }
  }
  return {
    text: `burning ${fmtTokens(Math.round(p.tokensPerMin))} tok/min · window resets in ${fmtDur(p.blockEndAt - now)}`,
    warn: false
  }
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
  /** Viewport coords of the popup, anchored above the usage bar when it opens. */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const widgetRef = useRef<HTMLDivElement>(null)

  const toggleOpen = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = widgetRef.current?.getBoundingClientRect()
    setAnchor(rect ? { left: rect.left + 6, bottom: window.innerHeight - rect.top + 6 } : null)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

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
  const now = Date.now()
  const proj = snap.projection
  const runOut = proj ? runOutLabel(proj, now) : null
  const shown = rows.slice(0, MAX_ROWS)
  const rest = rows.slice(MAX_ROWS)
  const restTotal = rest.reduce((sum, r) => sum + r.total.costUSD, 0)
  const restToday = rest.reduce((sum, r) => sum + r.today.costUSD, 0)

  return (
    <div className="usage-widget" ref={widgetRef}>
      {open && (
        <div className="usage-popup-overlay" onClick={() => setOpen(false)}>
          <div
            className="usage-popup"
            style={anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}
            onClick={(e) => e.stopPropagation()}
          >
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

            {proj && runOut && (
              <>
                <div className="usage-section">current 5h window</div>
                <div
                  className="usage-window"
                  title="Estimated from your transcripts: usage is grouped into 5-hour windows and the limit is your largest window so far"
                >
                  <div>
                    {fmtTokens(proj.blockTokens)} tokens used
                    {proj.maxBlockTokens > 0 && (
                      <> of ~{fmtTokens(proj.maxBlockTokens)} (largest window so far)</>
                    )}
                  </div>
                  <div>
                    burning {fmtTokens(Math.round(proj.tokensPerMin))} tok/min · window resets at{' '}
                    {fmtClock(proj.blockEndAt)}
                  </div>
                  <div className={runOut.warn ? 'usage-warn' : undefined}>{runOut.text}</div>
                </div>
              </>
            )}

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
                  <span className="usage-row-pct">{fmtPct(r.total.costUSD, snap.total.costUSD)}</span>
                </div>
              ))}
              {rest.length > 0 && (
                <div className="usage-row dim">
                  <span className="usage-row-name">{rest.length} more projects</span>
                  <span className="usage-row-today">{restToday > 0 ? fmtCost(restToday) : '—'}</span>
                  <span className="usage-row-total">{fmtCost(restTotal)}</span>
                  <span className="usage-row-pct">{fmtPct(restTotal, snap.total.costUSD)}</span>
                </div>
              )}
              <div className="usage-row head">
                <span className="usage-row-name" />
                <span className="usage-row-today">today</span>
                <span className="usage-row-total">total</span>
                <span className="usage-row-pct">share</span>
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
                      <span className="usage-row-pct">{fmtPct(totals.costUSD, snap.total.costUSD)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div
        className="usage-bar"
        title="Claude API usage parsed from ~/.claude/projects — click for details"
        onClick={toggleOpen}
      >
        <span className="usage-coin">◍</span>
        <span className="usage-today">{fmtCost(snap.today.costUSD)} today</span>
        <span className="usage-dim">· {fmtCost(snap.total.costUSD)} total</span>
        <span className="usage-chevron">{open ? '▾' : '▴'}</span>
        {runOut && (
          <span className={`usage-runout${runOut.warn ? ' usage-warn' : ''}`}>{runOut.text}</span>
        )}
      </div>
    </div>
  )
}
