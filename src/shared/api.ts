import type {
  DirEntry,
  FileContent,
  FsEvent,
  MergeResult,
  RepoCategory,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  Settings,
  SkillInfo,
  TerminalConfig,
  TerminalInfo,
  TerminalKind,
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
  /** Close a worktree task, remove its worktree, and optionally delete its branch. */
  removeWorktree(sessionId: string, deleteBranch: boolean): Promise<void>

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

  // misc
  openExternal(url: string): void
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): void
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<void>
}
