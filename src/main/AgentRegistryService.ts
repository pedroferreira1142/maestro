import { BrowserWindow, shell } from 'electron'
import { existsSync, FSWatcher, readdirSync, readFileSync, watch } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import {
  AgentGithubRepo,
  AgentRegistryEntry,
  AgentsSnapshot,
  InstalledAgent
} from '../shared/types'
import { Persistence } from './Persistence'

const USER_AGENTS_DIR = join(homedir(), '.claude', 'agents')

/** Debounce for file-watch events before re-snapshotting + broadcasting. */
const WATCH_DEBOUNCE_MS = 400

/**
 * The Factory's "Agents" backend: scans the agents the user actually has
 * installed (~/.claude/agents user-global + each session repo's .claude/agents
 * project-local), reads the external Agent Factory registry (registry.json at a
 * configurable path) and merges its metadata onto the installed agents by name.
 * Watches both sides (agents dir, registry dir — which also covers the
 * .factory.lock "factory running" flag) and pushes fresh snapshots to the
 * renderer via 'agents:changed'.
 */
export class AgentRegistryService {
  private watchers = new Map<string, FSWatcher>()
  private debounce: NodeJS.Timeout | null = null
  /** Paths the renderer may read/reveal — everything the last snapshot listed. */
  private knownPaths = new Set<string>()
  private disposed = false

  constructor(
    private persistence: Persistence,
    private getWin: () => BrowserWindow | null
  ) {}

  dispose(): void {
    this.disposed = true
    if (this.debounce) clearTimeout(this.debounce)
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }

  private registryPath(): string {
    return this.persistence.state.settings.agentRegistryPath.trim()
  }

  /** Unique session repo folders (project-local agents may live in each). */
  private projectDirs(): string[] {
    return [...new Set(this.persistence.state.sessions.map((s) => s.folder).filter(Boolean))]
  }

  /** Build a fresh snapshot and re-arm the watchers for the dirs it covers. */
  snapshot(): AgentsSnapshot {
    const registryPath = this.registryPath()
    const registry = readRegistry(registryPath)

    const agents: InstalledAgent[] = scanAgentsDir(USER_AGENTS_DIR, 'user', null)
    for (const dir of this.projectDirs()) {
      agents.push(...scanAgentsDir(join(dir, '.claude', 'agents'), 'project', dir))
    }
    agents.sort((a, b) => a.name.localeCompare(b.name))

    // Merge registry metadata onto installed agents by name (case-insensitive).
    const byName = new Map<string, AgentRegistryEntry>()
    for (const e of registry.entries) byName.set(e.name.toLowerCase(), e)
    const matched = new Set<AgentRegistryEntry>()
    for (const agent of agents) {
      const entry = byName.get(agent.name.toLowerCase())
      if (entry) {
        agent.registry = entry
        matched.add(entry)
      }
    }
    // Drift: entries whose file is gone and that match no installed agent.
    const missing = registry.entries.filter((e) => e.fileMissing && !matched.has(e))

    const registryDir = dirname(registryPath)
    const snapshot: AgentsSnapshot = {
      agents,
      missing,
      registryPath,
      registryError: registry.error,
      registryVersion: registry.version,
      registryUpdated: registry.updated,
      factoryRunning: existsSync(join(registryDir, '.factory.lock'))
    }

    this.knownPaths = new Set<string>()
    for (const a of agents) this.knownPaths.add(a.filePath)
    for (const e of registry.entries) if (e.filePath) this.knownPaths.add(e.filePath)

    this.armWatchers(registryDir)
    return snapshot
  }

  /** Re-snapshot now and push it to the renderer (manual refresh / settings change). */
  refresh(): AgentsSnapshot {
    const snapshot = this.snapshot()
    this.getWin()?.webContents.send('agents:changed', snapshot)
    return snapshot
  }

  /** Read an agent file the last snapshot listed (null when unknown/unreadable). */
  readAgentFile(filePath: string): string | null {
    if (this.knownPaths.size === 0) this.snapshot()
    if (!this.knownPaths.has(filePath)) return null
    try {
      return readFileSync(filePath, 'utf8')
    } catch {
      return null
    }
  }

  /** Reveal an agent file from the last snapshot in the OS file manager. */
  revealAgentFile(filePath: string): void {
    if (this.knownPaths.has(filePath) && existsSync(filePath)) shell.showItemInFolder(filePath)
  }

  // ---------- file watching ----------

  /**
   * Watch the user agents dir, every project agents dir and the registry dir
   * (the latter covers registry.json writes AND .factory.lock create/delete).
   * Idempotent: only the delta of dirs is (un)watched.
   */
  private armWatchers(registryDir: string): void {
    if (this.disposed) return
    const wanted = new Set<string>()
    if (existsSync(USER_AGENTS_DIR)) wanted.add(USER_AGENTS_DIR)
    if (existsSync(registryDir)) wanted.add(registryDir)
    for (const dir of this.projectDirs()) {
      const agentsDir = join(dir, '.claude', 'agents')
      if (existsSync(agentsDir)) wanted.add(agentsDir)
    }
    for (const [dir, watcher] of this.watchers) {
      if (!wanted.has(dir)) {
        watcher.close()
        this.watchers.delete(dir)
      }
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue
      try {
        const watcher = watch(dir, () => this.scheduleRefresh())
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(dir)
        })
        this.watchers.set(dir, watcher)
      } catch {
        // dir vanished between the existsSync and the watch — next refresh re-arms
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.disposed) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.refresh()
    }, WATCH_DEBOUNCE_MS)
  }
}

