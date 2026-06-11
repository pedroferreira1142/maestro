import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, SessionStatus, TerminalInfo, TerminalKind } from '../../../shared/types'
import { diffTabPath, isDiffTab, useStore } from '../store'

const STATUS_GLYPH: Record<SessionStatus, string> = {
  starting: '◌',
  working: '⟳',
  'needs-attention': '●',
  idle: '○',
  exited: '✕',
  error: '!'
}

const KIND_ICON: Record<TerminalKind, string> = {
  claude: '✶',
  powershell: '❯_',
  cmd: '▤',
  bash: '$_',
  zsh: '%_'
}

/** Terminal kinds offered by the ＋▾ menu, per platform. */
const ADD_MENU: { kind: TerminalKind; label: string }[] =
  window.api.platform === 'win32'
    ? [
        { kind: 'claude', label: 'Claude' },
        { kind: 'powershell', label: 'PowerShell' },
        { kind: 'cmd', label: 'cmd' },
        { kind: 'bash', label: 'Git Bash' }
      ]
    : [
        { kind: 'claude', label: 'Claude' },
        { kind: 'zsh', label: 'zsh' },
        { kind: 'bash', label: 'bash' }
      ]

function TerminalTab({
  sessionId,
  terminal,
  active,
  canClose
}: {
  sessionId: string
  terminal: TerminalInfo
  active: boolean
  canClose: boolean
}): JSX.Element {
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTerminal = useStore((s) => s.closeTerminal)
  const renameTerminal = useStore((s) => s.renameTerminal)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(terminal.config.title)
  const id = terminal.config.id

  const commit = (): void => {
    setEditing(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== terminal.config.title) void renameTerminal(id, trimmed)
    else setName(terminal.config.title)
  }

  return (
    <div
      className={`tab term-tab status-${terminal.status}${active ? ' active' : ''}`}
      title={`${terminal.config.kind} · ${terminal.status}`}
      onClick={() => setActiveTab(sessionId, id)}
    >
      <span className={`tab-icon glyph status-${terminal.status}`}>
        {STATUS_GLYPH[terminal.status]}
      </span>
      <span className="tab-kind">{KIND_ICON[terminal.config.kind]}</span>
      {editing ? (
        <input
          className="rename-input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setName(terminal.config.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="tab-name" onDoubleClick={() => setEditing(true)}>
          {terminal.config.title}
        </span>
      )}
      {canClose && (
        <button
          className="btn ghost close"
          title="Close terminal"
          onClick={(e) => {
            e.stopPropagation()
            void closeTerminal(sessionId, id)
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}

function AddTerminalMenu({ sessionId }: { sessionId: string }): JSX.Element {
  const addTerminal = useStore((s) => s.addTerminal)
  // Fixed-position coordinates: the menu must escape the tabstrip, whose
  // overflow-x:auto would clip an absolutely-positioned child on both axes.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuPos) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuPos(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuPos])

  const toggle = (): void => {
    if (menuPos) {
      setMenuPos(null)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setMenuPos({ x: r.left, y: r.bottom + 2 })
  }

  return (
    <div className="tab-add" ref={ref}>
      <button ref={btnRef} className="tab tab-add-btn" title="New terminal" onClick={toggle}>
        ＋▾
      </button>
      {menuPos && (
        <div className="tab-add-menu" style={{ left: menuPos.x, top: menuPos.y }}>
          {ADD_MENU.map(({ kind, label }) => (
            <button
              key={kind}
              className="tab-add-item"
              onClick={() => {
                setMenuPos(null)
                void addTerminal(sessionId, kind)
              }}
            >
              <span className="tab-kind">{KIND_ICON[kind]}</span> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TabStrip({ session }: { session: SessionInfo }): JSX.Element {
  const id = session.config.id
  const viewer = useStore((s) => s.viewers[id])
  const active = viewer?.active ?? session.config.activeTerminalId ?? ''
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const canCloseTerminal = session.terminals.length > 1

  return (
    <div className="tabstrip">
      {session.terminals.map((t) => (
        <TerminalTab
          key={t.config.id}
          sessionId={id}
          terminal={t}
          active={active === t.config.id}
          canClose={canCloseTerminal}
        />
      ))}
      <AddTerminalMenu sessionId={id} />
      {(viewer?.tabs ?? []).map((tab) => {
        const diff = isDiffTab(tab)
        const relPath = diff ? diffTabPath(tab) : tab
        return (
          <div
            key={tab}
            className={`tab${diff ? ' diff-tab' : ''}${active === tab ? ' active' : ''}`}
            title={diff ? `Diff (working tree vs HEAD) · ${relPath}` : relPath}
            onClick={() => setActiveTab(id, tab)}
          >
            {diff && <span className="tab-diff-badge">±</span>}
            <span className="tab-name">{relPath.split('/').pop()}</span>
            <button
              className="btn ghost close"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(id, tab)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
