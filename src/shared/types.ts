export type SessionStatus =
  | 'starting'
  | 'working'
  | 'needs-attention'
  | 'idle'
  | 'exited'
  | 'error'

export type StartMode = 'fresh' | 'continue'

/**
 * The kind of program a terminal runs. `claude` is the default.
 * powershell/cmd are Windows-only; zsh is macOS/Linux-only (resolveKind
 * returns null for kinds unavailable on the current platform).
 */
export type TerminalKind = 'claude' | 'powershell' | 'cmd' | 'bash' | 'zsh'

/**
 * How visible a skill is to claude in a session. Mirrors Claude Code's
 * `skillOverrides` values: 'on' = name+description loaded and auto-invocable,
 * 'name-only' = only the name loads (saves context, still /-invocable),
 * 'user-invocable-only' = no auto-invoke, 'off' = hidden entirely.
 */
export type SkillVisibility = 'on' | 'name-only' | 'user-invocable-only' | 'off'

/** One MCP server, written verbatim under mcpServers[name] in the repo's .mcp.json. */
export interface McpServerDef {
  name: string
  /** The transport config object, e.g. { command, args, env } or { type:'http', url }. */
  config: Record<string, unknown>
}

/** A skill discovered on disk, surfaced to the Categories dialog's picker. */
export interface SkillInfo {
  name: string
  description: string
  /** Where it was found. */
  source: 'user' | 'plugin' | 'project'
}

/**
 * A reusable context profile for a *kind* of repo. Materialized into a repo's
 * `.claude/settings.local.json` + `.mcp.json` before claude launches, so each
 * session only carries the skills/MCP relevant to its category.
 */
export interface RepoCategory {
  id: string
  /** Display name, e.g. 'functional-service' | 'database-services' | 'front-end' | 'core'. */
  name: string
  color: string | null
  /** Skill names set to 'on' (fully loaded) for this category. */
  enabledSkills: string[]
  /** Visibility floor applied to every other discovered skill. */
  unlistedSkillFloor: 'name-only' | 'off'
  /** MCP servers active for this category; written into the repo's .mcp.json. */
  mcpServers: McpServerDef[]
  /** Basenames/extensions whose presence at the repo root suggests this category. */
  detectFiles: string[]
}

export interface TerminalConfig {
  id: string
  kind: TerminalKind
  /** Editable label shown on the tab. Defaults to the kind. */
  title: string
  order: number
  /** claude only: extra args passed to the CLI on spawn (e.g. --model). */
  claudeArgs?: string[]
  /** claude only: how the terminal is started when restored on launch. */
  startMode?: StartMode
}

/**
 * Marks a session as a parallel task running in a git worktree spun off from
 * another session's repo. Present only on worktree sessions; absent/null on
 * ordinary sessions.
 */
export interface WorktreeMeta {
  /** The session this worktree was spun off from. */
  parentSessionId: string
  /** Branch checked out in the worktree (the task branch). */
  branch: string
  /** Branch the task merges back into — the parent's branch at creation time. */
  baseBranch: string
  /** Absolute path of the main repo working tree (where the merge runs). */
  baseFolder: string
}

export interface SessionConfig {
  id: string
  name: string
  folder: string
  color: string | null
  order: number
  /** Terminals running in this project's folder; always at least one. */
  terminals: TerminalConfig[]
  /** Which terminal tab was last active, restored on launch. */
  activeTerminalId: string | null
  /** Explorer tree state, persisted so the tree reopens as you left it. */
  expandedPaths: string[]
  /** Context-profile category for this repo; null = leave claude's defaults. */
  categoryId?: string | null
  /** Set when this session is a git-worktree parallel task; null otherwise. */
  worktree?: WorktreeMeta | null
}

/** Git facts about a session's folder, used to gate/prefill the parallel-task UI. */
export interface WorktreeInfo {
  /** Whether the folder is inside a git work tree. */
  isRepo: boolean
  /** Absolute path of the repo's top-level working tree, or null if not a repo. */
  repoRoot: string | null
  /** Current branch name (or detached HEAD sha), or null if not a repo. */
  branch: string | null
}

