import { useCallback, useEffect, useState } from 'react'
import type {
  TokenEfficiencyConfig,
  TokenEfficiencyOverride,
  TokenEfficiencyStatus
} from '../../../shared/types'
import { useStore } from '../store'

/** How often the focused session's live status refreshes while the tab is open. */
const STATUS_POLL_MS = 10_000

/** The per-tool toggles shown in the global section and the override scopes. */
const TOOLS: { key: keyof TokenEfficiencyOverride; label: string; hint: string }[] = [
  {
    key: 'outputCompression',
    label: 'Output compression',
    hint: 'Rewrites noisy commands (git, installs, builds, test runs) so their output is compressed — via rtk when installed, else Maestro’s built-in filter. Matched commands are auto-approved.'
  },
  {
    key: 'codeGraph',
    label: 'Code graph / repo map',
    hint: 'Generates a compact symbol map of the repo and injects it at session start, so Claude navigates by symbols instead of reading whole files. Refreshed when git HEAD moves.'
  },
  {
    key: 'truncationHooks',
    label: 'Output truncation',
    hint: 'Caps Bash/MCP tool output sizes (env limits) and blocks whole-file reads of giant token sinks: lockfiles, logs, node_modules/dist artifacts.'
  },
  {
    key: 'promptCachingHints',
    label: 'Prompt-caching hints',
    hint: 'Strips DISABLE_PROMPT_CACHING from the spawn environment so an inherited shell setting can’t silently disable prompt caching (~10× input cost).'
  }
]

type TriState = 'inherit' | 'on' | 'off'

function toTri(v: boolean | undefined): TriState {
  return v === undefined ? 'inherit' : v ? 'on' : 'off'
}

function fromTri(v: TriState): boolean | undefined {
  return v === 'inherit' ? undefined : v === 'on'
}

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

/** One tri-state (inherit/on/off) override row. */
function OverrideRow({
  label,
  value,
  onChange
}: {
  label: string
  value: boolean | undefined
  onChange: (v: boolean | undefined) => void
}): JSX.Element {
  return (
    <label className="te-override-row">
      <span className="te-override-name">{label}</span>
      <select value={toTri(value)} onChange={(e) => onChange(fromTri(e.target.value as TriState))}>
        <option value="inherit">inherit</option>
        <option value="on">on</option>
        <option value="off">off</option>
      </select>
    </label>
  )
}

/** Editor for one override scope (repo or session). */
function OverrideEditor({
  title,
  hint,
  override,
  onSave
}: {
  title: string
  hint: string
  override: TokenEfficiencyOverride | null
  onSave: (next: TokenEfficiencyOverride | null) => void
}): JSX.Element {
  const ov = override ?? {}
  const patch = (key: keyof TokenEfficiencyOverride, v: boolean | undefined): void => {
    const next: TokenEfficiencyOverride = { ...ov, [key]: v }
    const any = Object.values(next).some((x) => x !== undefined)
    onSave(any ? next : null)
  }
  return (
    <div className="te-override">
      <div className="te-override-title" title={hint}>
        {title}
      </div>
      <OverrideRow label="Master switch" value={ov.enabled} onChange={(v) => patch('enabled', v)} />
      {TOOLS.map((t) => (
        <OverrideRow
          key={t.key}
          label={t.label}
          value={ov[t.key]}
          onChange={(v) => patch(t.key, v)}
        />
      ))}
    </div>
  )
}

/** A green/grey chip indicating whether one tool is active in the session. */
function ToolChip({ name, on }: { name: string; on: boolean }): JSX.Element {
  return <span className={`te-chip${on ? ' on' : ''}`}>{name}</span>
}

/**
 * Settings → Token Efficiency: the global toolkit configuration (master +
 * per-tool toggles + limits), and a live section for the focused session —
 * status indicator of what's active, per-repo/per-session overrides, repo-map
 * facts and the accumulated savings estimate.
 */