// ---------- installed-agent scanning ----------

/** Frontmatter fields an agent .md may declare that we surface. */
function parseAgentFrontmatter(md: string): { name?: string; description?: string; model?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  const out: { name?: string; description?: string; model?: string } = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    const key = kv[1]
    let value = kv[2].trim()
    // Block scalar (`|` or `>`): gather the following more-indented lines.
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[++i].trim())
      }
      value = block.join(' ').trim()
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key === 'name') out.name = value
    else if (key === 'description') out.description = value
    else if (key === 'model') out.model = value
  }
  return out
}

/** Every *.md directly under `dir`, parsed for name/description/model. */
function scanAgentsDir(
  dir: string,
  scope: InstalledAgent['scope'],
  projectDir: string | null
): InstalledAgent[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: InstalledAgent[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = join(dir, entry)
    const base = entry.replace(/\.md$/, '')
    let fm: ReturnType<typeof parseAgentFrontmatter> = {}
    try {
      fm = parseAgentFrontmatter(readFileSync(filePath, 'utf8'))
    } catch {
      // unreadable file — fall back to the basename
    }
    out.push({
      name: fm.name?.trim() || base,
      description: fm.description ?? '',
      model: fm.model?.trim() || null,
      scope,
      projectDir,
      filePath,
      registry: null
    })
  }
  return out
}

// ---------- external registry reading ----------

function readRegistry(registryPath: string): {
  entries: AgentRegistryEntry[]
  error: string | null
  version: string | null
  updated: string | null
} {
  if (!registryPath) return { entries: [], error: 'No registry path configured.', version: null, updated: null }
  if (!existsSync(registryPath)) {
    return { entries: [], error: `Registry not found: ${registryPath}`, version: null, updated: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch (err) {
    return {
      entries: [],
      error: `Registry unreadable: ${(err as Error).message || String(err)}`,
      version: null,
      updated: null
    }
  }
  const root = (parsed ?? {}) as Record<string, unknown>
  const meta = (root._meta ?? {}) as Record<string, unknown>
  const rawAgents = Array.isArray(root.agents) ? root.agents : []
  const entries: AgentRegistryEntry[] = []
  for (const raw of rawAgents) {
    if (!raw || typeof raw !== 'object') continue
    const entry = parseEntry(raw as Record<string, unknown>, registryPath)
    if (entry) entries.push(entry)
  }
  return {
    entries,
    error: null,
    version: typeof meta.version === 'string' ? meta.version : null,
    updated: typeof meta.last_updated === 'string' ? meta.last_updated : null
  }
}

function parseEntry(r: Record<string, unknown>, registryPath: string): AgentRegistryEntry | null {
  const name = String(r.name ?? '').trim()
  if (!name) return null
  const filePath = resolveEntryPath(r.file_path, registryPath)
  return {
    name,
    filePath,
    type: optString(r.type),
    status: optString(r.status),
    archetype: optString(r.archetype),
    model: optString(r.model),
    scope: optString(r.scope),
    description: String(r.description ?? '').trim(),
    topics: toStringArray(r.topics),
    keywords: toStringArray(r.keywords),
    relatedAgents: toStringArray(r.related_agents),
    confluencePages: [
      ...new Set([...toStringArray(r.confluence_source), ...toStringArray(r.confluence_pages)])
    ],
    sourceVerified: r.source_verified === true,
    githubRepos: toGithubRepos(r.github_repos),
    githubVerified: r.github_verified === true,
    knowledgeNotes: toStringArray(r.knowledge_note),
    factoryMade: typeof r.factory_made === 'boolean' ? r.factory_made : null,
    created: optString(r.created),
    lastUpdated: optString(r.last_updated),
    fileMissing: filePath !== null && !existsSync(filePath)
  }
}

/**
 * Resolve an entry's file_path to an absolute path. Relative paths (the
 * registry's infrastructure agents, e.g. ".claude/agents/x.md") are relative to
 * the agent-factory repo root — registry.json lives in <root>/registry/, so
 * that's the parent of the registry dir; the registry dir itself is tried as a
 * fallback for tolerance.
 */
function resolveEntryPath(raw: unknown, registryPath: string): string | null {
  const fp = String(raw ?? '').trim()
  if (!fp) return null
  if (isAbsolute(fp)) return fp
  const registryDir = dirname(registryPath)
  const fromRepoRoot = resolve(dirname(registryDir), fp)
  if (existsSync(fromRepoRoot)) return fromRepoRoot
  const fromRegistryDir = resolve(registryDir, fp)
  return existsSync(fromRegistryDir) ? fromRegistryDir : fromRepoRoot
}

function optString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s || null
}

/** Coerce an unknown into a clean string array (a lone string becomes [string]). */
function toStringArray(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : []
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))]
}

function toGithubRepos(v: unknown): AgentGithubRepo[] {
  if (!Array.isArray(v)) return []
  const out: AgentGithubRepo[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const repo = String(r.repo ?? '').trim()
    if (!repo) continue
    out.push({ repo, ref: optString(r.ref), paths: toStringArray(r.paths) })
  }
  return out
}
