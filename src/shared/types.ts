/**
 * Lifecycle of a terminal as seen in the sidebar/tabs.
 *  starting        — process is launching, nothing useful yet.
 *  working         — output is actively flowing; the agent is busy.
 *  needs-attention — claude is blocked on YOU (asked a question / hit a prompt).
 *  done            — claude finished its turn and is waiting for you; output is
 *                    ready to review. Only claude terminals reach this; plain
 *                    shells settle to `idle` instead.
 *  idle            — at rest with nothing pending (a quiet shell, or fallback).
 *  exited          — the process has exited.
 *  error           — failed to spawn / crashed.
 */
export type SessionStatus =
  | 'starting'
  | 'working'
  | 'needs-attention'
  | 'done'
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

/** Where a reusable action runs: a shell terminal, or the session's claude. */
export type ActionShell = TerminalKind

/**
 * A saved shell command (e.g. "npm run build") or claude prompt shown in the
 * Actions panel. Shell actions open (or reuse) a terminal tab named after the
 * action and type the command there; claude actions type the prompt into the
 * session's existing claude conversation. Stored globally — the same action
 * can be re-triggered in any session/repo.
 */
export interface ReusableAction {
  id: string
  /** Display name, also used as the terminal tab title (shell actions), e.g. 'Build'. */
  name: string
  /** The shell command — or, for claude actions, the prompt — submitted with Enter. */
  command: string
  /** Which shell runs the command, or 'claude' to send it as a prompt. */
  shell: ActionShell
}

/** Result of running a reusable action in a session. */
export interface RunActionResult {
  /** The terminal the command was typed into (focus this tab). */
  terminalId: string
  /** True when the terminal was (re)spawned — the renderer must remount xterm. */
  respawned: boolean
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
  /** Set when this terminal hosts a reusable action; one tab is reused per action. */
  actionId?: string
}

/**
 * How a worktree task lands its work into the base branch:
 * 'merge' — merge the task branch directly into base (the default).
 * 'pr'    — push the branch and open a pull request for review instead.
 */
export type WorktreeCompletion = 'merge' | 'pr'

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
  /** How the task lands: direct merge (default) or a PR for review. Absent = 'merge'. */
  completion?: WorktreeCompletion
  /**
   * When true, Maestro performs the completion action (merge or PR) automatically
   * once claude finishes — it commits pending work and runs `completion` without a
   * manual click. Absent/false = the user triggers completion from the sidebar.
   */
  autoComplete?: boolean
  /**
   * Set once auto-complete has run for this task, so it fires at most once. The
   * value is the kind of completion performed ('merge'|'pr'); absent = not yet
   * auto-completed. Manual completion never sets this.
   */
  autoCompletedAs?: WorktreeCompletion
}

/** One prompt waiting in a session's queue, auto-sent when claude sits idle. */
export interface QueuedPrompt {
  id: string
  text: string
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
  /** Background watcher agents configured for this session. */
  sentinels?: SentinelConfig[]
  /** Self-expanding-features pipeline config; null/absent = never configured. */
  autoExpand?: AutoExpandConfig | null
  /** Follow-up prompts dispatched to claude, oldest first, when it next sits idle. */
  promptQueue?: QueuedPrompt[]
}

// ---------- sentinels (background watcher agents) ----------

/**
 * What starts a sentinel run: 'commit' fires when the session folder's git
 * HEAD changes (new commits, merges, rebases); 'interval' fires on a timer.
 */
export type SentinelTrigger = 'commit' | 'interval'

/**
 * A background watcher attached to a session. Each run spawns a headless,
 * read-only `claude -p` in the session's folder with `prompt` as its watch
 * instructions and reports structured findings back to the UI.
 */
export interface SentinelConfig {
  id: string
  /** Display name, e.g. 'Convention guard'. */
  name: string
  /** The watch instructions given to the headless agent on every run. */
  prompt: string
  trigger: SentinelTrigger
  /** interval trigger only: minutes between runs. */
  intervalMinutes?: number
  /** Built-in template this was created from, for display; null when custom. */
  templateId?: string | null
  enabled: boolean
}

export type SentinelSeverity = 'info' | 'warning' | 'critical'

