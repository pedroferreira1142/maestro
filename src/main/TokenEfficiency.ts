import { app } from 'electron'
import { execFile, spawnSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, join, relative } from 'path'
import type {
  RepoMapInfo,
  SessionConfig,
  TokenEfficiencyConfig,
  TokenEfficiencyOverride,
  TokenEfficiencySavings,
  TokenEfficiencyStatus
} from '../shared/types'
import { excludeFilePathSync } from './GitService'
import { Persistence } from './Persistence'
import { ensureScripts, SCRIPT_FILES } from './TokenEfficiencyScripts'

const IS_WIN = process.platform === 'win32'

/** Repo-relative path of the generated symbol map (read by the SessionStart hook). */
const REPO_MAP_REL = '.claude/maestro-repo-map.md'
const SETTINGS_REL = '.claude/settings.local.json'

/** How often sessions with the code graph enabled are checked for git changes. */
const HEAD_POLL_MS = 60_000

/** Byte budget of the generated repo map (~6k tokens). */
const REPO_MAP_MAX_BYTES = 24 * 1024
/** Symbols listed per file before truncating with '…'. */
const MAX_SYMBOLS_PER_FILE = 15
/** Files larger than this are skipped by the symbol extractor. */
const MAP_FILE_MAX_BYTES = 512 * 1024

/** Stats log rotation: keep the newest ~1 MB once it exceeds 2 MB. */
const STATS_ROTATE_BYTES = 2 * 1024 * 1024
const STATS_KEEP_BYTES = 1024 * 1024

/** Cap on the token-savings credit of a single blocked read. */
const BLOCKED_READ_MAX_TOKENS = 50_000

/** Symbol-extraction regexes per file extension (regex-based "tree-sitter lite"). */
const EXTRACTORS: { exts: string[]; patterns: RegExp[] }[] = [
  {
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    patterns: [
      /^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)/gm,
      /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
      /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm
    ]
  },
  {
    exts: ['.py'],
    patterns: [/^(?:async\s+)?def\s+(\w+)/gm, /^class\s+(\w+)/gm]
  },
  {
    exts: ['.java', '.cs', '.kt'],
    patterns: [
      /^\s*(?:public|protected|internal)?\s*(?:static\s+|final\s+|sealed\s+|abstract\s+|data\s+)*(?:class|interface|enum|record)\s+(\w+)/gm,
      /^\s*(?:public|protected)\s+(?:static\s+)?[\w<>[\],.\s?]+?\s+(\w+)\s*\(/gm
    ]
  },
  {
    exts: ['.go'],
    patterns: [/^func\s+(?:\([^)]*\)\s+)?(\w+)/gm, /^type\s+(\w+)/gm]
  },
  {
    exts: ['.rs'],
    patterns: [
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm,
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/gm
    ]
  },
  {
    exts: ['.rb'],
    patterns: [/^\s*(?:def|class|module)\s+([\w.?!]+)/gm]
  },
  {
    exts: ['.php'],
    patterns: [/function\s+(\w+)/gm, /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/gm]
  }
]

const EXT_TO_PATTERNS = new Map<string, RegExp[]>()
for (const group of EXTRACTORS) for (const ext of group.exts) EXT_TO_PATTERNS.set(ext, group.patterns)

interface StatsEntry {
  at: number
  cwd: string
  kind: 'filter' | 'rtk' | 'blocked-read'
  orig?: number
  out?: number
  bytes?: number
}

/** All PATH matches for an executable name, best first. */
function which(name: string): string | null {
  const out = IS_WIN
    ? spawnSync('where.exe', [name], { encoding: 'utf8' })
    : spawnSync('which', [name], { encoding: 'utf8' })
  if (out.status !== 0 || !out.stdout) return null
  return out.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? null
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

/** Atomic JSON write (tmp + rename), so claude never reads a half-written file. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** Drop undefined fields so an override only contributes what it sets. */
function defined<T extends object>(o: T | null | undefined): Partial<T> {
  const out: Partial<T> = {}
  if (!o) return out
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Case/separator-insensitive folder prefix match (Windows paths in stats). */
function underFolder(path: string, folder: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const a = norm(path)
  const b = norm(folder)
  return a === b || a.startsWith(b + '/')
}

/** Current HEAD sha of a repo folder, or null when unavailable. */
function gitHead(folder: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: folder, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim() || null)
    )
  })
}

/**
 * Append our repo-map file to the repo's `info/exclude` (per-clone, never
 * committed), so the generated map doesn't show up as an untracked file.
 */
