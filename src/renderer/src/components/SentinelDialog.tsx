import { useState } from 'react'
import type { SentinelConfig, SentinelTrigger } from '../../../shared/types'
import { SENTINEL_TEMPLATES } from '../../../shared/types'
import { useStore } from '../store'

/**
 * Create/edit dialog for a sentinel (a background watcher agent). Picking a
 * built-in template prefills the name, trigger and prompt; everything stays
 * editable afterwards.
 */
export function SentinelDialog(): JSX.Element {
  const close = useStore((s) => s.closeSentinelEditor)
  const saveSentinel = useStore((s) => s.saveSentinel)
  const deleteSentinel = useStore((s) => s.deleteSentinel)
  // Mounted only while sentinelEditor is non-null, so this is safe.
  const { sessionId, sentinel } = useStore.getState().sentinelEditor!
  const existing: SentinelConfig | null = sentinel === 'new' ? null : sentinel

  const [name, setName] = useState(existing?.name ?? '')
  const [prompt, setPrompt] = useState(existing?.prompt ?? '')
  const [trigger, setTrigger] = useState<SentinelTrigger>(existing?.trigger ?? 'commit')
  const [intervalMinutes, setIntervalMinutes] = useState(existing?.intervalMinutes ?? 15)
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [templateId, setTemplateId] = useState<string>(existing?.templateId ?? '')
  const [error, setError] = useState<string | null>(null)

  const applyTemplate = (id: string): void => {
    setTemplateId(id)
    const tpl = SENTINEL_TEMPLATES.find((t) => t.id === id)
    if (!tpl) return
    setName(tpl.name)
    setPrompt(tpl.prompt)
    setTrigger(tpl.trigger)
    if (tpl.intervalMinutes) setIntervalMinutes(tpl.intervalMinutes)
  }

  const submit = (): void => {
    const trimmedName = name.trim()
    const trimmedPrompt = prompt.trim()
    if (!trimmedName || !trimmedPrompt) {
      setError('A name and watch instructions are both required.')
      return
    }
    void saveSentinel(sessionId, {
      id: existing?.id ?? crypto.randomUUID(),
      name: trimmedName,
      prompt: trimmedPrompt,
      trigger,
      ...(trigger === 'interval' ? { intervalMinutes: Math.max(1, intervalMinutes) } : {}),
      templateId: templateId || null,
      enabled
    })
    close()
  }

  const remove = (): void => {
    if (!existing) return
    if (!window.confirm(`Delete sentinel "${existing.name}"?`)) return
    void deleteSentinel(sessionId, existing.id)
    close()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{existing ? 'Edit sentinel' : 'New sentinel'}</h2>

        {!existing && (
          <label className="field">
            <span>Template</span>
            <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">Custom (start from scratch)</option>
              {SENTINEL_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id} title={t.description}>
                  {t.name} — {t.description}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span>Name</span>
          <input
            autoFocus
            placeholder="Convention guard"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && close()}
          />
        </label>

        <label className="field">
          <span>Watch instructions</span>
          <textarea
            className="sentinel-prompt"
            rows={6}
            placeholder="What should this agent look out for on each run?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && close()}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Trigger</span>
            <select value={trigger} onChange={(e) => setTrigger(e.target.value as SentinelTrigger)}>
              <option value="commit">On new commits (HEAD changes)</option>
              <option value="interval">On a timer</option>
            </select>
          </label>
          {trigger === 'interval' && (
            <label className="field">
              <span>Every (minutes)</span>
              <input
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Number(e.target.value) || 15)}
              />
            </label>
          )}
          <label className="field checkbox-field">
            <span>Enabled</span>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </label>
        </div>

        <div className="field-hint">
          Each run spawns a headless, read-only claude in the session&apos;s folder (it can read
          files, git history and gh PR info — never write). Findings appear in the Sentinels
          panel. Runs spend API tokens, so prefer the commit trigger over short timers.
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
