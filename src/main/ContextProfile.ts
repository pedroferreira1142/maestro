import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { RepoCategory } from '../shared/types'
import { excludeFilePathSync } from './GitService'

const SETTINGS_REL = '.claude/settings.local.json'
const MCP_REL = '.mcp.json'

/** Atomic JSON write: tmp file + rename, so claude never reads a half-written file. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Materialize a category's `skillOverrides` + `enabledMcpjsonServers` into the
 * repo's settings.local.json. We only touch keys we manage (skills in
 * `allSkillNames`, servers in `allManagedServerNames`); anything else the user
 * put there is preserved. Returns true if a file was written.
 */
function applySettings(
  folder: string,
  category: RepoCategory | null,
  allSkillNames: string[],
  allManagedServerNames: string[]
): void {
  const file = join(folder, SETTINGS_REL)
  const existed = existsSync(file)
  const settings = readJson(file)

  // --- skillOverrides ---
  const overrides: Record<string, unknown> =
    settings.skillOverrides && typeof settings.skillOverrides === 'object'
      ? { ...(settings.skillOverrides as Record<string, unknown>) }
      : {}
  const enabled = new Set(category?.enabledSkills ?? [])
  for (const name of allSkillNames) {
    if (!category) {
      delete overrides[name] // no category → release our managed entries
    } else if (enabled.has(name)) {
      overrides[name] = 'on'
    } else {
      overrides[name] = category.unlistedSkillFloor
    }
  }
  if (Object.keys(overrides).length > 0) settings.skillOverrides = overrides
  else delete settings.skillOverrides

  // --- enabledMcpjsonServers (preserve foreign entries, replace ours) ---
  const prev: string[] = Array.isArray(settings.enabledMcpjsonServers)
    ? (settings.enabledMcpjsonServers as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  const managedSet = new Set(allManagedServerNames)
  const foreign = prev.filter((s) => !managedSet.has(s))
  const ours = category ? category.mcpServers.map((s) => s.name) : []
  const enabledServers = [...new Set([...foreign, ...ours])]
  if (enabledServers.length > 0) settings.enabledMcpjsonServers = enabledServers
  else delete settings.enabledMcpjsonServers

  // Don't create an empty file where none existed.
  if (!existed && Object.keys(settings).length === 0) return
  mkdirSync(join(folder, '.claude'), { recursive: true })
  writeJsonAtomic(file, settings)
}

/**
 * Materialize a category's MCP servers into the repo's .mcp.json under
 * `mcpServers`, replacing only servers in our managed namespace and leaving
 * any the user added by hand untouched.
 */
function applyMcp(
  folder: string,
  category: RepoCategory | null,
  allManagedServerNames: string[]
): void {
  const file = join(folder, MCP_REL)
  const existed = existsSync(file)
  const root = readJson(file)
  const servers: Record<string, unknown> =
    root.mcpServers && typeof root.mcpServers === 'object'
      ? { ...(root.mcpServers as Record<string, unknown>) }
      : {}

  for (const name of allManagedServerNames) delete servers[name]
  if (category) for (const s of category.mcpServers) servers[s.name] = s.config

  if (Object.keys(servers).length > 0) root.mcpServers = servers
  else delete root.mcpServers

  if (!existed && Object.keys(root).length === 0) return
  writeJsonAtomic(file, root)
}

/**
 * Keep our two managed files out of git WITHOUT touching the tracked
 * .gitignore: append them to the repo's info/exclude (per-clone, never
 * committed). Works for ordinary repos and linked worktrees alike, since the
 * exclude path is resolved via git. No-op for non-git folders.
 */
function ensureGitExclude(folder: string): void {
  const file = excludeFilePathSync(folder)
  if (!file) return
  const infoDir = dirname(file)
  let current = ''
  try {
    if (existsSync(file)) current = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()))
  const wanted = [SETTINGS_REL, MCP_REL].filter((p) => !lines.has(p))
  if (wanted.length === 0) return
  try {
    mkdirSync(infoDir, { recursive: true })
    const header = lines.has('# claude-session-manager') ? '' : '\n# claude-session-manager\n'
    const suffix = current.length && !current.endsWith('\n') ? '\n' : ''
    writeFileSync(file, current + suffix + header + wanted.join('\n') + '\n', 'utf8')
  } catch {
    // best-effort; never block a session launch on this
  }
}

/**
 * Apply a repo category's context profile to `folder` before claude launches.
 * Idempotent and reversible: re-running with a different (or null) category
 * rewrites only the keys/servers we manage. `allSkillNames` and
 * `allManagedServerNames` define our ownership namespace across all categories.
 */
export function applyContextProfile(
  folder: string,
  category: RepoCategory | null,
  allSkillNames: string[],
  allManagedServerNames: string[]
): void {
  if (!existsSync(folder)) return
  try {
    applySettings(folder, category, allSkillNames, allManagedServerNames)
    applyMcp(folder, category, allManagedServerNames)
    ensureGitExclude(folder)
  } catch (err) {
    console.error('applyContextProfile failed for', folder, err)
  }
}