/** One issue reported by a sentinel run. */
export interface SentinelFinding {
  severity: SentinelSeverity
  /** Short headline, e.g. 'Logger created per call'. */
  title: string
  /** What, why, and where — the agent's reasoning. */
  detail: string
  /** Repo-relative file the finding refers to, when applicable. */
  file?: string
}

export type SentinelRunStatus = 'running' | 'ok' | 'findings' | 'error'

/** One execution of a sentinel. Held in memory (not persisted across restarts). */
export interface SentinelRun {
  id: string
  sentinelId: string
  sessionId: string
  startedAt: number
  finishedAt: number | null
  status: SentinelRunStatus
  /** What fired the run, e.g. 'commits abc1234 → def5678', 'interval', 'manual'. */
  reason: string
  /** The agent's one-line verdict (or the error message on status 'error'). */
  summary: string
  findings: SentinelFinding[]
}

/** A built-in starting point for a sentinel; prefills the create dialog. */
export interface SentinelTemplate {
  id: string
  name: string
  description: string
  trigger: SentinelTrigger
  intervalMinutes?: number
  prompt: string
}

export const SENTINEL_TEMPLATES: SentinelTemplate[] = [
  {
    id: 'tpl-convention-guard',
    name: 'Convention guard',
    description: 'Reviews new commits against the project’s coding conventions.',
    trigger: 'commit',
    prompt:
      'Review the new commits for violations of this project’s coding conventions. ' +
      'First read CLAUDE.md, CONTRIBUTING.md or any other convention/style docs in the repo ' +
      'to learn the actual rules (naming, structure, error handling, logging, docs, tests). ' +
      'Then inspect the changed code and flag concrete violations, citing the rule. ' +
      'Also flag code that is clearly inconsistent with the style of the surrounding code. ' +
      'No generic style opinions — only rules this project states or visibly follows.'
  },
  {
    id: 'tpl-bug-watch',
    name: 'Bug watch',
    description: 'Reviews new commits for likely bugs and regressions.',
    trigger: 'commit',
    prompt:
      'Review the new commits for likely bugs: broken edge cases, missing error handling, ' +
      'off-by-one or inverted conditions, race conditions, leaked resources, and changes ' +
      'that break callers elsewhere in the repo. Before flagging a changed function, check ' +
      'its call sites. Report only genuine issues with concrete reasoning — no style nits.'
  },
  {
    id: 'tpl-pr-watch',
    name: 'Incoming PR watch',
    description: 'Periodically checks for open PRs targeting this branch (needs the gh CLI).',
    trigger: 'interval',
    intervalMinutes: 15,
    prompt:
      'Determine the current branch, then use `gh pr list --base <branch>` to find open pull ' +
      'requests targeting it (use `gh pr view`/`gh pr diff` for details). Summarize each open ' +
      'PR: what it changes, risk areas, and whether it touches the same files as recent local ' +
      'commits (possible conflicts). Report a finding per PR worth attention; all clear when none.'
  }
]

// ---------- auto-expand (self-expanding features pipeline) ----------

/**
 * Per-session config for the self-expanding-features pipeline. On a timer,
 * Maestro runs an idea agent (headless, read-only claude) that proposes new
 * feature ideas for the repo, an evaluator agent that picks the best idea and
 * writes it up as a feature with concrete specs, and then implements that
 * feature the ordinary way: a worktree task session branched off `branch`.
 * The branch is created automatically when it doesn't exist, so the whole
 * expansion stays isolated until the user merges it.
 */
export interface AutoExpandConfig {
  enabled: boolean
  /** Branch the expansion grows on: task worktrees branch off it and merge back into it. */
  branch: string
  /** Minutes between pipeline runs. */
  intervalMinutes: number
  /** Optional steering for the idea agent (themes, constraints, no-go areas). */
  guidance: string
  /** Max auto-created features being implemented at once; runs are skipped above it. */
  maxConcurrent: number
}

export const DEFAULT_AUTO_EXPAND: AutoExpandConfig = {
  enabled: false,
  branch: 'auto/expansion',
  intervalMinutes: 60,
  guidance: '',
  maxConcurrent: 1
}