function ensureMapExcluded(folder: string): void {
  const file = excludeFilePathSync(folder)
  if (!file) return
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()))
    if (lines.has(REPO_MAP_REL)) return
    mkdirSync(dirname(file), { recursive: true })
    const suffix = current.length && !current.endsWith('\n') ? '\n' : ''
    writeFileSync(file, current + suffix + REPO_MAP_REL + '\n', 'utf8')
  } catch {
    // best-effort; never block a session launch on this
  }
}

/**
 * The Token Efficiency toolkit: resolves the effective config per session
 * (global → per-repo override → per-session override), materializes it into
 * the repo before claude spawns (managed hook entries in
 * `.claude/settings.local.json`, a generated repo symbol map, git exclude),
 * supplies the env caps claude is spawned with, refreshes the repo map when
 * git HEAD moves, and aggregates the savings stats the hook scripts log.
 *
 * Hooks and env are only read at claude startup, so config changes take
 * effect when a terminal restarts — `status()` reports the drift.
 */
export class TokenEfficiencyService {
  private baseDir = join(app.getPath('userData'), 'token-efficiency')
  private statsFile = join(this.baseDir, 'stats.jsonl')
  private scripts: Record<keyof typeof SCRIPT_FILES, string> | null = null

  private rtkPath: string | null | undefined // undefined = not probed yet
  private nodePath: string | null | undefined

  /** Effective config each session's claude was last spawned with. */
  private applied = new Map<string, TokenEfficiencyConfig>()
  /** Repo-map facts per repo folder (the folder the map was generated in). */
  private repoMaps = new Map<string, RepoMapInfo>()
  /** Last seen HEAD per session folder, for change-driven map refresh. */
  private lastHead = new Map<string, string>()
  /** Folders with a map generation in flight (dedupe). */
  private generating = new Set<string>()

  private statsCache: { mtimeMs: number; size: number; entries: StatsEntry[] } | null = null
  private pollTimer: NodeJS.Timeout | null = null

  constructor(private persistence: Persistence) {
    try {
      mkdirSync(this.baseDir, { recursive: true })
      this.scripts = ensureScripts(join(this.baseDir, 'scripts'))
    } catch (err) {
      console.error('Token efficiency: failed to write hook scripts', err)
      this.scripts = null
    }
  }

  /** Begin the git-change poll that keeps repo maps fresh. Idempotent. */
  start(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => void this.pollGitChanges(), HEAD_POLL_MS)
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  // ---------- config resolution ----------

  /** The override key a session's repo resolves to (worktree tasks → base repo). */
  repoKeyOf(config: SessionConfig): string {
    return config.worktree?.baseFolder ?? config.folder
  }

  /** Global ⊕ repo override ⊕ session override. */
  resolveEffective(config: SessionConfig): TokenEfficiencyConfig {
    const settings = this.persistence.state.settings
    const repoOv = settings.tokenEfficiencyRepoOverrides[this.repoKeyOf(config)]
    return {
      ...settings.tokenEfficiency,
      ...defined<TokenEfficiencyOverride>(repoOv),
      ...defined<TokenEfficiencyOverride>(config.tokenEfficiency)
    }
  }

  /** Probe for external tools (cached; `refresh` re-probes). */
  detectTools(refresh = false): { rtk: { found: boolean; path: string | null }; nodeFound: boolean } {
    if (refresh || this.rtkPath === undefined) this.rtkPath = which('rtk')
    if (refresh || this.nodePath === undefined) this.nodePath = which('node')
    return {
      rtk: { found: this.rtkPath !== null, path: this.rtkPath },
      nodeFound: this.nodePath !== null
    }
  }

  // ---------- materialization (runs before claude spawns) ----------

  /**
   * Materialize the session's effective config into its repo: write/remove our
   * managed hook entries and kick a repo-map (re)generation. Idempotent and
   * reversible — with the toolkit off every trace is removed again. Never
   * throws (a failure must not block a session launch).
   */
  apply(config: SessionConfig): void {
    if (!existsSync(config.folder)) return
    const effective = this.resolveEffective(config)
    try {
      this.applyHooks(config.folder, effective)
    } catch (err) {
      console.error('Token efficiency: applying hooks failed for', config.folder, err)
    }
    if (effective.enabled && effective.codeGraph) {
      void this.ensureRepoMap(config.folder, effective, false)
    } else {
      this.removeRepoMap(config.folder)
    }
  }

