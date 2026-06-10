import { useState } from 'react'
import { useStore } from '../store'

/** Filesystem/branch-safe slug, mirrors GitService.slugify on the main side. */
function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'task'
  )
}

/**
 * Spin off a parallel task: a new git worktree (fresh branch) of the parent
 * session's repo, with claude launched in it. Shown while pendingWorktree is set.
 */
export function WorktreeTaskDialog(): JSX.Element {
  const confirm = useStore((s) => s.confirmWorktreeTask)
  const cancel = useStore((s) => s.cancelWorktreeTask)
  // Mounted only while pendingWorktree is non-null, so this is safe.
  const pending = useStore.getState().pendingWorktree!

  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const [branchEdited, setBranchEdited] = useState(false)
  const [baseBranch, setBaseBranch] = useState(pending.baseBranch)
  const [initialPrompt, setInitialPrompt] = useState('')

  // Auto-derive the branch from the task name until the user edits it directly.
  const onName = (v: string): void => {
    setName(v)
    if (!branchEdited) setBranch(v ? `claude/${slugify(v)}` : '')
  }

  const effectiveBranch = branch.trim() || (name.trim() ? `claude/${slugify(name)}` : '')

  const submit = (): void => {
    if (!effectiveBranch) return
    void confirm({
      name: name.trim() || effectiveBranch,
      branch: effectiveBranch,
      baseBranch: baseBranch.trim() || pending.baseBranch,
      initialPrompt
    })
  }

  return (
    <div className="modal-overlay" onClick={cancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New parallel task</h2>
        <div className="field-hint">
          Creates a git worktree off <strong>{pending.parentName}</strong> and launches claude in it,
          so this task runs alongside the others without touching the main checkout.
        </div>
        <div className="modal-folder" title={pending.repoRoot}>
          {pending.repoRoot}
        </div>

        <label className="field">
          <span>Task name</span>
          <input
            autoFocus
            placeholder="e.g. add retry to webhook sender"
            value={name}
            onChange={(e) => onName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel()
            }}
          />
        </label>

        <label className="field">
          <span>Branch</span>
          <input
            placeholder="claude/task"
            value={branch}
            onChange={(e) => {
              setBranchEdited(true)
              setBranch(e.target.value)
            }}
          />
        </label>

        <label className="field">
          <span>Base branch</span>
          <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
        </label>

        <label className="field">
          <span>First prompt (optional)</span>
          <textarea
            rows={3}
            placeholder="Typed into claude when it starts — you review and press Enter to send."
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.target.value)}
          />
        </label>

        <div className="modal-actions">
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!effectiveBranch}>
            Create task
          </button>
        </div>
      </div>
    </div>
  )
}
