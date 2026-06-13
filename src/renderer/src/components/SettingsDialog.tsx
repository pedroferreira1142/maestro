import { useEffect, useMemo, useState } from 'react'
import type { McpServerDef, RepoCategory } from '../../../shared/types'
import { useStore } from '../store'
import { TokenEfficiencyTab } from './TokenEfficiencyTab'

const COLORS = ['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#d97757', '#e5484d']

/** Editing shape: MCP config is held as raw text so it can be invalid mid-edit. */
interface EditServer {
  uid: string
  name: string
  configText: string
}
interface EditCategory extends Omit<RepoCategory, 'mcpServers'> {
  mcpServers: EditServer[]
}

function uid(): string {
  return crypto.randomUUID()
}

function toEdit(c: RepoCategory): EditCategory {
  return {
    ...c,
    enabledSkills: [...c.enabledSkills],
    detectFiles: [...c.detectFiles],
    mcpServers: c.mcpServers.map((s) => ({
      uid: uid(),
      name: s.name,
      configText: JSON.stringify(s.config, null, 2)
    }))
  }
}

/** The "Repo categories" tab — context profiles deciding skills/MCP per repo kind. */
function CategoriesTab(): JSX.Element {
  const storeCategories = useStore((s) => s.categories)
  const skills = useStore((s) => s.skills)
  const save = useStore((s) => s.saveCategories)
  const close = useStore((s) => s.closeSettings)

  const [cats, setCats] = useState<EditCategory[]>(() => storeCategories.map(toEdit))
  const [selectedId, setSelectedId] = useState<string | null>(cats[0]?.id ?? null)
  const [userServers, setUserServers] = useState<McpServerDef[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listUserMcpServers().then(setUserServers)
  }, [])

  const selected = useMemo(() => cats.find((c) => c.id === selectedId) ?? null, [cats, selectedId])

  const patch = (id: string, fn: (c: EditCategory) => EditCategory): void => {
    setCats((prev) => prev.map((c) => (c.id === id ? fn(c) : c)))
  }

  const addCategory = (): void => {
    const cat: EditCategory = {
      id: uid(),
      name: 'new-category',
      color: COLORS[cats.length % COLORS.length],
      enabledSkills: [],
      unlistedSkillFloor: 'name-only',
      mcpServers: [],
      detectFiles: []
    }
    setCats((prev) => [...prev, cat])
    setSelectedId(cat.id)
  }

  const deleteCategory = (id: string): void => {
    setCats((prev) => prev.filter((c) => c.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const toggleSkill = (id: string, skill: string): void => {
    patch(id, (c) => ({
      ...c,
      enabledSkills: c.enabledSkills.includes(skill)
        ? c.enabledSkills.filter((s) => s !== skill)
        : [...c.enabledSkills, skill]
    }))
  }

  const commit = (): void => {
    // Validate + convert every server's JSON before persisting anything.
    const out: RepoCategory[] = []
    for (const c of cats) {
      const servers: McpServerDef[] = []
      for (const s of c.mcpServers) {
        const name = s.name.trim()
        if (!name) {
          setError(`Category "${c.name}": an MCP server is missing a name.`)
          setSelectedId(c.id)
          return
        }
        let config: Record<string, unknown>
        try {
          config = JSON.parse(s.configText || '{}')
        } catch {
          setError(`Category "${c.name}", server "${name}": config is not valid JSON.`)
          setSelectedId(c.id)
          return
        }
        servers.push({ name, config })
      }
      out.push({
        id: c.id,
        name: c.name.trim() || 'category',
        color: c.color,
        enabledSkills: c.enabledSkills,
        unlistedSkillFloor: c.unlistedSkillFloor,
        mcpServers: servers,
        detectFiles: c.detectFiles
      })
    }
    void save(out).then(close)
  }

  return (
    <>
      <p className="field-hint">
        A category decides which skills load fully (others fall to its floor) and which MCP servers
        a repo of this kind gets. Changes apply when a session using the category next starts or is
        restarted.
      </p>

      <div className="cat-layout">
        <div className="cat-list">
          {cats.map((c) => (
            <button
              key={c.id}
              className={`cat-list-item${c.id === selectedId ? ' active' : ''}`}
              onClick={() => setSelectedId(c.id)}
            >
              <span className="cat-dot" style={{ background: c.color ?? 'var(--dim)' }} />
              <span className="cat-list-name">{c.name}</span>
            </button>
          ))}
          <button className="btn ghost cat-add" onClick={addCategory}>
            ＋ Add category
          </button>
        </div>

        <div className="cat-editor">
          {!selected ? (
            <div className="field-hint">Select or add a category.</div>
          ) : (
            <>
              <div className="cat-edit-row">
                <label className="field grow">
                  <span>Name</span>
                  <input
                    value={selected.name}
                    onChange={(e) => patch(selected.id, (c) => ({ ...c, name: e.target.value }))}
                  />
                </label>
                <button
                  className="btn ghost cat-delete"
                  title="Delete category"
                  onClick={() => deleteCategory(selected.id)}
                >
                  Delete
                </button>
              </div>

              <div className="field">
                <span>Color</span>
                <div className="swatches">
                  {COLORS.map((col) => (
                    <button
                      type="button"
                      key={col}
                      className={`swatch${selected.color === col ? ' sel' : ''}`}
                      style={{ background: col }}
                      onClick={() => patch(selected.id, (c) => ({ ...c, color: col }))}
                    />
                  ))}
                </div>
              </div>

              <label className="field">
                <span>Skills not enabled below</span>
                <select
                  value={selected.unlistedSkillFloor}
                  onChange={(e) =>
                    patch(selected.id, (c) => ({
                      ...c,
                      unlistedSkillFloor: e.target.value as 'name-only' | 'off'
                    }))
                  }
                >
                  <option value="name-only">name-only (visible name, still /-invocable)</option>
                  <option value="off">off (hidden entirely)</option>
                </select>
              </label>

              <div className="field">
                <span>Enabled skills ({selected.enabledSkills.length})</span>
                <div className="skill-list">
                  {skills.length === 0 && (
                    <div className="field-hint">No skills found under ~/.claude/skills.</div>
                  )}
                  {skills.map((sk) => (
                    <label key={sk.name} className="skill-row" title={sk.description}>
                      <input
                        type="checkbox"
                        checked={selected.enabledSkills.includes(sk.name)}
                        onChange={() => toggleSkill(selected.id, sk.name)}
                      />
                      <span className="skill-name">{sk.name}</span>
                      <span className="skill-src">{sk.source}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="field">
                <span>MCP servers</span>
                {selected.mcpServers.map((srv) => (
                  <div key={srv.uid} className="mcp-row">
                    <div className="mcp-row-head">
                      <input
                        className="mcp-name"
                        placeholder="server name"
                        value={srv.name}
                        onChange={(e) =>
                          patch(selected.id, (c) => ({
                            ...c,
                            mcpServers: c.mcpServers.map((s) =>
                              s.uid === srv.uid ? { ...s, name: e.target.value } : s
                            )
                          }))
                        }
                      />
                      <button
                        className="btn ghost"
                        title="Remove server"
                        onClick={() =>
                          patch(selected.id, (c) => ({
                            ...c,
                            mcpServers: c.mcpServers.filter((s) => s.uid !== srv.uid)
                          }))
                        }
                      >
                        ✕
                      </button>
                    </div>
                    <textarea
                      className="mcp-config"
                      spellCheck={false}
                      rows={4}
                      value={srv.configText}
                      onChange={(e) =>
                        patch(selected.id, (c) => ({
                          ...c,
                          mcpServers: c.mcpServers.map((s) =>
                            s.uid === srv.uid ? { ...s, configText: e.target.value } : s
                          )
                        }))
                      }
                    />
                  </div>
                ))}
                <div className="mcp-add">
                  <button
                    className="btn ghost"
                    onClick={() =>
                      patch(selected.id, (c) => ({
                        ...c,
                        mcpServers: [
                          ...c.mcpServers,
                          { uid: uid(), name: '', configText: '{\n  "command": ""\n}' }
                        ]
                      }))
                    }
                  >
                    ＋ Add server
                  </button>
                  {userServers.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        const found = userServers.find((u) => u.name === e.target.value)
                        if (!found) return
                        patch(selected.id, (c) => ({
                          ...c,
                          mcpServers: [
                            ...c.mcpServers,
                            {
                              uid: uid(),
                              name: found.name,
                              configText: JSON.stringify(found.config, null, 2)
                            }
                          ]
                        }))
                      }}
                    >
                      <option value="">Add from my servers…</option>
                      {userServers.map((u) => (
                        <option key={u.name} value={u.name}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" onClick={commit}>
          Save
        </button>
      </div>
    </>
  )
}

type SettingsTab = 'categories' | 'token-efficiency' | 'appearance'

const THEMES: { id: 'dark' | 'neon' | 'synthwave'; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'neon', label: 'Neon' },
  { id: 'synthwave', label: 'Synthwave' }
]

const ACCENTS = ['#d97757', '#22d3ee', '#a855f7', '#22c55e', '#f59e0b', '#ff2e88', '#3b82f6']

/** Appearance: theme, accent color, and gamification toggles. */
function AppearanceTab(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchSettings)
  if (!settings) return <div className="settings-body" />

  return (
    <div className="settings-body appearance-tab">
      <section className="appearance-section">
        <h3>Theme</h3>
        <div className="appearance-themes">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-swatch theme-${t.id}${settings.theme === t.id ? ' sel' : ''}`}
              onClick={() => void patch({ theme: t.id })}
            >
              <span className="theme-swatch-name">{t.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="appearance-section">
        <h3>Accent color</h3>
        <div className="swatches">
          <button
            className={`swatch swatch-default${!settings.accentColor ? ' sel' : ''}`}
            title="Theme default"
            onClick={() => void patch({ accentColor: null })}
          />
          {ACCENTS.map((c) => (
            <button
              key={c}
              className={`swatch${settings.accentColor === c ? ' sel' : ''}`}
              style={{ background: c }}
              onClick={() => void patch({ accentColor: c })}
            />
          ))}
        </div>
      </section>

      <section className="appearance-section">
        <h3>Gamification</h3>
        <label className="appearance-toggle">
          <input
            type="checkbox"
            checked={settings.gamificationEnabled}
            onChange={(e) => void patch({ gamificationEnabled: e.target.checked })}
          />
          <span>Enable XP, levels, achievements & the Arcade</span>
        </label>
        <label className="appearance-toggle">
          <input
            type="checkbox"
            checked={settings.gamificationReduceMotion}
            onChange={(e) => void patch({ gamificationReduceMotion: e.target.checked })}
          />
          <span>Reduce motion (no confetti / animations)</span>
        </label>
        <label className="appearance-toggle">
          <input
            type="checkbox"
            checked={settings.gamificationSound}
            onChange={(e) => void patch({ gamificationSound: e.target.checked })}
          />
          <span>Play a sound on level-ups & unlocks</span>
        </label>
      </section>
    </div>
  )
}

/**
 * The app Settings dialog: "Repo categories" (context profiles) and "Token
 * Efficiency" (the token-saving toolkit) behind a tab strip. The Agent & Skill
 * Factory lives in its own full pane, not here.
 */
export function SettingsDialog(): JSX.Element {
  const close = useStore((s) => s.closeSettings)
  const initialTab = useStore((s) => s.settingsTab)
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div className="settings-tabs">
          <button
            className={`settings-tab${tab === 'categories' ? ' active' : ''}`}
            onClick={() => setTab('categories')}
          >
            Repo categories
          </button>
          <button
            className={`settings-tab${tab === 'token-efficiency' ? ' active' : ''}`}
            onClick={() => setTab('token-efficiency')}
          >
            Token Efficiency
          </button>
          <button
            className={`settings-tab${tab === 'appearance' ? ' active' : ''}`}
            onClick={() => setTab('appearance')}
          >
            Appearance
          </button>
        </div>
        {tab === 'categories' && <CategoriesTab />}
        {tab === 'token-efficiency' && <TokenEfficiencyTab />}
        {tab === 'appearance' && <AppearanceTab />}
      </div>
    </div>
  )
}
