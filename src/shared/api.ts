import type { GameCelebration, GameSnapshot } from './gamification'
import type {
  AgentsSnapshot,
  AttachmentInfo,
  AutoExpandRun,
  BranchListing,
  ConductorImage,
  ConductorMessage,
  ConductorTaskOptions,
  ConversationSummary,
  DirEntry,
  FactoryArtifactKind,
  FactoryAudit,
  FactoryRun,
  FactorySource,
  FactoryState,
  FactorySuggestion,
  Feature,
  FileContent,
  FsEvent,
  GitCommit,
  GitFileChange,
  GitFileDiff,
  GitStatus,
  MergeResult,
  PullRequestResult,
  RepoCategory,
  RepoCheckpoint,
  RepoMapInfo,
  RestoreCheckpointResult,
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
  TokenEfficiencyConfig,
  TokenEfficiencyOverride,
  TokenEfficiencyStatus,
  TranscriptExportResult,
  UsageLimits,
  UsageSnapshot,
  WorktreeAutoCompleteEvent,
  WorktreeCompletion,
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
  /** How the task lands its work: direct merge (default) or a PR for review. */
  completion?: WorktreeCompletion
  /** When true, Maestro auto-runs `completion` once claude finishes the task. */
  autoComplete?: boolean
  /** When true, the task's claude launches in plan mode (`--permission-mode plan`). */
  plan?: boolean
  /**
   * When true, Maestro auto-approves the plan-mode prompt once claude presents
   * its plan, so the task moves from planning into execution unattended.
   * Only meaningful together with `plan`.
   */
  autoAcceptPlan?: boolean
  /** Model alias for the task's claude (`--model <alias>`); absent = CLI default. */
  model?: 'opus' | 'sonnet' | 'haiku'
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
  /** Open a PR for a task branch against its base (commitFirst commits pending work first). */
  createWorktreePr(sessionId: string, commitFirst: boolean): Promise<PullRequestResult>
  /** Close a worktree task, remove its worktree, and optionally delete its branch. */
  removeWorktree(sessionId: string, deleteBranch: boolean): Promise<void>
  /**
   * Fired when Maestro auto-completes a worktree task (merge or PR) after claude
   * finished, so the renderer can surface the outcome without a click.
   */
  onWorktreeAutoCompleted(
    cb: (sessionId: string, result: WorktreeAutoCompleteEvent) => void
  ): Unsubscribe

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
  /** Local branches + default branch of a session's repo (for the base-branch picker). */
  gitBranches(sessionId: string): Promise<BranchListing>

  // repo checkpoints (a working-tree safety net taken before a risky prompt)
  /** Snapshot the working tree into a labeled checkpoint. Throws on git failure. */
  createCheckpoint(sessionId: string, label: string): Promise<RepoCheckpoint>
  /** Recent checkpoints for a session's repo, newest first. */
  listCheckpoints(sessionId: string): Promise<RepoCheckpoint[]>
  /** Restore the working tree back to a checkpoint (guarded; auto-saves current state first). */
  restoreCheckpoint(sessionId: string, id: string): Promise<RestoreCheckpointResult>
  /** Delete one checkpoint. */
  deleteCheckpoint(sessionId: string, id: string): Promise<void>

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

  // prompt queue (follow-up prompts auto-sent to claude when the terminal sits idle)
  /** Append a prompt to a session's queue. */
  queueAdd(sessionId: string, text: string): Promise<void>
  /** Delete one queued prompt. */
  queueRemove(sessionId: string, itemId: string): Promise<void>
  /** Move a queued prompt one slot up (-1) or down (+1). */
  queueMove(sessionId: string, itemId: string, delta: -1 | 1): Promise<void>

  // repo categories (context profiles: which skills/MCP load per kind of repo)
  listCategories(): Promise<RepoCategory[]>
  saveCategories(categories: RepoCategory[]): Promise<void>
  /** Reassign a session's category; returns the claude terminal ids to restart. */
  setSessionCategory(sessionId: string, categoryId: string | null): Promise<string[]>
  /**
   * Replace a session's per-session environment variables; returns the ids of
   * its currently-running terminals (claude + shells) to restart so the new
   * environment takes effect. Empty/whitespace-only keys are dropped.
   */
  setSessionEnv(sessionId: string, env: Record<string, string>): Promise<string[]>
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
  /** The feature a worktree task session implements, or null when not tied to one. */
  featureForTask(sessionId: string): Promise<Feature | null>
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
  /** Create + publish the session's expansion branch now (so it shows on the remote). */
  ensureAutoExpandBranch(sessionId: string): Promise<void>
  /** Fired whenever a session's auto-expand run list changes (phase/status updates). */
  onAutoExpandRuns(cb: (sessionId: string, runs: AutoExpandRun[]) => void): Unsubscribe

  // conductor (app-level AI chat over all sessions; propose→confirm)
  /** The full Conductor conversation, oldest first. */
  listConductor(): Promise<ConductorMessage[]>
  /**
   * Send a user message; the assistant turn is pushed via onConductorChanged.
   * `tagSessionId` focuses the turn on a single session (its repo, its state),
   * or null/omitted for the cross-repo conductor. `images` are previously
   * attached files (conductorAttach*) the planner is told to Read.
   */
  sendConductor(
    text: string,
    tagSessionId?: string | null,
    images?: ConductorImage[]
  ): Promise<void>
  /**
   * Approve one proposed action on an assistant turn (runs it). For task-creating
   * actions, `options` carries the approval card's choices (base branch, model,
   * PR/auto-merge) and is persisted as that repo's defaults.
   */
  approveConductorAction(
    messageId: string,
    actionId: string,
    options?: ConductorTaskOptions
  ): Promise<void>
  /** Approve every non-destructive proposed action on an assistant turn. */
  approveAllConductorActions(messageId: string): Promise<void>
  /** Reject one proposed action without running it. */
  rejectConductorAction(messageId: string, actionId: string): Promise<void>
  /** Wipe the conversation. */
  clearConductor(): Promise<void>
  /** Fired whenever the conversation changes (new turn, action status). */
  onConductorChanged(cb: (messages: ConductorMessage[]) => void): Unsubscribe
  /** Save the clipboard image as a Conductor chat attachment; null when no image. */
  conductorAttachClipboardImage(): Promise<AttachmentInfo | null>
  /** Copy an image file (dropped from the OS) into the Conductor's attachments. */
  conductorAttachImageFile(srcPath: string): Promise<AttachmentInfo | null>
  /** Save raw image bytes (pasted/dropped content without a path). */
  conductorAttachImageData(name: string, bytes: Uint8Array): Promise<AttachmentInfo | null>
  /** Delete a not-yet-sent Conductor attachment (the preview's remove button). */
  conductorDeleteAttachment(fileName: string): Promise<void>
  /** Persisted per-repo defaults for the task-approval card, or null when none yet. */
  getConductorTaskDefaults(sessionId: string): Promise<ConductorTaskOptions | null>

  // agent & skill factory (generate skills/agents from connected MCP sources)
  /** Discover the connected MCP contexts the factory can mine (cached; refresh re-discovers). */
  listFactorySources(refresh?: boolean): Promise<FactorySource[]>
  /** The persisted factory registry (generated artifacts + backlog + lessons). */
  getFactoryState(): Promise<FactoryState>
  /** Scan runs, newest first (the persisted audit trail). */
  listFactoryRuns(): Promise<FactoryRun[]>
  /** Cancel the in-flight scan/author agent, if any (the run reports 'cancelled'). */
  cancelFactoryRun(): Promise<void>
  /** Drop finished runs from the audit trail (a running one is kept). */
  clearFactoryRuns(): Promise<void>
  /** Explore a source and propose skill/agent candidates (pushed via onFactoryRuns). */
  scanFactory(serverKey: string, guidance: string): Promise<void>
  /** Approve a candidate: author its file and write it to ~/.claude. */
  approveFactoryCandidate(runId: string, candidateId: string): Promise<void>
  /** Approve every still-proposed candidate on a run. */
  approveAllFactoryCandidates(runId: string): Promise<void>
  /** Reject one proposed candidate without authoring it. */
  rejectFactoryCandidate(runId: string, candidateId: string): Promise<void>
  /** Delete a generated artifact (removes its file too; an adopted artifact's file is kept). */
  deleteFactoryArtifact(id: string): Promise<void>
  /** Remove an artifact from the registry WITHOUT deleting its file. */
  unregisterFactoryArtifact(id: string): Promise<void>
  /** Read a registered artifact's file content (null when the file is missing). */
  readFactoryArtifact(id: string): Promise<string | null>
  /** Reveal a registered artifact's file in the OS file manager. */
  revealFactoryArtifact(id: string): Promise<void>
  /** Reconcile the registry against ~/.claude on disk (missing files + unregistered artifacts). */
  auditFactory(): Promise<FactoryAudit>
  /** Adopt a pre-existing on-disk skill/agent into the registry (file is left as-is). */
  adoptFactoryArtifact(kind: FactoryArtifactKind, name: string): Promise<void>
  /** Promote a backlog topic into a fresh scan seeded by it. */
  promoteFactoryTopic(id: string): Promise<void>
  /** Dismiss a backlog topic. */
  dismissFactoryTopic(id: string): Promise<void>
  /** Append a lesson-learned (fed into future scans/authors). */
  addFactoryLesson(text: string): Promise<void>
  /** Delete one lesson. */
  deleteFactoryLesson(id: string): Promise<void>
  /** Author + register the artifact for a self-growth suggestion (the only way one is built). */
  createFromSuggestion(id: string, kind?: FactoryArtifactKind): Promise<void>
  /** Dismiss a suggestion without building it. */
  dismissSuggestion(id: string): Promise<void>
  /** Current headless-lock state (a scan/author/judge/discovery is running). */
  getFactoryBusy(): Promise<boolean>
  /** Fired whenever the registry/backlog/lessons/suggestions change. */
  onFactoryChanged(cb: (state: FactoryState) => void): Unsubscribe
  /** Fired whenever the scan run list changes (phase/candidate updates). */
  onFactoryRuns(cb: (runs: FactoryRun[]) => void): Unsubscribe
  /** Fired when a new self-growth suggestion arrives (drives the badge/banner). */
  onFactorySuggestion(cb: (suggestion: FactorySuggestion) => void): Unsubscribe
  /** Fired when the headless lock flips — lets the UI disable actions that would no-op. */
  onFactoryBusy(cb: (busy: boolean) => void): Unsubscribe

  // gamification (XP / levels / achievements / streaks / quests)
  /** Current gamification snapshot (XP, level, streak, achievements, quests). */
  getGameState(): Promise<GameSnapshot>
  /** Fired on every gamification change (drives the XP HUD + Arcade pane). */
  onGamificationChanged(cb: (snapshot: GameSnapshot) => void): Unsubscribe
  /** Fired on a discrete level-up / achievement / quest / streak (drives the celebration). */
  onGamificationCelebrate(cb: (celebration: GameCelebration) => void): Unsubscribe

  // installed agents + external agent-factory registry (Factory → Agents tab)
  /** Installed agents (~/.claude/agents + session repos) merged with the external registry. */
  getInstalledAgents(): Promise<AgentsSnapshot>
  /** Force a re-scan/re-read now (also re-arms the file watchers). */
  refreshInstalledAgents(): Promise<AgentsSnapshot>
  /** Read an agent file the snapshot listed (null when unknown/unreadable). */
  readInstalledAgent(filePath: string): Promise<string | null>
  /** Reveal an agent file in the OS file manager. */
  revealInstalledAgent(filePath: string): Promise<void>
  /** Fired whenever the agents dirs / registry.json / .factory.lock change on disk. */
  onAgentsChanged(cb: (snapshot: AgentsSnapshot) => void): Unsubscribe

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
  // token efficiency (token-saving toolkit; global config lives in Settings)
  /** Live toolkit status for one session: effective config, overrides, drift, savings. */
  getTokenEfficiencyStatus(sessionId: string): Promise<TokenEfficiencyStatus | null>
  /** Persist the global config and re-materialize every session's repo. */
  saveTokenEfficiency(config: TokenEfficiencyConfig): Promise<void>
  /** Set/clear the override of the session's repo (shared with its worktree tasks). */
  setTokenEfficiencyRepoOverride(
    sessionId: string,
    override: TokenEfficiencyOverride | null
  ): Promise<void>
  /** Set/clear one session's own override. */
  setTokenEfficiencySessionOverride(
    sessionId: string,
    override: TokenEfficiencyOverride | null
  ): Promise<void>
  /** Regenerate the session's repo symbol map right now. */
  refreshRepoMap(sessionId: string): Promise<RepoMapInfo | null>
  /** Probe for external tools (rtk, node); refresh re-probes PATH. */
  detectEfficiencyTools(
    refresh?: boolean
  ): Promise<{ rtk: { found: boolean; path: string | null }; nodeFound: boolean }>

  // usage (token cost aggregated from Claude Code transcripts)
  getUsage(): Promise<UsageSnapshot>
  /**
   * Subscription plan usage limits (session/weekly utilization), the same data
   * Claude Code's `/usage` shows. Null when unavailable (no/expired token or a
   * failed request) — the widget then shows only its transcript-based figures.
   */
  getUsageLimits(): Promise<UsageLimits | null>

  /**
   * Prior Claude Code conversations for a repo folder (read from
   * `~/.claude/projects/<encoded>`), newest first, for the resume picker.
   * Returns [] when the folder has no transcripts.
   */
  listConversations(folder: string): Promise<ConversationSummary[]>

  // custom app background image
  /** Pick an image file and store it as the app background; returns its data URL (null = cancelled). */
  pickBackgroundImage(): Promise<string | null>
  /** The stored background image as a data URL, or null when none is set. */
  getBackgroundImage(): Promise<string | null>
  /** Remove the stored background image. */
  clearBackgroundImage(): Promise<void>

  // transcript export
  /**
   * Open a native save dialog (defaulting into the session's folder with
   * `fileName`) and write `content` there. Cancelling writes nothing.
   */
  exportTranscript(
    sessionId: string,
    fileName: string,
    content: string
  ): Promise<TranscriptExportResult>

  // misc
  openExternal(url: string): void
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): void
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<void>
}