/** One idea proposed by the idea agent (and scored by the evaluator). */
export interface AutoExpandIdea {
  title: string
  description: string
  /** Why this idea fits this repo/users, per the agent. */
  rationale: string
}

/** Pipeline progress of a run, shown live in the dialog. */
export type AutoExpandPhase = 'ideating' | 'evaluating' | 'implementing' | 'done'

export type AutoExpandRunStatus = 'running' | 'done' | 'skipped' | 'error'

/** One execution of the auto-expand pipeline. Held in memory (not persisted). */
export interface AutoExpandRun {
  id: string
  sessionId: string
  startedAt: number
  finishedAt: number | null
  status: AutoExpandRunStatus
  phase: AutoExpandPhase
  /** What fired the run: 'interval' or 'manual'. */
  reason: string
  /** Ideas proposed by the idea agent (empty until that phase completes). */
  ideas: AutoExpandIdea[]
  /** Title of the idea the evaluator picked; null until chosen. */
  chosenTitle: string | null
  /** The evaluator's reasoning for its pick (or the skip/error message). */
  verdict: string
  /** The feature created from the winning idea; null until created. */
  featureId: string | null
  /** The worktree task session implementing it; null until spawned. */
  taskSessionId: string | null
}

/** Outcome of saving an exported transcript via the native save dialog. */
export interface TranscriptExportResult {
  /** True when the user cancelled the save dialog — nothing was written. */
  canceled: boolean
  /** Absolute path the file was written to; present only on success. */
  path?: string
  /** Why the write failed (e.g. permission denied); present only on failure. */
  error?: string
}

/** One commit in a repo's history, for the sidebar Git panel. */
export interface GitCommit {
  /** Full 40-char SHA. */
  hash: string
  /** Abbreviated SHA, for display. */
  shortHash: string
  /** First line of the commit message. */
  subject: string
  /** Author name. */
  author: string
  /** Relative date string from git (e.g. '2 hours ago'). */
  relDate: string
  /** Ref decorations, e.g. 'HEAD -> main, origin/main, tag: v1'; '' when none. */
  refs: string
}

/**
 * Working-tree + branch state of a session's repo, shown in the Git panel.
 * `isRepo:false` for a non-repo folder (the panel then offers to initialize one).
 */
export interface GitStatus {
  isRepo: boolean
  /** Current branch, or null when detached / not a repo. */
  branch: string | null
  /** Upstream tracking ref (e.g. 'origin/main'), or null. */
  upstream: string | null
  /** Commits ahead of the upstream. */
  ahead: number
  /** Commits behind the upstream. */
  behind: number
  /** Files with staged changes. */
  staged: number
  /** Tracked files with unstaged changes (includes unmerged/conflicted). */
  unstaged: number
  /** Untracked files. */
  untracked: number
  /** URL of the 'origin' remote, or null when there is none. */
  remoteUrl: string | null
}

/** One changed path in a repo's working tree, listed in the Git panel. */
export interface GitFileChange {
  /** Path relative to the repo root, forward slashes (as git prints it). */
  path: string
  /**
   * Compact status code: the staged+unstaged letters from porcelain v2
   * (e.g. 'M', 'A', 'D', 'AM'), 'U' for unmerged, '?' for untracked.
   */
  status: string
  /** True when at least part of the change is staged. */
  staged: boolean
  /** Previous path for renames/copies; undefined otherwise. */
  origPath?: string
}

/** Unified diff of one file's working-tree state against HEAD, for the diff tab. */
export interface GitFileDiff {
  /** Unified diff text; '' when the file has no changes against HEAD. */
  diff: string
  /** True when git reports the change as binary (no text diff available). */
  binary: boolean
  /** True when the diff text was cut off because it exceeded the size cap. */
  truncated: boolean
}

// ---------- features & specs ----------

/** One requirement line within a feature. `done` is a manual authoring checkbox. */
export interface Spec {
  id: string
  /** The requirement text, e.g. 'Toggle persists across restarts'. */
  text: string
  /** User-toggled "this spec is satisfied" marker; purely for tracking. */
  done: boolean
}

/**
 * 'draft'        — being authored, no task spun off yet.
 * 'implementing' — a worktree task session has been created to build it.
 * 'merged'       — the user marked the work done (task merged/closed).
 */