  /** Env overlay for a claude spawn: variables to set and to drop. */
  envFor(config: SessionConfig): { set: Record<string, string>; drop: string[] } {
    const effective = this.resolveEffective(config)
    const set: Record<string, string> = {}
    const drop: string[] = []
    if (!effective.enabled) return { set, drop }
    if (effective.truncationHooks) {
      set.BASH_MAX_OUTPUT_LENGTH = String(effective.bashMaxOutputChars)
      set.MAX_MCP_OUTPUT_TOKENS = String(effective.mcpMaxOutputTokens)
    }
    // An inherited DISABLE_PROMPT_CACHING would silently ~10x input cost.
    if (effective.promptCachingHints) drop.push('DISABLE_PROMPT_CACHING')
    return { set, drop }
  }

  /** Record what a session's claude was actually spawned with (for drift). */
  markApplied(config: SessionConfig): void {
    this.applied.set(config.id, this.resolveEffective(config))
  }

  clearApplied(sessionId: string): void {
    this.applied.delete(sessionId)
  }

  /**
   * Rewrite our managed hook entries in the repo's settings.local.json. Ours
   * are recognized by the scripts-dir path inside the command string; foreign
   * hooks are preserved untouched (same managed-namespace contract as
   * ContextProfile).
   */
  private applyHooks(folder: string, effective: TokenEfficiencyConfig): void {
    const file = join(folder, SETTINGS_REL)
    const existed = existsSync(file)
    const settings = readJson(file)
    const marker = this.scripts ? dirname(this.scripts.outputFilter) : null

    const hooks: Record<string, unknown[]> =
      settings.hooks && typeof settings.hooks === 'object'
        ? { ...(settings.hooks as Record<string, unknown[]>) }
        : {}

    const isOurs = (entry: unknown): boolean => {
      const hookList = (entry as { hooks?: unknown[] })?.hooks
      if (!Array.isArray(hookList) || !marker) return false
      return hookList.some((h) => {
        const cmd = (h as { command?: unknown })?.command
        return typeof cmd === 'string' && cmd.includes(marker)
      })
    }

    for (const event of ['PreToolUse', 'SessionStart']) {
      const entries = Array.isArray(hooks[event]) ? hooks[event].filter((e) => !isOurs(e)) : []
      if (entries.length > 0) hooks[event] = entries
      else delete hooks[event]
    }

    const active = effective.enabled && this.scripts && this.detectTools().nodeFound
    if (active && this.scripts) {
      const node = 'node'
      const q = (p: string): string => '"' + p + '"'
      const pre: unknown[] = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
      if (effective.outputCompression) {
        const rtkFlag = this.detectTools().rtk.found ? '1' : '0'
        pre.push({
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command:
                node + ' ' + q(this.scripts.bashCompress) +
                ' --stats ' + q(this.statsFile) +
                ' --filter ' + q(this.scripts.outputFilter) +
                ' --rtk ' + rtkFlag,
              timeout: 10
            }
          ]
        })
      }
      if (effective.truncationHooks) {
        pre.push({
          matcher: 'Read',
          hooks: [
            {
              type: 'command',
              command:
                node + ' ' + q(this.scripts.readGuard) +
                ' --stats ' + q(this.statsFile) +
                ' --max-kb ' + effective.largeReadMaxKB,
              timeout: 10
            }
          ]
        })
      }
      if (pre.length > 0) hooks.PreToolUse = pre
      if (effective.codeGraph) {
        hooks.SessionStart = [
          {
            hooks: [
              { type: 'command', command: node + ' ' + q(this.scripts.sessionContext), timeout: 10 }
            ]
          }
        ]
      }
    }

    if (Object.keys(hooks).length > 0) settings.hooks = hooks
    else delete settings.hooks

    if (!existed && Object.keys(settings).length === 0) return
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeJsonAtomic(file, settings)
  }

  // ---------- repo map (code graph) ----------

  /**
   * (Re)generate a session folder's repo map when missing or its HEAD moved
   * (`force` regenerates regardless). The map is written into the repo for the
   * SessionStart hook to pick up, and kept out of git via info/exclude.
   */
  private async ensureRepoMap(
    folder: string,
    effective: TokenEfficiencyConfig,
    force: boolean
  ): Promise<RepoMapInfo | null> {
    if (this.generating.has(folder)) return this.repoMaps.get(folder) ?? null
    const mapPath = join(folder, REPO_MAP_REL)
    const head = await gitHead(folder)
    const known = this.repoMaps.get(folder)
    if (!force && known && existsSync(mapPath) && head && this.lastHead.get(folder) === head) {
      return known
    }
    this.generating.add(folder)
    try {
      const info = this.generateRepoMap(folder, effective.repoMapMaxFiles)
      this.repoMaps.set(folder, info)
      if (head) this.lastHead.set(folder, head)
      ensureMapExcluded(folder)
      return info
    } catch (err) {
      console.error('Token efficiency: repo map generation failed for', folder, err)
      return null
    } finally {
      this.generating.delete(folder)
    }
  }

  /** Delete a folder's generated map (used when the code graph is toggled off). */
  private removeRepoMap(folder: string): void {
    this.repoMaps.delete(folder)
    this.lastHead.delete(folder)
    try {
      rmSync(join(folder, REPO_MAP_REL), { force: true })
    } catch {
      // best-effort
    }
  }

  /**
   * Walk the repo and produce a compact aider-style "path: symbols" map.
   * Regex extraction by design: dependency-free (no native tree-sitter) and
   * fast enough to run synchronously on spawn (caps bound the work).
   */
  private generateRepoMap(folder: string, maxFiles: number): RepoMapInfo {
    const ignore = new Set([
      ...this.persistence.state.settings.ignoreNames,
      '.git',
      'vendor',
      'coverage'
    ])
    const files: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 12 || files.length >= maxFiles) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      const subdirs: string[] = []
      for (const entry of entries) {
        if (files.length >= maxFiles) return
        if (ignore.has(entry) || entry.startsWith('.')) continue
        const path = join(dir, entry)
        let stat
        try {
          stat = statSync(path)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          subdirs.push(path)
        } else if (stat.size <= MAP_FILE_MAX_BYTES) {
          const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase()
          if (EXT_TO_PATTERNS.has(ext)) files.push(path)
        }
      }
      for (const sub of subdirs) walk(sub, depth + 1)
    }
    walk(folder, 0)

    const lines: string[] = []
    let totalSymbols = 0
    let bytes = 0
    for (const path of files) {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
      const patterns = EXT_TO_PATTERNS.get(ext) ?? []
      const symbols: string[] = []
      const seen = new Set<string>()
      for (const pattern of patterns) {
        pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = pattern.exec(text))) {
          const name = m[1]
          if (name && !seen.has(name)) {
            seen.add(name)
            symbols.push(name)
          }
          if (seen.size > MAX_SYMBOLS_PER_FILE * 2) break
        }
      }
      if (symbols.length === 0) continue
      const shown = symbols.slice(0, MAX_SYMBOLS_PER_FILE)
      const rel = relative(folder, path).replace(/\\/g, '/')
      const line = rel + ': ' + shown.join(', ') + (symbols.length > shown.length ? ', …' : '')
      if (bytes + line.length > REPO_MAP_MAX_BYTES) break
      lines.push(line)
      bytes += line.length + 1
      totalSymbols += shown.length
    }

    const content = lines.join('\n') + '\n'
    const mapPath = join(folder, REPO_MAP_REL)
    mkdirSync(dirname(mapPath), { recursive: true })
    writeFileSync(mapPath, content, 'utf8')
    return { generatedAt: Date.now(), files: lines.length, symbols: totalSymbols, bytes: content.length }
  }

  /** Refresh maps for sessions whose repo HEAD moved since the last poll. */
  private async pollGitChanges(): Promise<void> {
    for (const config of this.persistence.state.sessions) {
      const effective = this.resolveEffective(config)
      if (!effective.enabled || !effective.codeGraph) continue
      if (!existsSync(config.folder)) continue
      const head = await gitHead(config.folder)
      if (!head) continue
      const prev = this.lastHead.get(config.folder)
      if (prev !== head) await this.ensureRepoMap(config.folder, effective, true)
    }
  }

  // ---------- savings stats (logged by the hook scripts) ----------

  private loadStats(): StatsEntry[] {
    let stat
    try {
      stat = statSync(this.statsFile)
    } catch {
      return []
    }
    if (
      this.statsCache &&
      this.statsCache.mtimeMs === stat.mtimeMs &&
      this.statsCache.size === stat.size
    ) {
      return this.statsCache.entries
    }
    let raw: string
    try {
      raw = readFileSync(this.statsFile, 'utf8')
    } catch {
      return []
    }
    // Rotate: hooks append forever; keep the newest ~1 MB once it grows past 2 MB.
    if (raw.length > STATS_ROTATE_BYTES) {
      const tail = raw.slice(-STATS_KEEP_BYTES)
      raw = tail.slice(tail.indexOf('\n') + 1)
      try {
        writeFileSync(this.statsFile, raw, 'utf8')
      } catch {
        // keep serving from memory
      }
    }
    const entries: StatsEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as StatsEntry
        if (e && typeof e.cwd === 'string' && typeof e.kind === 'string') entries.push(e)
      } catch {
        // partial trailing line from a concurrent append
      }
    }
    try {
      const fresh = statSync(this.statsFile)
      this.statsCache = { mtimeMs: fresh.mtimeMs, size: fresh.size, entries }
    } catch {
      this.statsCache = null
    }
    return entries
  }

  /** Savings attributed to one folder ('' aggregates everything). */
  savingsFor(folder: string): TokenEfficiencySavings {
    const savings: TokenEfficiencySavings = {
      savedTokens: 0,
      rtkRewrites: 0,
      filteredCommands: 0,
      blockedReads: 0
    }
    for (const e of this.loadStats()) {
      if (folder && !underFolder(e.cwd, folder)) continue
      if (e.kind === 'filter') {
        savings.filteredCommands++
        const saved = Math.max(0, (e.orig ?? 0) - (e.out ?? 0))
        savings.savedTokens += Math.round(saved / 4)
      } else if (e.kind === 'rtk') {
        savings.rtkRewrites++
      } else if (e.kind === 'blocked-read') {
        savings.blockedReads++
        savings.savedTokens += Math.min(Math.round((e.bytes ?? 0) / 4), BLOCKED_READ_MAX_TOKENS)
      }
    }
    return savings
  }

  // ---------- status & settings mutation (IPC surface) ----------

  status(sessionId: string): TokenEfficiencyStatus | null {
    const config = this.persistence.state.sessions.find((s) => s.id === sessionId)
    if (!config) return null
    const settings = this.persistence.state.settings
    const effective = this.resolveEffective(config)
    const applied = this.applied.get(sessionId) ?? null
    const tools = this.detectTools()
    return {
      effective,
      repoOverride: settings.tokenEfficiencyRepoOverrides[this.repoKeyOf(config)] ?? null,
      sessionOverride: config.tokenEfficiency ?? null,
      rtk: tools.rtk,
      nodeFound: tools.nodeFound,
      applied,
      pendingRestart: applied !== null && JSON.stringify(applied) !== JSON.stringify(effective),
      repoMap: this.repoMaps.get(config.folder) ?? null,
      savings: this.savingsFor(config.folder)
    }
  }

  /** Persist the global config and re-materialize every session's repo. */
  saveGlobal(config: TokenEfficiencyConfig): void {
    this.persistence.state.settings.tokenEfficiency = config
    this.persistence.scheduleSave()
    this.reapplyAll()
  }

  /** Set/clear the override for a session's repo, then re-materialize that repo. */
  setRepoOverride(sessionId: string, override: TokenEfficiencyOverride | null): void {
    const config = this.persistence.state.sessions.find((s) => s.id === sessionId)
    if (!config) return
    const key = this.repoKeyOf(config)
    const overrides = this.persistence.state.settings.tokenEfficiencyRepoOverrides
    const cleaned = defined(override)
    if (override && Object.keys(cleaned).length > 0) overrides[key] = cleaned
    else delete overrides[key]
    this.persistence.scheduleSave()
    for (const s of this.persistence.state.sessions) {
      if (this.repoKeyOf(s) === key && s.terminals.some((t) => t.kind === 'claude')) this.apply(s)
    }
  }

  /** Set/clear one session's own override, then re-materialize it. */
  setSessionOverride(sessionId: string, override: TokenEfficiencyOverride | null): void {
    const config = this.persistence.state.sessions.find((s) => s.id === sessionId)
    if (!config) return
    const cleaned = defined(override)
    config.tokenEfficiency = override && Object.keys(cleaned).length > 0 ? cleaned : null
    this.persistence.scheduleSave()
    if (config.terminals.some((t) => t.kind === 'claude')) this.apply(config)
  }

  /** Regenerate a session's repo map right now. */
  async refreshRepoMap(sessionId: string): Promise<RepoMapInfo | null> {
    const config = this.persistence.state.sessions.find((s) => s.id === sessionId)
    if (!config || !existsSync(config.folder)) return null
    const effective = this.resolveEffective(config)
    if (!effective.enabled || !effective.codeGraph) return null
    return this.ensureRepoMap(config.folder, effective, true)
  }

  /** Re-materialize every session that hosts a claude terminal. */
  private reapplyAll(): void {
    for (const config of this.persistence.state.sessions) {
      if (config.terminals.some((t) => t.kind === 'claude')) this.apply(config)
    }
  }
}
