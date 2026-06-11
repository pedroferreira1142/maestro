import { useState } from 'react'
import type { ActionShell, ReusableAction } from '../../../shared/types'
import { useStore } from '../store'

/** Targets offered for an action, per platform (first entry is the default). */
const TARGETS: { shell: ActionShell; label: string }[] = [
  { shell: 'claude', label: 'Claude (prompt)' },
  ...(window.api.platform === 'win32'
    ? [
        { shell: 'powershell', label: 'PowerShell' } as const,
        { shell: 'cmd', label: 'cmd' } as const,
        { shell: 'bash', label: 'Git Bash' } as const
      ]
    : window.api.platform === 'darwin'
      ? [{ shell: 'zsh', label: 'zsh' } as const, { shell: 'bash', label: 'bash' } as const]
      : [{ shell: 'bash', label: 'bash' } as const, { shell: 'zsh', label: 'zsh' } as const])
]

/** Create/edit dialog for a reusable action (a saved claude prompt or shell command). */
export function ActionDialog(): JSX.Element {
  const close = useStore((s) => s.closeActionEditor)
  const saveAction = useStore((s) => s.saveAction)
  const deleteAction = useStore((s) => s.deleteAction)
  // Mounted only while actionEditor is non-null, so this is safe.
  const editor = useStore.getState().actionEditor!
  const existing: ReusableAction | null = editor === 'new' ? null : editor

  const [name, setName] = useState(existing?.name ?? '')
  const [command, setCommand] = useState(existing?.command ?? '')
  const [shell, setShell] = useState<ActionShell>(existing?.shell ?? TARGETS[0].shell)
  const [error, setError] = useState<string | null>(null)
  const isClaude = shell === 'claude'

  const submit = (): void => {
    const trimmedName = name.trim()
    const trimmedCommand = command.trim()
    if (!trimmedName || !trimmedCommand) {
      setError(`A name and a ${isClaude ? 'prompt' : 'command'} are both required.`)
      return
    }
    void saveAction({
      id: existing?.id ?? crypto.randomUUID(),
      name: trimmedName,
      command: trimmedCommand,
      shell
    })
    close()
  }

  const remove = (): void => {
    if (!existing) return
    if (!window.confirm(`Delete action "${existing.name}"?`)) return
    void deleteAction(existing.id)
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') close()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{existing ? 'Edit action' : 'New action'}</h2>

        <label className="field">
          <span>Name</span>
          <input
            autoFocus
            placeholder="Build"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>

        <label className="field">
          <span>{isClaude ? 'Prompt' : 'Command'}</span>
          <input
            placeholder={isClaude ? 'Summarize the changes on this branch' : 'npm run build'}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>

        <label className="field">
          <span>Runs in</span>
          <select value={shell} onChange={(e) => setShell(e.target.value as ActionShell)}>
            {TARGETS.map((s) => (
              <option key={s.shell} value={s.shell}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <div className="field-hint">
          {isClaude
            ? 'The prompt is sent to the session’s Claude conversation and submitted — usable in any session or repo.'
            : 'Runs in the session’s folder, in a terminal tab named after the action — the same tab is reused when you re-trigger it.'}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          {existing && (
            <button className="btn" style={{ marginRight: 'auto' }} onClick={remove}>
              Delete
            </button>
          )}
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