export type FeatureStatus = 'draft' | 'implementing' | 'merged'

/**
 * A planned unit of work attached to one session's repo: a title, a description
 * and a list of specs. When implemented, Maestro spins off a git-worktree task
 * (a sub-session) whose claude is prompted to build the specs from an on-disk
 * spec file written into the worktree.
 */
export interface Feature {
  id: string
  /** The session (repo) this feature belongs to. */
  sessionId: string
  /** Short title, e.g. 'Dark mode toggle'. */
  title: string
  /** Free-form description of the feature's intent. */
  description: string
  specs: Spec[]
  status: FeatureStatus
  /** The worktree task session spawned to implement it; null until implemented. */
  taskSessionId?: string | null
  /** True when the feature was created by the auto-expand pipeline. */
  auto?: boolean
  /**
   * How the implementing worktree task should land its work; carried into the
   * task's WorktreeMeta at Implement time. Absent = direct merge.
   */
  completion?: WorktreeCompletion
  /** When true, the implementing task auto-completes once claude finishes. */
  autoComplete?: boolean
  createdAt: number
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
  /**
   * Post-merge push of the base branch to its upstream: true = pushed,
   * false = push failed (the merge itself still succeeded), undefined = base
   * branch has no upstream, so there was nothing to push to.
   */
  pushed?: boolean
  /** Combined git stdout+stderr, surfaced to the user. */
  output: string
}

/**
 * Outcome of opening a pull request for a worktree task branch (via the `gh`
 * CLI). The branch is pushed first; the PR targets the task's base branch.
 */
export interface PullRequestResult {
  ok: boolean
  /** URL of the created (or already-existing) PR, when `gh` reported one. */
  url?: string
  /** True when a PR for this branch already existed — `url` points at it. */
  alreadyExists?: boolean
  /** True when the task branch had no commits beyond base — nothing to PR. */
  nothingToMerge?: boolean
  /** True when uncommitted task changes were committed before pushing. */
  autoCommitted?: boolean
  /** Combined gh/git stdout+stderr, surfaced to the user. */
  output: string
}

/**
 * Outcome of an automatic worktree completion (auto-merge or auto-PR), pushed
 * to the renderer so it can show a notice without the user having clicked.
 */
export interface WorktreeAutoCompleteEvent {
  /** Which action ran. */
  kind: WorktreeCompletion
  /** Task display name, for the message. */
  name: string
  /** Task branch that was completed. */
  branch: string
  /** Base branch it targeted. */
  baseBranch: string
  ok: boolean
  /** PR mode: URL of the opened PR, when known. */
  url?: string
  /** True when auto-merge stopped because the merge would conflict. */
  conflict?: boolean
  /** Human-readable detail (git/gh output or a short summary). */
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
  /**
   * Files that would conflict if the task branch were merged into base, from a
   * read-only `git merge-tree` dry-run. [] = merge predicted clean, null = the
   * prediction is unavailable (missing refs, old git, nothing to merge).
   */
  conflictFiles: string[] | null
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

/**
 * An image attached to a session's chat (pasted or dropped into the terminal).
 * Stored on disk under userData/attachments/<sessionId>; the history shown
 * below the file explorer is derived from that folder.
 */
export interface AttachmentInfo {
  /** Unique file name within the session's attachments folder. */
  fileName: string
  /** Absolute path on disk — this is what gets pasted into the CLI. */
  absPath: string
  /** Attach time (file mtime, ms). */
  at: number
  size: number
  /** Small preview as a data URL, sized for the history list. */
  thumbDataUrl: string
}

export type FileContent =
  | { kind: 'text'; content: string; truncated: boolean; size: number }
  | { kind: 'image'; dataUrl: string; size: number }
  | { kind: 'binary'; size: number }

/** Token counts + computed USD cost, summed over some scope (project, day, model…). */
export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  /** Cache-creation input tokens (5m + 1h combined). */
  cacheWriteTokens: number
  cacheReadTokens: number
  costUSD: number
}

