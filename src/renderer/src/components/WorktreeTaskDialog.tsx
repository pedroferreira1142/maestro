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

const TASK_TYPES = [
  { value: 'parallel', label: 'Parallel' },
  { value: 'feature', label: 'Feature' },
  { value: 'bug', label: 'Bug' }
] as const

type TaskType = (typeof TASK_TYPES)[number]['value']

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
  const [taskType, setTaskType] = useState<TaskType>('parallel')
  const [branch, setBranch] = useState('')
  const [branchEdited, setBranchEdited] = useState(false)
  const [baseBranch, setBaseBranch] = useState(pending.baseBranch)
  const [initialPrompt, setInitialPrompt] = useState('')
  // PR management: by default a task merges straight into its base branch.
  // Opt into a PR for review, and/or into doing it automatically when claude finishes.
  const [createPr, setCreatePr] = useState(false)
  const [autoComplete, setAutoComplete] = useState(false)

  // Auto-derive the branch from the type + task name until the user edits it directly.
  const onName = (v: string): void => {
    setName(v)
    if (!branchEdited) setBranch(v ? `${taskType}/${slugify(v)}` : '')
  }

  const onType = (t: TaskType): void => {
    setTaskType(t)
    if (!branchEdited) setBranch(name ? `${t}/${slugify(name)}` : '')
  }

  const effectiveBranch = branch.trim() || (name.trim() ? `${taskType}/${slugify(name)}` : '')

  const submit = (): void => {
    if (!effectiveBranch) return
    void confirm({
      name: name.trim() || effectiveBranch,
      branch: effectiveBranch,
      baseBranch: baseBranch.trim() || pending.baseBranch,
      initialPrompt,
      completion: createPr ? 'pr' : 'merge',
      autoComplete
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
          <span>Type</span>
          <select value={taskType} onChange={(e) => onType(e.target.value as TaskType)}>
            {TASK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Branch</span>
          <input
            placeholder={`${taskType}/task`}
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
            placeholder="Sent to claude automatically once it starts."
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.target.value)}
          />
        </label>

        <div className="field">
          <span>When the task is done</span>
          <label className="check-row">
            <input
              type="checkbox"
              checked={createPr}
              onChange={(e) => setCreatePr(e.target.checked)}
            />
            <span>
              Open a pull request for review
              <small className="check-hint">
                {createPr
                  ? `Push ${effectiveBranch || 'the branch'} and open a PR into ${baseBranch.trim() || pending.baseBranch} (needs the gh CLI). Otherwise it merges straight into the base branch.`
                  : `Otherwise it merges straight into ${baseBranch.trim() || pending.baseBranch}.`}
              </small>
            </span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={autoComplete}
              onChange={(e) => setAutoComplete(e.target.checked)}
            />
            <span>
              Do it automatically when claude finishes
              <small className="check-hint">
                Maestro commits pending work and {createPr ? 'opens the PR' : 'merges'} once the task
                sits idle. Auto-merge skips conflicting merges and leaves them for you.
              </small>
            </span>
          </label>
        </div>

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
