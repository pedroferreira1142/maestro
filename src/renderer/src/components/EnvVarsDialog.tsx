import { useState } from 'react'
import { useStore } from '../store'

/** One editable row in the dialog; `id` is local-only, for stable React keys. */
interface Row {
  id: string
  key: string
  value: string
}

function rowsFromEnv(env: Record<string, string> | undefined): Row[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value
  }))
}

/**
 * Editor for a session's per-session environment variables. Lists the current
 * variables as key/value rows with add/remove, and on Save persists the cleaned
 * map (empty/whitespace-only keys dropped, last value wins on duplicate names)
 * and restarts the session's running terminals so the new environment applies.
 */
export function EnvVarsDialog(): JSX.Element {
  const close = useStore((s) => s.closeEnvEditor)
  const setSessionEnv = useStore((s) => s.setSessionEnv)
  // Mounted only while envEditorSessionId is non-null, so this is safe.
  const sessionId = useStore((s) => s.envEditorSessionId)!
  const session = useStore((s) => s.sessions.find((x) => x.config.id === sessionId))

  const [rows, setRows] = useState<Row[]>(() => rowsFromEnv(session?.config.env))
  const [busy, setBusy] = useState(false)

  const update = (id: string, patch: Partial<Row>): void =>
    setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const addRow = (): void =>
    setRows((list) => [...list, { id: crypto.randomUUID(), key: '', value: '' }])
  const removeRow = (id: string): void => setRows((list) => list.filter((r) => r.id !== id))

  const save = async (): Promise<void> => {
    // Drop rows with an empty/whitespace-only key; trim keys; last value wins.
    const env: Record<string, string> = {}
    for (const r of rows) {
      const key = r.key.trim()
      if (key) env[key] = r.value
    }
    setBusy(true)
    try {
      await setSessionEnv(sessionId, env)
    } finally {
      setBusy(false)
    }
    close()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Environment variables</h2>
        <div className="field-hint">
          Set for <strong>{session?.config.name ?? 'this session'}</strong>. These are merged into
          every terminal this session spawns (claude and shells), overriding any inherited variable
          of the same name. Saving restarts the session’s running terminals.
        </div>

        <div className="spec-list">
          {rows.length === 0 && (
            <div className="feature-empty">No variables yet. Add one below.</div>
          )}
          {rows.map((r) => (
            <div className="spec-row env-row" key={r.id}>
              <input
                className="env-key"
                placeholder="NAME"
                value={r.key}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => update(r.id, { key: e.target.value })}
              />
              <span className="env-eq">=</span>
              <input
                className="env-value"
                placeholder="value"
                value={r.value}
                spellCheck={false}
                onChange={(e) => update(r.id, { value: e.target.value })}
              />
              <button className="btn ghost" title="Remove variable" onClick={() => removeRow(r.id)}>
                ✕
              </button>
            </div>
          ))}
          <button className="btn ghost spec-add" onClick={addRow}>
            ＋ Add variable
          </button>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