/**
 * Usage attributed to one Claude Code project directory
 * (`~/.claude/projects/<dir>`). `dir` is the path-encoded repo folder, which
 * the renderer matches back to Maestro sessions by encoding each session's
 * folder the same way (every non-alphanumeric char becomes '-').
 */
export interface ProjectUsage {
  dir: string
  total: TokenTotals
  today: TokenTotals
  /** Most recent activity in this project, ms since epoch. */
  lastActivityAt: number
}

/**
 * Burn-rate projection for the current 5-hour usage window. Plan quotas are
 * not exposed locally, so both the window grid and the token limit are
 * inferred from the transcripts: activity is partitioned into 5-hour blocks
 * (hour-aligned, mirroring Claude's rolling limit windows) and the limit is
 * the largest token count seen in any completed block.
 */
export interface UsageProjection {
  /** Start of the current block, ms since epoch (hour-aligned). */
  blockStartAt: number
  /** When the current block's window resets, ms since epoch. */
  blockEndAt: number
  /** Tokens consumed so far in the current block (all token kinds). */
  blockTokens: number
  /** Largest tokens in any completed block — stand-in for the plan limit (0 = no history). */
  maxBlockTokens: number
  /** Burn rate over the active part of the current block. */
  tokensPerMin: number
  /**
   * When the block is projected to hit `maxBlockTokens` at the current rate,
   * ms since epoch. Null when not on pace to run out before the window
   * resets, or when there is no history to infer a limit from.
   */
  runsOutAt: number | null
}

/** One rate-limit window from the subscription usage endpoint. */
export interface UsageLimitWindow {
  /** Share of the plan limit consumed in this window, as a percentage (0–100). */
  utilization: number
  /** When this window's limit resets, ms since epoch; null when not tracked. */
  resetsAt: number | null
}

/**
 * Subscription plan usage limits — the same figures Claude Code's `/usage`
 * shows (current 5-hour session, current week all-models, and per-model
 * weekly windows). Fetched live from Anthropic with the OAuth token in
 * `~/.claude/.credentials.json`; the whole object is null when usage is
 * unavailable (no subscription token, an expired token, or a failed request),
 * in which case the widget falls back to its transcript-based estimates.
 */
export interface UsageLimits {
  /** Current rolling 5-hour session window. */
  session: UsageLimitWindow
  /** Current week, all models combined. */
  week: UsageLimitWindow
  /** Current week, Opus only; null when the plan doesn't track it separately. */
  weekOpus: UsageLimitWindow | null
  /** Current week, Sonnet only; null when the plan doesn't track it separately. */
  weekSonnet: UsageLimitWindow | null
  /** When this snapshot was fetched, ms since epoch. */
  fetchedAt: number
}

/** Aggregated Claude Code API usage parsed from ~/.claude/projects transcripts. */
export interface UsageSnapshot {
  total: TokenTotals
  today: TokenTotals
  /** Current calendar month (local time). */
  month: TokenTotals
  perProject: ProjectUsage[]
  perModel: { model: string; totals: TokenTotals }[]
  /** Null when there is no activity in the current 5-hour window. */
  projection: UsageProjection | null
  updatedAt: number
}

export interface Settings {
  /** Command template for "open in editor". ${path}, ${dir} are substituted. */
  editorCommand: string
  scrollbackLines: number
  fontFamily: string
  fontSize: number
  /** Directory/file basenames hidden from the explorer and excluded from watching. */
  ignoreNames: string[]
  notifyOnAttention: boolean
  /**
   * File name of the custom app background image (stored under
   * userData/background/); null = no custom background.
   */
  backgroundImage: string | null
  /** Opacity of the background image layer (0–1); panels stay readable above it. */
  backgroundOpacity: number
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
  /** Saved shell commands re-runnable from the Actions panel, shared across sessions. */
  actions: ReusableAction[]
  /** Features (with their specs) authored across all sessions. */
  features: Feature[]
}

export const DEFAULT_SETTINGS: Settings = {
  editorCommand: 'code "${path}"',
  scrollbackLines: 10000,
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  fontSize: 14,
  ignoreNames: ['.git', 'node_modules', 'dist', 'build', 'out', '.venv', '__pycache__', 'target'],
  notifyOnAttention: true,
  backgroundImage: null,
  backgroundOpacity: 0.3
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