/** Outcome of merging a worktree task branch back into its base branch. */
export interface MergeResult {
  ok: boolean
  /** True when the merge stopped on conflicts (resolve manually in the terminal). */
  conflict: boolean
  /** True when the task branch had no commits beyond base — nothing was merged. */
  nothingToMerge?: boolean
  /** True when uncommitted task changes were committed as part of the merge. */
  autoCommitted?: boolean
  /** Combined git stdout+stderr, surfaced to the user. */
  output: string
}

/**
 * Live git facts about a worktree task, fetched before merge/remove so the UI
 * can warn precisely (uncommitted work, nothing to merge, broken folder).
 */
export interface WorktreeTaskState {
  /** The worktree folder exists on disk. */
  folderExists: boolean
  /** Uncommitted (changed/untracked) files in the worktree; -1 if unknown/broken. */
  dirty: number
  /** Commits on the task branch not yet on the base branch; -1 if unknown. */
  ahead: number
}

export interface TerminalInfo {
  config: TerminalConfig
  status: SessionStatus
  pid: number | null
  lastOutputAt: number
  exitCode: number | null
}

export interface SessionInfo {
  config: SessionConfig
  terminals: TerminalInfo[]
  /** Aggregate status across this session's terminals, for the sidebar. */
  status: SessionStatus
}

export interface DirEntry {
  name: string
  relPath: string
  isDir: boolean
  size: number
  mtimeMs: number
}

export interface FsEvent {
  kind: 'add' | 'unlink' | 'change' | 'addDir' | 'unlinkDir'
  relPath: string
  at: number
}

export type FileContent =
  | { kind: 'text'; content: string; truncated: boolean; size: number }
  | { kind: 'image'; dataUrl: string; size: number }
  | { kind: 'binary'; size: number }

export interface Settings {
  /** Command template for "open in editor". ${path}, ${dir} are substituted. */
  editorCommand: string
  scrollbackLines: number
  fontFamily: string
  fontSize: number
  /** Directory/file basenames hidden from the explorer and excluded from watching. */
  ignoreNames: string[]
  notifyOnAttention: boolean
}

export interface WindowBounds {
  x: number | null
  y: number | null
  width: number
  height: number
  maximized: boolean
}

export interface AppStateFile {
  schemaVersion: 1
  sessions: SessionConfig[]
  activeSessionId: string | null
  window: WindowBounds
  settings: Settings
  /** Reusable per-category context profiles, shared across sessions. */
  categories: RepoCategory[]
}

export const DEFAULT_SETTINGS: Settings = {
  editorCommand: 'code "${path}"',
  scrollbackLines: 10000,
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  fontSize: 14,
  ignoreNames: ['.git', 'node_modules', 'dist', 'build', 'out', '.venv', '__pycache__', 'target'],
  notifyOnAttention: true
}

/**
 * Seed categories on first run. Skills/MCP start empty (the user fills them via
 * the Categories dialog); `detectFiles` give a best-effort auto-suggestion that
 * the manual dropdown can always override. Fixed ids so they stay stable.
 */
export const DEFAULT_CATEGORIES: RepoCategory[] = [
  {
    id: 'cat-front-end',
    name: 'front-end',
    color: '#3b82f6',
    enabledSkills: [],
    unlistedSkillFloor: 'name-only',
    mcpServers: [],
    detectFiles: ['angular.json', 'nx.json', 'tsconfig.app.json', 'package.json']
  },
  {
    id: 'cat-database-services',
    name: 'database-services',
    color: '#a855f7',
    enabledSkills: [],
    unlistedSkillFloor: 'name-only',
    mcpServers: [],
    detectFiles: ['flyway.conf', 'data_loads.yaml', 'db', '*.sql']
  },
  {
    id: 'cat-functional-service',
    name: 'functional-service',
    color: '#22c55e',
    enabledSkills: [],
    unlistedSkillFloor: 'name-only',
    mcpServers: [],
    detectFiles: ['pom.xml', 'build.gradle', 'src/main/java']
  },
  {
    id: 'cat-core',
    name: 'core',
    color: '#f59e0b',
    enabledSkills: [],
    unlistedSkillFloor: 'name-only',
    mcpServers: [],
    detectFiles: []
  }
]
