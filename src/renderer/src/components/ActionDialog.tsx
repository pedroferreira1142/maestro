import { useState } from 'react'
import type { ActionShell, ReusableAction } from '../../../shared/types'
import { useStore } from '../store'

/** Shells offered for an action, per platform (first entry is the default). */
const SHELLS: { shell: ActionShell; label: string }[] =
  window.api.platform === 'win32'
    ? [
        { shell: 'powershell', label: 'PowerShell' },
        { shell: 'cmd', label: 'cmd' },
        { shell: 'bash', label: 'Git Bash' }
      ]
    : window.api.platform === 'darwin'
      ? [
          { shell: 'zsh', label: 'zsh' },
          { shell: 'bash', label: 'bash' }
        ]
      : [
          { shell: 'bash', label: 'bash' },
          { shell: 'zsh', label: 'zsh' }
        ]

/** Create/edit dialog for a reusable action (a saved shell command). */
export function ActionDialog(): JSX.Element {
  const close = useStore((s) => s.closeActionEditor)
  const saveAction = useStore((s) => s.saveAction)
  const deleteAction = useStore((s) => s.deleteAction)
  // Mounted only while actionEditor is non-null, so this is safe.
  const editor = useStore.getState().actionEditor!
  const existing: ReusableAction | null = editor === 'new' ? null : editor

  const [name, setName] = useState(existing?.name ?? '')
  const [command, setCommand] = useState(existing?.command ?? '')
  const [shell, setShell] = useState<ActionShell>(existing?.shell ?? SHELLS[0].shell)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const trimmedName = name.trim()
    const trimmedCommand = command.trim()
    if (!trimmedName || !trimmedCommand) {
      setError('A name and a command are both required.')
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
          <span>Command</span>
          <input
            placeholder="npm run build"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>

        <label className="field">
          <span>Shell</span>
          <select value={shell} onChange={(e) => setShell(e.target.value as ActionShell)}>
            {SHELLS.map((s) => (
              <option key={s.shell} value={s.shell}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <div className="field-hint">
          Runs in the session&apos;s folder, in a terminal tab named after the action — the same
          tab is reused when you re-trigger it.
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