export function TokenEfficiencyTab(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const close = useStore((s) => s.closeSettings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const activeId = useStore((s) => s.activeId)
  const restartTerminal = useStore((s) => s.restartTerminal)
  const showNotice = useStore((s) => s.showNotice)
  const session = useStore((s) => s.sessions.find((x) => x.config.id === s.activeId) ?? null)

  const [cfg, setCfg] = useState<TokenEfficiencyConfig | null>(
    settings ? { ...settings.tokenEfficiency } : null
  )
  const [status, setStatus] = useState<TokenEfficiencyStatus | null>(null)
  const [refreshingMap, setRefreshingMap] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    if (!activeId) {
      setStatus(null)
      return
    }
    try {
      setStatus(await window.api.getTokenEfficiencyStatus(activeId))
    } catch {
      setStatus(null)
    }
  }, [activeId])

  useEffect(() => {
    void loadStatus()
    const t = setInterval(() => void loadStatus(), STATUS_POLL_MS)
    return () => clearInterval(t)
  }, [loadStatus])

  if (!cfg) return <div className="field-hint">Loading…</div>

  const num = (key: 'bashMaxOutputChars' | 'mcpMaxOutputTokens' | 'largeReadMaxKB' | 'repoMapMaxFiles') =>
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const v = parseInt(e.target.value, 10)
      setCfg({ ...cfg, [key]: isNaN(v) ? 0 : v })
    }

  const commit = async (): Promise<void> => {
    await window.api.saveTokenEfficiency(cfg)
    await reloadSettings()
    showNotice('Token Efficiency settings saved')
    close()
  }

  const saveRepoOverride = async (next: TokenEfficiencyOverride | null): Promise<void> => {
    if (!activeId) return
    await window.api.setTokenEfficiencyRepoOverride(activeId, next)
    await loadStatus()
  }

  const saveSessionOverride = async (next: TokenEfficiencyOverride | null): Promise<void> => {
    if (!activeId) return
    await window.api.setTokenEfficiencySessionOverride(activeId, next)
    await loadStatus()
  }

  const restartClaude = async (): Promise<void> => {
    if (!session) return
    const ids = session.terminals
      .filter((t) => t.config.kind === 'claude' && t.status !== 'exited' && t.status !== 'error')
      .map((t) => t.config.id)
    for (const id of ids) await restartTerminal(id, 'resume')
    await loadStatus()
  }

  const refreshMap = async (): Promise<void> => {
    if (!activeId) return
    setRefreshingMap(true)
    try {
      await window.api.refreshRepoMap(activeId)
      await loadStatus()
    } finally {
      setRefreshingMap(false)
    }
  }

  const redetect = async (): Promise<void> => {
    await window.api.detectEfficiencyTools(true)
    await loadStatus()
  }

  const eff = status?.effective
  const savings = status?.savings

  return (
    <>
      <p className="field-hint">
        Cuts Claude token usage by compressing noisy command output, injecting a repo symbol map,
        truncating giant tool outputs and protecting prompt caching. Settings are materialized when
        a claude terminal starts — <strong>running terminals pick changes up on restart</strong>.
      </p>

      <div className="te-layout">
        <div className="te-global">
          <label className="skill-row te-master">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            />
            <span className="skill-name">Enable Token Efficiency toolkit</span>
          </label>

          <div className={`te-tools${cfg.enabled ? '' : ' te-disabled'}`}>
            {TOOLS.map((t) => (
              <label key={t.key} className="skill-row" title={t.hint}>
                <input
                  type="checkbox"
                  disabled={!cfg.enabled}
                  checked={cfg[t.key as keyof TokenEfficiencyConfig] as boolean}
                  onChange={(e) => setCfg({ ...cfg, [t.key]: e.target.checked })}
                />
                <span className="skill-name">{t.label}</span>
              </label>
            ))}
          </div>

          {status && (
            <div className="field-hint te-detect">
              {status.rtk.found ? (
                <>rtk detected: compression upgrades git commands ({status.rtk.path})</>
              ) : (
                <>rtk not found on PATH — the built-in output filter is used instead.</>
              )}
              {!status.nodeFound && (
                <div className="te-warn">
                  ⚠ node not found on PATH — hook-based tools (compression, repo map, read guard)
                  can’t run; only the env output caps apply.
                </div>
              )}
              <button className="btn ghost te-mini" onClick={() => void redetect()}>
                Re-detect
              </button>
            </div>
          )}

          <div className="te-limits">
            <label className="field">
              <span>Bash output cap (chars)</span>
              <input type="number" min={1000} value={cfg.bashMaxOutputChars} onChange={num('bashMaxOutputChars')} />
            </label>
            <label className="field">
              <span>MCP output cap (tokens)</span>
              <input type="number" min={1000} value={cfg.mcpMaxOutputTokens} onChange={num('mcpMaxOutputTokens')} />
            </label>
            <label className="field">
              <span>Block reads of token sinks over (KB)</span>
              <input type="number" min={8} value={cfg.largeReadMaxKB} onChange={num('largeReadMaxKB')} />
            </label>
            <label className="field">
              <span>Repo map: max files</span>
              <input type="number" min={20} value={cfg.repoMapMaxFiles} onChange={num('repoMapMaxFiles')} />
            </label>
          </div>
        </div>

        <div className="te-session">
          {!session || !status ? (
            <div className="field-hint">Open a session to see its live status and overrides.</div>
          ) : (
            <>
              <div className="te-override-title">
                Focused session: {session.config.name}
                {session.config.worktree ? ' (worktree task)' : ''}
              </div>

              <div className="te-chips">
                <ToolChip name={eff?.enabled ? 'toolkit on' : 'toolkit off'} on={!!eff?.enabled} />
                {TOOLS.map((t) => (
                  <ToolChip
                    key={t.key}
                    name={t.label}
                    on={!!eff?.enabled && !!(eff?.[t.key as keyof TokenEfficiencyConfig] as boolean)}
                  />
                ))}
              </div>

              {status.pendingRestart && (
                <div className="te-warn">
                  ⟳ This session’s claude is running with older settings.{' '}
                  <button className="btn te-mini" onClick={() => void restartClaude()}>
                    Restart claude to apply
                  </button>
                </div>
              )}

              {eff?.enabled && eff.codeGraph && (
                <div className="field-hint te-map">
                  {status.repoMap ? (
                    <>
                      Repo map: {status.repoMap.files} files · {status.repoMap.symbols} symbols ·{' '}
                      {Math.round(status.repoMap.bytes / 1024)} KB · generated{' '}
                      {new Date(status.repoMap.generatedAt).toLocaleTimeString()}
                    </>
                  ) : (
                    <>Repo map: not generated yet.</>
                  )}{' '}
                  <button
                    className="btn ghost te-mini"
                    disabled={refreshingMap}
                    onClick={() => void refreshMap()}
                  >
                    {refreshingMap ? 'Refreshing…' : 'Refresh map'}
                  </button>
                </div>
              )}

              {savings && (
                <div className="field-hint">
                  Estimated savings here: <strong>~{fmtTokens(savings.savedTokens)} tokens</strong>{' '}
                  ({savings.filteredCommands} compressed, {savings.rtkRewrites} via rtk,{' '}
                  {savings.blockedReads} giant reads blocked)
                </div>
              )}

              <div className="te-overrides">
                <OverrideEditor
                  title="Repo override"
                  hint="Applies to every session of this repo, including its worktree tasks."
                  override={status.repoOverride}
                  onSave={(o) => void saveRepoOverride(o)}
                />
                <OverrideEditor
                  title="Session override"
                  hint="Applies to this session only; wins over the repo override."
                  override={status.sessionOverride}
                  onSave={(o) => void saveSessionOverride(o)}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void commit()}>
          Save
        </button>
      </div>
    </>
  )
}
