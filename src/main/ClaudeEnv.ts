import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { McpServerDef, RepoCategory, SkillInfo } from '../shared/types'

const CLAUDE_HOME = join(homedir(), '.claude')

/**
 * Pull `name` and `description` out of a SKILL.md YAML frontmatter block.
 * Deliberately tiny — handles inline scalars, quoted values, and `|`/`>`
 * block scalars, which is all SKILL.md frontmatter uses in practice.
 */
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  const lines = m[1].split(/\r?\n/)
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
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
  }
  return out
}

/** Read each `<entry>/SKILL.md` directly under `dir`, returning parsed skills. */
function scanSkillDir(dir: string, source: SkillInfo['source']): SkillInfo[] {
  if (!existsSync(dir)) return []
  const found: SkillInfo[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const entry of entries) {
    const skillMd = join(dir, entry, 'SKILL.md')
    if (!existsSync(skillMd)) continue
    try {
      const fm = parseFrontmatter(readFileSync(skillMd, 'utf8'))
      const name = fm.name?.trim() || entry
      found.push({ name, description: fm.description ?? '', source })
    } catch {
      found.push({ name: entry, description: '', source })
    }
  }
  return found
}

/** Best-effort discovery of plugin skills under the marketplaces tree. */
function scanPluginSkills(): SkillInfo[] {
  const marketplaces = join(CLAUDE_HOME, 'plugins', 'marketplaces')
  if (!existsSync(marketplaces)) return []
  const out: SkillInfo[] = []
  let mkts: string[]
  try {
    mkts = readdirSync(marketplaces)
  } catch {
    return []
  }
  for (const mkt of mkts) {
    const pluginsRoot = join(marketplaces, mkt, 'plugins')
    if (!existsSync(pluginsRoot)) continue
    let plugins: string[]
    try {
      plugins = readdirSync(pluginsRoot)
    } catch {
      continue
    }
    for (const plugin of plugins) {
      out.push(...scanSkillDir(join(pluginsRoot, plugin, 'skills'), 'plugin'))
    }
  }
  return out
}

/**
 * All skills claude could load: user-level (`~/.claude/skills`) plus plugin
 * skills. Deduped by name (user wins), sorted alphabetically. This is the
 * master list the Categories dialog toggles per category.
 */
export function scanSkills(): SkillInfo[] {
  const all = [...scanSkillDir(join(CLAUDE_HOME, 'skills'), 'user'), ...scanPluginSkills()]
  const byName = new Map<string, SkillInfo>()
  for (const s of all) if (!byName.has(s.name)) byName.set(s.name, s)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Read user-scope MCP servers from ~/.claude.json so the UI can offer them. */
export function readUserMcpServers(): McpServerDef[] {
  const file = join(homedir(), '.claude.json')
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const servers = raw?.mcpServers
    if (!servers || typeof servers !== 'object') return []
    return Object.entries(servers).map(([name, config]) => ({
      name,
      config: config as Record<string, unknown>
    }))
  } catch {
    return []
  }
}

/** True if a repo-root detect pattern matches. `*.ext` globs root entries. */
function detectFileMatches(folder: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    const suffix = pattern.replace(/^\*/, '')
    try {
      return readdirSync(folder).some((e) => e.endsWith(suffix))
    } catch {
      return false
    }
  }
  try {
    return existsSync(join(folder, pattern))
  } catch {
    return false
  }
}

/**
 * Suggest a category for a freshly-picked folder: the first category whose
 * `detectFiles` match something at the repo root. Categories with no
 * detectFiles never auto-match. Returns the category id, or null.
 */
export function detectCategory(folder: string, categories: RepoCategory[]): string | null {
  try {
    if (!statSync(folder).isDirectory()) return null
  } catch {
    return null
  }
  for (const cat of categories) {
    if (cat.detectFiles.some((p) => detectFileMatches(folder, p))) return cat.id
  }
  return null
}
