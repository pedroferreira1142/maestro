import { useEffect, useState } from 'react'
import { Activity, Coins, Hourglass, Zap } from 'lucide-react'
import type { SessionInfo, TokenEfficiencyStatus, TokenTotals } from '../../../shared/types'
import { useStore } from '../store'
import { jumpToAttentionTerminal } from '../termRegistry'
import { Icon, StatusIcon } from './Icon'
import { STATUS_LABEL } from './SessionSidebar'

/** How often the status bar's usage/efficiency figures refresh. */
const TOKEN_POLL_MS = 30_000

/** Same path encoding Claude Code uses for ~/.claude/projects dir names. */
function encodeFolder(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-')
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

export function StatusBar({ session }: { session: SessionInfo }): JSX.Element {
  const [, tick] = useState(0)
  const viewer = useStore((s) => s.viewers[session.config.id])
  const waiting = useStore((s) => s.attentionQueue.length)
  const openSettings = useStore((s) => s.openSettings)

  /** Session tokens today (from transcripts) and live efficiency status. */
  const [todayTokens, setTodayTokens] = useState<number | null>(null)
  const [te, setTe] = useState<TokenEfficiencyStatus | null>(null)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api
        .getUsage()
        .then((snap) => {
          if (!alive) return
          const dir = encodeFolder(session.config.folder)
          const project = snap.perProject.find((p) => p.dir === dir)
          setTodayTokens(project ? totalTokens(project.today) : null)
        })
        .catch(() => {})
      void window.api
        .getTokenEfficiencyStatus(session.config.id)
        .then((s) => {
          if (alive) setTe(s)
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, TOKEN_POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [session.config.id, session.config.folder])

  // Status bar reflects the active terminal (or the first one if a file tab is shown).
  const activeTab = viewer?.active
  const term =
    session.terminals.find((t) => t.config.id === activeTab) ?? session.terminals[0] ?? null
  const status = term?.status ?? session.status

  const age =
    term && term.lastOutputAt > 0
      ? `last output ${Math.max(0, Math.round((Date.now() - term.lastOutputAt) / 1000))}s ago`
      : ''

  /** Rough per-terminal token estimate from streamed output (~4 chars/token). */
  const termTokens = term && term.outputChars > 0 ? Math.round(term.outputChars / 4) : 0
  const teOn = te?.effective.enabled ?? false

  return (
    <div className="statusbar">
      <span className={`status-pill status-${status}`}>
        <StatusIcon status={status} size={12} /> {STATUS_LABEL[status]}
      </span>
      <span className="statusbar-folder" title={session.config.folder}>
        {session.config.folder}
      </span>
      {term?.pid != null && <span>pid {term.pid}</span>}
      <span className="statusbar-tokens">
        {todayTokens != null && todayTokens > 0 && (
          <span title="Tokens this session's project consumed today (all kinds, from ~/.claude/projects transcripts)">
            <Icon icon={Coins} size={12} /> {fmtTokens(todayTokens)} tok today
          </span>
        )}
        {termTokens > 0 && (
          <span title="Rough estimate from this terminal's streamed output this run (~4 chars/token)">
            <Icon icon={Activity} size={12} /> {fmtTokens(termTokens)} tok streamed
          </span>
        )}
        {teOn && te && (
          <button
            className={`statusbar-te${te.pendingRestart ? ' pending' : ''}`}
            title={
              te.pendingRestart
                ? 'Token Efficiency settings changed — restart this claude terminal to apply. Click to open settings.'
                : `Token Efficiency active — est. ~${fmtTokens(te.savings.savedTokens)} tokens saved here ` +
                  `(${te.savings.filteredCommands} compressed, ${te.savings.rtkRewrites} rtk, ` +
                  `${te.savings.blockedReads} reads blocked). Click to open settings.`
            }
            onClick={() => openSettings('token-efficiency')}
          >
            <Icon icon={Zap} size={12} />{' '}
            {te.pendingRestart ? 'restart to apply' : `saved ~${fmtTokens(te.savings.savedTokens)}`}
          </button>
        )}
      </span>
      {waiting > 0 && (
        <button
          className="statusbar-attention"
          title="Jump to the longest-waiting terminal (Ctrl+`)"
          onClick={jumpToAttentionTerminal}
        >
          <Icon icon={Hourglass} size={12} /> {waiting} waiting
        </button>
      )}
      <span className="statusbar-age">{age}</span>
    </div>
  )
}
