import type {
  AttachmentInfo,
  AutoExpandRun,
  DirEntry,
  Feature,
  FileContent,
  FsEvent,
  GitCommit,
  GitFileChange,
  GitFileDiff,
  GitStatus,
  MergeResult,
  RepoCategory,
  ReusableAction,
  RunActionResult,
  SentinelRun,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  Settings,
  SkillInfo,
  TerminalConfig,
  TerminalInfo,
  TerminalKind,
  UsageSnapshot,
  WorktreeInfo,
  WorktreeTaskState
} from './types'

/** Options for spinning off a parallel git-worktree task from a session. */
export interface CreateWorktreeOpts {
  /** Display name for the new task session. */
  name: string
  /** Branch to create for the task (must not already exist). */
  branch: string
  /** Branch/ref the worktree is created from and merged back into. */
  baseBranch: string
  /** Optional first prompt typed into the task's claude terminal (not auto-submitted). */
  initialPrompt?: string
}

export type Unsubscribe = () => void

/** The typed API exposed to the renderer via contextBridge as `window.api`. */
export interface Api {
  /** Node's process.platform ('win32' | 'darwin' | 'linux'), for platform-aware UI. */
  readonly platform: string

  // session lifecycle
  createSession(folder: string, opts?: Partial<SessionConfig>): Promise<SessionInfo>
  closeSession(id: string): Promise<void>
  updateSession(id: string, patch: Partial<SessionConfig>): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  setActiveSession(id: string | null): Promise<void>
  getActiveSession(): Promise<string | null>
  pickFolder(): Promise<string | null>

  // parallel tasks (git worktrees spun off a session's repo)
  /** Git facts about a session's folder; gates the "parallel task" action. */
  worktreeInfo(sessionId: string): Promise<WorktreeInfo>
  /** Create a worktree + linked task session off `parentSessionId`. Throws on git failure. */
  createWorktree(parentSessionId: string, opts: CreateWorktreeOpts): Promise<SessionInfo>
  /** Live git facts about a worktree task (uncommitted files, commits ahead of base). */
  worktreeState(sessionId: string): Promise<WorktreeTaskState>
  /** Merge a task branch into its base; commitFirst commits pending work to the branch first. */
  mergeWorktree(sessionId: string, commitFirst: boolean): Promise<MergeResult>
  /** Start the merge for real, LEAVING conflict markers in the base repo for assisted resolution. */
  startConflictedMerge(sessionId: string): Promise<MergeResult>
  /** Close a worktree task, remove its worktree, and optionally delete its branch. */
  removeWorktree(sessionId: string, deleteBranch: boolean): Promise<void>

  // git (status + history for a session's repo)
  /** Working-tree + branch state of a session's repo; isRepo:false off-repo. */
  gitStatus(sessionId: string): Promise<GitStatus>
  /** Recent commits on the current branch, newest first ([] for empty/non-repo). */
  gitLog(sessionId: string, limit?: number): Promise<GitCommit[]>
  /** Initialize a git repo in the session's folder; returns the new git facts. */
  gitInit(sessionId: string): Promise<WorktreeInfo>
  /** Changed files (staged, unstaged, untracked) in the session's working tree. */
  gitChangedFiles(sessionId: string): Promise<GitFileChange[]>
  /** Unified diff of one file's working-tree state against HEAD (path is repo-root-relative). */
  gitFileDiff(sessionId: string, path: string): Promise<GitFileDiff>

  // terminals (within a session's folder)
  addTerminal(sessionId: string, kind: TerminalKind): Promise<TerminalInfo | null>
  closeTerminal(sessionId: string, terminalId: string): Promise<void>
  restartTerminal(terminalId: string, mode: 'fresh' | 'resume'): Promise<void>
  updateTerminal(terminalId: string, patch: Partial<TerminalConfig>): Promise<void>
  setActiveTerminal(sessionId: string, terminalId: string): Promise<void>

  // terminal data plane (keyed by terminal id)
  ptyWrite(terminalId: string, data: string): void
  ptyResize(terminalId: string, cols: number, rows: number): void
  /** Marks the renderer attached and returns buffered scrollback. Live data
   *  for this terminal is only forwarded after this resolves. */
  ptyAttach(terminalId: string): Promise<string>
  onPtyData(cb: (terminalId: string, data: string) => void): Unsubscribe

