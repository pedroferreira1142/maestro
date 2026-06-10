import { useEffect, useState } from 'react'
import type { SessionInfo } from '../../../shared/types'
import { useStore } from '../store'

export function StatusBar({ session }: { session: SessionInfo }): JSX.Element {
  const [, tick] = useState(0)
  const viewer = useStore((s) => s.viewers[session.config.id])

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  // Status bar reflects the active terminal (or the first one if a file tab is shown).
  const activeTab = viewer?.active
  const term =
    session.terminals.find((t) => t.config.id === activeTab) ?? session.terminals[0] ?? null
  const status = term?.status ?? session.status

  const age =
    term && term.lastOutputAt > 0
      ? `last output ${Math.max(0, Math.round((Date.now() - term.lastOutputAt) / 1000))}s ago`
      : ''

  return (
    <div className="statusbar">
      <span className={`status-pill status-${status}`}>{status}</span>
      <span className="statusbar-folder" title={session.config.folder}>
        {session.config.folder}
      </span>
      {term?.pid != null && <span>pid {term.pid}</span>}
      <span className="statusbar-age">{age}</span>
    </div>
  )
}
