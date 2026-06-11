import { useStore } from '../store'

/**
 * Sidebar section listing the saved reusable actions: shell commands like
 * "npm run build", or claude prompts. Clicking a row runs it in this session —
 * shell commands go to the action's own terminal tab (reused on re-trigger),
 * claude prompts go to the session's claude conversation.
 */
export function ActionsPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const actions = useStore((s) => s.actions)
  const runAction = useStore((s) => s.runAction)
  const openActionEditor = useStore((s) => s.openActionEditor)

  return (
    <div className="actions">
      <div className="actions-header">
        <span>Actions</span>
        <button className="btn ghost" title="New action" onClick={() => openActionEditor('new')}>
          ＋
        </button>
      </div>
      {actions.length === 0 ? (
        <div className="actions-empty">
          Save a claude prompt or a command (build, test…) and re-run it from here in any session.
        </div>
      ) : (
        actions.map((a) => (
          <div
            key={a.id}
            className="action-row"
            title={`${a.command}  (${a.shell})`}
            onClick={() => void runAction(sessionId, a.id)}
          >
            <span className="action-run">{a.shell === 'claude' ? '✦' : '▶'}</span>
            <span className="action-name">{a.name}</span>
            <button
              className="btn ghost action-edit"
              title="Edit action"
              onClick={(e) => {
                e.stopPropagation()
                openActionEditor(a)
              }}
            >
              ✎
            </button>
          </div>
        ))
      )}
    </div>
  )
}