  // repo categories (context profiles: which skills/MCP load per kind of repo)
  listCategories(): Promise<RepoCategory[]>
  saveCategories(categories: RepoCategory[]): Promise<void>
  /** Reassign a session's category; returns the claude terminal ids to restart. */
  setSessionCategory(sessionId: string, categoryId: string | null): Promise<string[]>
  listClaudeSkills(): Promise<SkillInfo[]>
  /** User-scope MCP servers from ~/.claude.json, offered as one-click picks. */
  listUserMcpServers(): Promise<RepoCategory['mcpServers']>
  /** Best-effort category suggestion for a freshly-picked folder. */
  detectCategory(folder: string): Promise<string | null>

  // reusable actions (saved shell commands, run from the Actions panel)
  listActions(): Promise<ReusableAction[]>
  saveActions(actions: ReusableAction[]): Promise<void>
  /** Run an action in a session: opens/reuses its terminal tab and types the command. */
  runAction(sessionId: string, actionId: string): Promise<RunActionResult | null>

  // features & specs (per-session feature plans, implemented via worktree tasks)
  /** Features for one session, oldest first. */
  listFeatures(sessionId: string): Promise<Feature[]>
  /** Create or update one feature (upsert by id). */
  saveFeature(feature: Feature): Promise<void>
  deleteFeature(id: string): Promise<void>
  /** Spin off a worktree task session to implement a feature's specs. Throws on git failure. */
  implementFeature(id: string): Promise<SessionInfo>

  // auto-expand (self-expanding features; config is saved via updateSession)
  /** Run history for a session's auto-expand pipeline, newest first (in-memory). */
  listAutoExpandRuns(sessionId: string): Promise<AutoExpandRun[]>
  /** Trigger one pipeline run right now, regardless of the enabled state/timer. */
  runAutoExpand(sessionId: string): Promise<void>
  /** Fired whenever a session's auto-expand run list changes (phase/status updates). */
  onAutoExpandRuns(cb: (sessionId: string, runs: AutoExpandRun[]) => void): Unsubscribe

  // sentinels (background watcher agents; configs are saved via updateSession)
  /** Run history for a session's sentinels, newest first (in-memory, this app run only). */
  listSentinelRuns(sessionId: string): Promise<SentinelRun[]>
  /** Trigger one sentinel right now, regardless of its trigger/enabled state. */
  runSentinel(sessionId: string, sentinelId: string): Promise<void>
  /** Fired whenever a session's sentinel run list changes (run started/finished). */
  onSentinelRuns(cb: (sessionId: string, runs: SentinelRun[]) => void): Unsubscribe

  // session events
  onSessionsChanged(cb: () => void): Unsubscribe
  onStatusChange(cb: (terminalId: string, status: SessionStatus) => void): Unsubscribe
  onFocusSession(cb: (sessionId: string, terminalId?: string) => void): Unsubscribe

  // filesystem (paths are relative to the session's folder; validated in main)
  readDir(id: string, relPath: string): Promise<DirEntry[]>
  readFile(id: string, relPath: string): Promise<FileContent>
  watchPath(id: string, relPath: string): Promise<void>
  unwatchPath(id: string, relPath: string): Promise<void>
  onFsEvents(cb: (id: string, events: FsEvent[]) => void): Unsubscribe
  openInEditor(id: string, relPath: string): Promise<void>
  revealInExplorer(id: string, relPath: string): Promise<void>

  // chat image attachments (history shown below the file explorer)
  /** Save the clipboard image as an attachment; null when the clipboard has no image. */
  attachClipboardImage(sessionId: string): Promise<AttachmentInfo | null>
  /** Copy an image file (dropped from the OS) into the session's attachments. */
  attachImageFile(sessionId: string, srcPath: string): Promise<AttachmentInfo | null>
  /** Save raw image bytes (dropped content without a filesystem path). */
  attachImageData(sessionId: string, name: string, bytes: Uint8Array): Promise<AttachmentInfo | null>
  /** Newest-first attachment history for a session. */
  listAttachments(sessionId: string): Promise<AttachmentInfo[]>
  /** Full-size image as a data URL, for the preview lightbox. */
  readAttachment(sessionId: string, fileName: string): Promise<string>
  deleteAttachment(sessionId: string, fileName: string): Promise<void>
  /** Absolute path of a dragged-in File (Electron webUtils); '' when it has none. */
  pathForFile(file: File): string
  // usage (token cost aggregated from Claude Code transcripts)
  getUsage(): Promise<UsageSnapshot>

  // custom app background image
  /** Pick an image file and store it as the app background; returns its data URL (null = cancelled). */
  pickBackgroundImage(): Promise<string | null>
  /** The stored background image as a data URL, or null when none is set. */
  getBackgroundImage(): Promise<string | null>
  /** Remove the stored background image. */
  clearBackgroundImage(): Promise<void>

  // misc
  openExternal(url: string): void
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): void
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<void>
}
