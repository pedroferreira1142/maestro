import { BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { existsSync, rmSync } from 'fs'
import {
  BranchListing,
  GitCommit,
  GitFileChange,
  GitFileDiff,
  GitStatus,
  MergeResult,
  PullRequestResult,
  RepoCategory,
  RepoCheckpoint,
  RestoreCheckpointResult,
  ReusableAction,
  RunActionResult,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  StartMode,
  TerminalConfig,
  TerminalInfo,
  TerminalKind,
  WatchdogAlert,
  WorktreeAutoCompleteEvent,
  WorktreeInfo,
  WorktreeTaskState
} from '../shared/types'
import type { CreateWorktreeOpts } from '../shared/api'
import { deleteAllAttachments } from './Attachments'
import { scanSkills } from './ClaudeEnv'
import { applyContextProfile } from './ContextProfile'
import { FsService } from './FsService'
import * as Git from './GitService'
import { Persistence } from './Persistence'
import { PtySession } from './PtySession'
import { ScrollbackStore, SCROLLBACK_MAX_BYTES } from './ScrollbackStore'
import { TokenEfficiencyService } from './TokenEfficiency'

/** How long to wait before typing a worktree task's initial prompt into claude. */
const INITIAL_PROMPT_DELAY_MS = 3500

/** Gap between typing the initial prompt and pressing Enter. Claude's TUI treats a
 *  multi-char chunk as a paste, so a trailing \r in the same write would insert a
 *  newline instead of submitting. */
const INITIAL_PROMPT_SUBMIT_DELAY_MS = 300

/** How long to wait for killed PTY processes to release their cwd (Windows file locks). */
const PTY_EXIT_WAIT_MS = 4000

/** How long to wait for a freshly spawned shell to finish booting before typing an action's command. */
const ACTION_SHELL_READY_MS = 1200

/**
 * Pause between typing a claude action's prompt and pressing Enter. Written in
 * one chunk, the trailing \r is treated as part of a paste (a newline in the
 * input box) instead of a submit.
 */
const CLAUDE_SUBMIT_DELAY_MS = 300

/**
 * How long a claude terminal must sit idle, continuously, before the next
 * queued prompt is dispatched to it. The countdown restarts on every idle
 * transition and the dispatch re-checks the status, so a terminal that wakes
 * up mid-countdown never receives a prompt.
 */
const QUEUE_IDLE_DELAY_MS = 3000

/**
 * How long a worktree task's claude must sit continuously idle before
 * auto-complete (auto-merge / auto-PR) fires. Much longer than the prompt-queue
 * delay: 'idle' only weakly implies 'finished', so we wait out brief pauses and
 * re-check on fire (still idle, real work present) before acting. The countdown
 * restarts on every idle transition.
 */
const AUTO_COMPLETE_IDLE_DELAY_MS = 90_000

/**
 * How often the stall/runaway watchdog re-checks each claude terminal's elapsed
 * time in its current status against the thresholds. Far finer than the
 * minute-scale thresholds, so a crossed badge/notification appears promptly.
 */
const WATCHDOG_TICK_MS = 5000

/**
 * Printed between replayed scrollback and the live process output on restore.
 * The leading reset guards against history ending mid-attribute; dim (SGR 2)
 * keeps the row visually quiet.
 */
const SCROLLBACK_DIVIDER =
  '\r\n\x1b[0m\x1b[2m── restored from previous session ──\x1b[0m\r\n\r\n'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** True while a pid is still alive (signal 0 probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but not ours; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Title for an auto/assisted PR — the task name, falling back to the branch. */
function prTitle(name: string, branch: string): string {
  return (name?.trim() || branch).slice(0, 120)
}

/** Body for a Maestro-opened PR: states its origin so reviewers have context. */
function prBody(name: string, branch: string, baseBranch: string): string {
  return (
    `Opened by Maestro from the parallel task **${name?.trim() || branch}**.\n\n` +
    `Merges \`${branch}\` into \`${baseBranch}\`.`
  )
}

/** Sidebar aggregate order — earliest wins across a session's terminals. */
const STATUS_PRIORITY: SessionStatus[] = [
  'needs-attention',
  'working',
  'done',
  'starting',
  'idle',
  'error',
  'exited'
]

export class SessionManager {
  /** Keyed by terminal id, across all sessions. */
  private ptys = new Map<string, PtySession>()

  /** Pending prompt-queue idle countdowns, keyed by session id. */
  private queueTimers = new Map<string, NodeJS.Timeout>()

  /** Worktree task session ids whose claude has been observed working at least
   *  once — the gate that stops auto-complete firing on the boot-time idle. */
  private worktreeWorked = new Set<string>()

  /** Pending auto-complete idle countdowns, keyed by worktree session id. */
  private autoCompleteTimers = new Map<string, NodeJS.Timeout>()

  /** Worktree session ids with an auto-complete action in flight (fires once). */
  private autoCompleteInFlight = new Set<string>()

  /** On-disk tail of each terminal's output, replayed on app restart. */
  private scrollback = new ScrollbackStore()

  /**
   * Per-claude-terminal watchdog episode bookkeeping, keyed by terminal id.
   * `notifiedSince` is the `statusSince` stamp of the episode we already fired a
   * notification for (so each episode notifies at most once); it resets when the
   * status — and thus the stamp — changes. `lastAlert` is the previous tick's
   * alert, used to push a `session:changed` only when a badge appears/clears.
   */
  private watchdog = new Map<string, { notifiedSince: number | null; lastAlert: WatchdogAlert | null }>()

  /** The watchdog interval; null until startWatchdog() runs. */
  private watchdogTimer: NodeJS.Timeout | null = null

  constructor(
    private persistence: Persistence,
    private fs: FsService,
    private tokenEff: TokenEfficiencyService,
    private getWin: () => BrowserWindow | null
  ) {}

  private get state() {
    return this.persistence.state
  }

  get categories(): RepoCategory[] {
    return this.state.categories
  }

  getConfig(id: string): SessionConfig | undefined {
    return this.state.sessions.find((s) => s.id === id)
  }

  private categoryOf(config: SessionConfig): RepoCategory | null {
    if (!config.categoryId) return null
    return this.state.categories.find((c) => c.id === config.categoryId) ?? null
  }

  /** Every MCP server name owned by any category — our materialization namespace. */
  private managedServerNames(): string[] {
    const names = new Set<string>()
    for (const c of this.state.categories) for (const s of c.mcpServers) names.add(s.name)
    return [...names]
  }

  /**
   * Write the session's category profile (skillOverrides + .mcp.json) into its
   * repo. Must run before any claude terminal spawns, since claude only reads
   * this config at startup. No-op for sessions without a claude terminal.
   */
  private applyProfile(config: SessionConfig): void {
    if (!config.terminals.some((t) => t.kind === 'claude')) return
    const skillNames = scanSkills().map((s) => s.name)
    applyContextProfile(
      config.folder,
      this.categoryOf(config),
      skillNames,
      this.managedServerNames()
    )
    // Token-efficiency hooks/repo map ride the same pre-spawn materialization
    // (claude reads hooks + env only at startup).
    this.tokenEff.apply(config)
  }

  private sessionOfTerminal(terminalId: string): SessionConfig | undefined {
    return this.state.sessions.find((s) => s.terminals.some((t) => t.id === terminalId))
  }

  list(): SessionInfo[] {
    return [...this.state.sessions]
      .sort((a, b) => a.order - b.order)
      .map((config) => this.toInfo(config))
  }

  create(folder: string, opts?: Partial<SessionConfig>): SessionInfo {
    const claudeTerminal: TerminalConfig = {
      id: randomUUID(),
      kind: 'claude',
      title: 'claude',
      order: 0,
      claudeArgs: [],
      startMode: 'continue'
    }
    const config: SessionConfig = {
      id: randomUUID(),
      name: opts?.name ?? basename(folder) ?? folder,
      folder,
      color: opts?.color ?? null,
      order: Math.max(0, ...this.state.sessions.map((s) => s.order + 1)),
      terminals: opts?.terminals ?? [claudeTerminal],
      activeTerminalId: claudeTerminal.id,
      expandedPaths: [],
      categoryId: opts?.categoryId ?? null
    }
    this.state.sessions.push(config)
    this.persistence.scheduleSave()
    this.applyProfile(config)
    for (const terminal of config.terminals) this.spawnTerminal(config, terminal, 'fresh')
    this.fs.start(config.id, config.folder, [])
    this.notifyChanged()
    return this.toInfo(config)
  }

  close(id: string): void {
    const config = this.getConfig(id)
    if (config) {
      for (const terminal of config.terminals) {
        this.ptys.get(terminal.id)?.kill()
        this.ptys.delete(terminal.id)
        this.scrollback.delete(terminal.id)
      }
    }
    this.fs.stop(id)
    this.clearQueueTimer(id)
    this.tokenEff.clearApplied(id)
    void deleteAllAttachments(id).catch(() => {})
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id)
    if (this.state.activeSessionId === id) this.state.activeSessionId = null
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  /** Git facts about a session's folder, for gating/prefilling the parallel-task UI. */
  async getWorktreeInfo(sessionId: string): Promise<WorktreeInfo> {
    const config = this.getConfig(sessionId)
    if (!config) return { isRepo: false, repoRoot: null, branch: null }
    return Git.worktreeInfo(config.folder)
  }

  /** Working-tree + branch state of a session's repo (for the Git panel). */
  async getGitStatus(sessionId: string): Promise<GitStatus> {
    const config = this.getConfig(sessionId)
    if (!config) {
      return {
        isRepo: false,
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        remoteUrl: null
      }
    }
    return Git.gitStatus(config.folder)
  }

  /** Recent commit history of a session's repo, newest first. */
  async getGitLog(sessionId: string, limit?: number): Promise<GitCommit[]> {
    const config = this.getConfig(sessionId)
    if (!config) return []
    return Git.gitLog(config.folder, limit)
  }

  /** Changed files (staged, unstaged, untracked) in a session's working tree. */
  async getGitChangedFiles(sessionId: string): Promise<GitFileChange[]> {
    const config = this.getConfig(sessionId)
    if (!config) return []
    return Git.gitChangedFiles(config.folder)
  }

  /** Unified diff of one file's working-tree state against HEAD (for the diff tab). */
  async getGitFileDiff(sessionId: string, path: string): Promise<GitFileDiff> {
    const config = this.getConfig(sessionId)
    if (!config) return { diff: '', binary: false, truncated: false }
    return Git.gitFileDiff(config.folder, path)
  }

  /** Local branches + default branch of a session's repo (base-branch picker). */
  async listBranches(sessionId: string): Promise<BranchListing> {
    const config = this.getConfig(sessionId)
    if (!config) return { branches: [], current: null, defaultBranch: null }
    return Git.listBranches(config.folder)
  }

  /**
   * Initialize a git repository in a session's folder (so a non-repo session can
   * host parallel tasks). Returns the resulting git facts; throws git's message
   * on failure (e.g. no git identity configured for the initial commit).
   */
  async initRepo(sessionId: string): Promise<WorktreeInfo> {
    const config = this.getConfig(sessionId)
    if (!config) throw new Error('Unknown session')
    const res = await Git.gitInit(config.folder)
    if (res.code !== 0) throw new Error(res.output || 'git init failed')
    this.notifyChanged()
    return Git.worktreeInfo(config.folder)
  }

  /**
   * Snapshot a session's working tree into a labeled checkpoint (the safety
   * net taken before a risky prompt). Throws git's message on failure.
   */
  async createCheckpoint(sessionId: string, label: string): Promise<RepoCheckpoint> {
    const config = this.getConfig(sessionId)
    if (!config) throw new Error('Unknown session')
    return Git.createCheckpoint(config.folder, label)
  }

  /** Recent checkpoints for a session's repo, newest first. */
  async listCheckpoints(sessionId: string): Promise<RepoCheckpoint[]> {
    const config = this.getConfig(sessionId)
    if (!config) return []
    return Git.listCheckpoints(config.folder)
  }

  /** Restore a session's working tree back to a checkpoint (guarded, reversible). */
  async restoreCheckpoint(sessionId: string, id: string): Promise<RestoreCheckpointResult> {
    const config = this.getConfig(sessionId)
    if (!config) return { ok: false, output: 'Unknown session', safety: null }
    return Git.restoreCheckpoint(config.folder, id)
  }

  /** Delete one checkpoint from a session's repo. */
  async deleteCheckpoint(sessionId: string, id: string): Promise<void> {
    const config = this.getConfig(sessionId)
    if (!config) throw new Error('Unknown session')
    return Git.deleteCheckpoint(config.folder, id)
  }

  /**
   * Spin off a parallel task: create a new git worktree (on a fresh branch) of
   * the parent session's repo, register it as a linked session, and launch
   * claude in it. If the branch (and possibly its worktree) already exists —
   * e.g. a task whose session was lost — it is adopted instead of failing.
   * Throws (with git's message) if the folder isn't a repo or the worktree
   * can't be created — the renderer surfaces that to the user.
   */
  async createWorktreeSession(
    parentSessionId: string,
    opts: CreateWorktreeOpts
  ): Promise<SessionInfo> {
    const parent = this.getConfig(parentSessionId)
    if (!parent) throw new Error('Unknown parent session')

    const info = await Git.worktreeInfo(parent.folder)
    if (!info.isRepo || !info.repoRoot) {
      throw new Error('This session’s folder is not a git repository.')
    }
    const repoRoot = info.repoRoot
    const baseBranch = opts.baseBranch || info.branch || 'HEAD'
    const branch = opts.branch.trim()
    if (!branch) throw new Error('A branch name is required.')

    const worktreePath = Git.defaultWorktreePath(repoRoot, branch)
    await Git.pruneWorktrees(repoRoot) // drop stale registrations first
    const registered = (await Git.listWorktreePaths(repoRoot)).includes(
      worktreePath.replace(/\\/g, '/')
    )
    let freshlyCreated = false
    if (registered && existsSync(worktreePath)) {
      // Adopt: worktree already live (a task whose session entry was lost).
    } else if (await Git.branchExists(repoRoot, branch)) {
      // Branch survives from an earlier task — re-attach a worktree to it.
      await Git.addWorktreeForBranch(repoRoot, worktreePath, branch)
      freshlyCreated = true
    } else {
      await Git.addWorktree(repoRoot, worktreePath, branch, baseBranch)
      freshlyCreated = true
    }

    // A worktree is a clean checkout with no gitignored local config; copy
    // .env-style files (per .worktreeinclude) so the task's claude can run the app.
    if (freshlyCreated) {
      try {
        Git.copyWorktreeIncludes(repoRoot, worktreePath)
      } catch (err) {
        console.error('copyWorktreeIncludes failed', err)
      }
    }

    const claudeTerminal: TerminalConfig = {
      id: randomUUID(),
      kind: 'claude',
      title: 'claude',
      order: 0,
      // A model picked for the task pins its claude via --model; absent = CLI default.
      claudeArgs: opts.model ? ['--model', opts.model] : [],
      startMode: 'fresh'
    }
    const config: SessionConfig = {
      id: randomUUID(),
      name: opts.name || branch,
      folder: worktreePath,
      color: parent.color,
      order: Math.max(0, ...this.state.sessions.map((s) => s.order + 1)),
      terminals: [claudeTerminal],
      activeTerminalId: claudeTerminal.id,
      expandedPaths: [],
      categoryId: parent.categoryId ?? null,
      worktree: {
        parentSessionId,
        branch,
        baseBranch,
        baseFolder: repoRoot,
        // Default to direct merge; only persist a PR/auto choice when set, so
        // existing tasks and the common case stay exactly as before.
        ...(opts.completion && opts.completion !== 'merge' ? { completion: opts.completion } : {}),
        ...(opts.autoComplete ? { autoComplete: true } : {})
      }
    }
    this.state.sessions.push(config)
    this.persistence.scheduleSave()
    this.applyProfile(config)
    this.spawnTerminal(config, claudeTerminal, 'fresh')
    this.fs.start(config.id, config.folder, [])

    const prompt = opts.initialPrompt?.trim()
    if (prompt) {
      // Type the first prompt once claude has booted, then submit it so the task
      // starts working immediately. Best-effort; skipped if the pty died.
      setTimeout(() => {
        const pty = this.ptys.get(claudeTerminal.id)
        if (!pty) return
        pty.write(prompt)
        setTimeout(
          () => this.ptys.get(claudeTerminal.id)?.write('\r'),
          INITIAL_PROMPT_SUBMIT_DELAY_MS
        )
      }, INITIAL_PROMPT_DELAY_MS)
    }

    this.notifyChanged()
    return this.toInfo(config)
  }

  /** Live git facts about a worktree task (uncommitted files, commits ahead). */
  async getWorktreeTaskState(sessionId: string): Promise<WorktreeTaskState> {
    const config = this.getConfig(sessionId)
    if (!config?.worktree) {
      return { folderExists: false, dirty: -1, ahead: -1, conflictFiles: null }
    }
    const folderExists = existsSync(config.folder)
    const dirty = folderExists ? await Git.dirtyCount(config.folder) : null
    const ahead = await Git.aheadCount(
      config.worktree.baseFolder,
      config.worktree.baseBranch,
      config.worktree.branch
    )
    // Predict merge conflicts only when there are commits to merge. merge-tree
    // works entirely in-memory — no working tree, index, or HEAD is touched.
    let conflictFiles: string[] | null = null
    if (ahead !== null && ahead > 0) {
      try {
        conflictFiles = await Git.mergeConflictFiles(
          config.worktree.baseFolder,
          config.worktree.branch,
          config.worktree.baseBranch
        )
      } catch {
        conflictFiles = null // git missing/broken → 'unknown', never an error
      }
    } else if (ahead === 0) {
      conflictFiles = [] // nothing to merge, trivially conflict-free
    }
    return { folderExists, dirty: dirty ?? -1, ahead: ahead ?? -1, conflictFiles }
  }

  /**
   * Merge a worktree task's branch back into its base branch (runs in the base
   * repo). Claude never commits on its own schedule, so with `commitFirst` any
   * uncommitted work in the worktree is committed to the task branch before
   * merging — without it, only already-committed work merges. A branch with no
   * commits beyond base returns nothingToMerge instead of a misleading success.
   */
  async mergeWorktree(sessionId: string, commitFirst: boolean): Promise<MergeResult> {
    const config = this.getConfig(sessionId)
    if (!config?.worktree) {
      return { ok: false, conflict: false, output: 'Not a worktree task session.' }
    }
    const { baseFolder, branch, baseBranch } = config.worktree
    if (!existsSync(config.folder)) {
      return {
        ok: false,
        conflict: false,
        output: 'The worktree folder no longer exists — remove this task instead.'
      }
    }
    if (!(await Git.branchExists(baseFolder, branch))) {
      return {
        ok: false,
        conflict: false,
        output:
          `The task branch "${branch}" no longer exists in the repo.\n\n` +
          `If claude made its own worktree (e.g. "claude --worktree" or the EnterWorktree tool), ` +
          `its commits are on a different branch Maestro doesn't track. Commit your work on ` +
          `"${branch}" inside this task's folder, or remove the task.`
      }
    }

    let autoCommitted = false
    if (commitFirst && ((await Git.dirtyCount(config.folder)) ?? 0) > 0) {
      const commit = await Git.commitAll(config.folder, `${config.name} (Maestro task)`)
      if (commit.code !== 0) {
        return { ok: false, conflict: false, output: `Commit failed:\n${commit.output}` }
      }
      autoCommitted = true
    }

    const ahead = await Git.aheadCount(baseFolder, baseBranch, branch)
    if (ahead === 0) {
      return {
        ok: false,
        conflict: false,
        nothingToMerge: true,
        autoCommitted,
        output: `Branch "${branch}" has no commits beyond "${baseBranch}" — nothing to merge.`
      }
    }

    const result = await Git.mergeBranch(baseFolder, branch, baseBranch)
    if (!result.ok) return { ...result, autoCommitted }
    return { ...(await this.pushAfterMerge(result, baseFolder, baseBranch)), autoCommitted }
  }

  /** True if `branch` is the dedicated expansion branch of any auto-expand config. */
  private isAutoExpandBranch(branch: string): boolean {
    return this.state.sessions.some((s) => s.autoExpand?.branch === branch)
  }

  /**
   * Best-effort push of the base branch after a successful merge, so the merge
   * shows up on the remote (GitHub) and not just locally. A push failure never
   * fails the merge — it's reported via `pushed:false` + appended output.
   *
   * Ordinary branches are only pushed when they already have an upstream
   * (Maestro never publishes branches the user hasn't pushed). An auto-expansion
   * branch is the exception: the user opted into "commit to the expansion branch
   * and push to GitHub", so if it has no upstream yet we publish it (push -u).
   */
  private async pushAfterMerge(
    merge: MergeResult,
    baseFolder: string,
    baseBranch: string
  ): Promise<MergeResult> {
    let push = await Git.pushBranch(baseFolder, baseBranch)
    if (!push && this.isAutoExpandBranch(baseBranch)) {
      // No upstream, but this is an expansion branch — publish it to the remote.
      push = await Git.publishBranch(baseFolder, baseBranch)
    }
    if (!push) return merge // no upstream / no remote — nothing to push to
    if (push.ok) return { ...merge, pushed: true }
    return {
      ...merge,
      pushed: false,
      output: `${merge.output}\n\nPush to upstream failed:\n${push.output}`.trim()
    }
  }

  /**
   * Start the task's merge FOR REAL and leave conflict markers in the base
   * working tree, so the parent session's claude (or the user) can resolve and
   * commit. Used after mergeWorktree predicted conflicts and the user opted
   * into assisted resolution.
   */
  async startConflictedMerge(sessionId: string): Promise<MergeResult> {
    const config = this.getConfig(sessionId)
    if (!config?.worktree) {
      return { ok: false, conflict: false, output: 'Not a worktree task session.' }
    }
    const { baseFolder, branch, baseBranch } = config.worktree
    if (!(await Git.branchExists(baseFolder, branch))) {
      return { ok: false, conflict: false, output: `Branch "${branch}" no longer exists.` }
    }
    const result = await Git.startMergeLeaveConflicts(baseFolder, branch, baseBranch)
    if (!result.ok) return result
    return this.pushAfterMerge(result, baseFolder, baseBranch)
  }

  /**
   * Open a pull request for a worktree task's branch against its base (the PR
   * alternative to mergeWorktree). Like merge, `commitFirst` first commits any
   * uncommitted task work to the branch — Claude doesn't commit on its own — so
   * the PR isn't missing changes. Pushes the branch, then `gh pr create`.
   */
  async createWorktreePr(sessionId: string, commitFirst: boolean): Promise<PullRequestResult> {
    const config = this.getConfig(sessionId)
    if (!config?.worktree) {
      return { ok: false, output: 'Not a worktree task session.' }
    }
    const { baseFolder, branch, baseBranch } = config.worktree
    if (!existsSync(config.folder)) {
      return { ok: false, output: 'The worktree folder no longer exists — remove this task instead.' }
    }
    if (!(await Git.branchExists(baseFolder, branch))) {
      return {
        ok: false,
        output:
          `The task branch "${branch}" no longer exists in the repo.\n\n` +
          `Commit your work on "${branch}" inside this task's folder, or remove the task.`
      }
    }

    let autoCommitted = false
    if (commitFirst && ((await Git.dirtyCount(config.folder)) ?? 0) > 0) {
      const commit = await Git.commitAll(config.folder, `${config.name} (Maestro task)`)
      if (commit.code !== 0) {
        return { ok: false, output: `Commit failed:\n${commit.output}` }
      }
      autoCommitted = true
    }

    const ahead = await Git.aheadCount(baseFolder, baseBranch, branch)
    if (ahead === 0) {
      return {
        ok: false,
        nothingToMerge: true,
        autoCommitted,
        output: `Branch "${branch}" has no commits beyond "${baseBranch}" — nothing to open a PR for.`
      }
    }

    // The PR is pushed/created from the task's own worktree folder, where the
    // task branch is checked out (the base repo has baseBranch checked out).
    const title = prTitle(config.name, branch)
    const body = prBody(config.name, branch, baseBranch)
    const result = await Git.createPullRequest(config.folder, branch, baseBranch, title, body)
    return { ...result, autoCommitted }
  }

  // ---------- auto-complete (auto-merge / auto-PR when claude finishes) --------

  /**
   * (Re)start the auto-complete idle countdown for a worktree task whose claude
   * just went idle. Only arms once the task's claude has actually worked (so the
   * boot-time idle never counts), and never while a prompt queue is still
   * draining or an action is already in flight / done. The fire handler
   * re-checks everything, so a terminal that wakes mid-countdown is safe.
   */
  private scheduleAutoComplete(sessionId: string): void {
    const config = this.getConfig(sessionId)
    const wt = config?.worktree
    if (!config || !wt?.autoComplete || wt.autoCompletedAs) return
    if (!this.worktreeWorked.has(sessionId)) return // claude hasn't worked yet
    if (this.autoCompleteInFlight.has(sessionId)) return
    if (config.promptQueue?.length) return // let the queue finish feeding claude first
    const existing = this.autoCompleteTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    this.autoCompleteTimers.set(
      sessionId,
      setTimeout(() => {
        this.autoCompleteTimers.delete(sessionId)
        void this.fireAutoComplete(sessionId)
      }, AUTO_COMPLETE_IDLE_DELAY_MS)
    )
  }

  private clearAutoCompleteTimer(sessionId: string): void {
    const timer = this.autoCompleteTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.autoCompleteTimers.delete(sessionId)
  }

  /**
   * Run a task's chosen completion automatically. Re-checks the gates that may
   * have changed during the countdown (still a worktree task, claude alive and
   * idle, queue empty, real work present, not already completed), commits
   * pending work, then merges or opens a PR per `completion`. Marks the task
   * auto-completed so it never fires twice, and broadcasts the outcome.
   */
  private async fireAutoComplete(sessionId: string): Promise<void> {
    const config = this.getConfig(sessionId)
    const wt = config?.worktree
    if (!config || !wt?.autoComplete || wt.autoCompletedAs) return
    if (this.autoCompleteInFlight.has(sessionId)) return
    if (config.promptQueue?.length) return

    const terminal = this.claudeTargetTerminal(config)
    const pty = terminal ? this.ptys.get(terminal.id) : null
    if (!pty?.alive || pty.detector.current !== 'idle') return // woke up; wait for next idle

    // Only act when there's actually work to land (committed or uncommitted).
    const dirty = (await Git.dirtyCount(config.folder)) ?? 0
    const ahead = (await Git.aheadCount(wt.baseFolder, wt.baseBranch, wt.branch)) ?? 0
    if (dirty === 0 && ahead === 0) return // nothing yet — try again on the next idle

    this.autoCompleteInFlight.add(sessionId)
    const kind = wt.completion ?? 'merge'
    try {
      const event: WorktreeAutoCompleteEvent = {
        kind,
        name: config.name,
        branch: wt.branch,
        baseBranch: wt.baseBranch,
        ok: false,
        output: ''
      }
      if (kind === 'pr') {
        const pr = await this.createWorktreePr(sessionId, true)
        event.ok = pr.ok
        event.url = pr.url
        event.output = pr.output
      } else {
        // GUARD: auto-merge is skipped — never attempted — when the base tree
        // is dirty or the merge would conflict; the user gets a visible warning
        // and merges manually. (mergeWorktree re-checks both, but checking here
        // produces an explicit "skipped" message instead of a generic failure.)
        const baseDirty = (await Git.dirtyCount(wt.baseFolder)) ?? 0
        const conflicts =
          baseDirty > 0
            ? null
            : await Git.mergeConflictFiles(wt.baseFolder, wt.branch, wt.baseBranch).catch(
                () => null
              )
        if (baseDirty > 0) {
          event.ok = false
          event.output =
            `Auto-merge skipped: the base working tree (${wt.baseFolder}) has ` +
            `${baseDirty} uncommitted file(s). Commit or stash them, then merge ` +
            `the task from the sidebar.`
        } else if (conflicts && conflicts.length > 0) {
          event.ok = false
          event.conflict = true
          event.output =
            `Auto-merge skipped: merging "${wt.branch}" into "${wt.baseBranch}" would ` +
            `conflict in:\n` +
            conflicts.map((f) => `  • ${f}`).join('\n') +
            `\n\nThe base repo was left untouched — merge from the sidebar to resolve.`
        } else {
          const merge = await this.mergeWorktree(sessionId, true)
          event.ok = merge.ok
          event.conflict = merge.conflict
          // Auto-merge never resolves conflicts unattended — leave that to the user.
          event.output = merge.output
        }
      }

      // Mark it done so it fires at most once, even if the action failed: a
      // failed auto-merge (e.g. conflict) shouldn't silently retry every idle.
      const fresh = this.getConfig(sessionId)
      if (fresh?.worktree) {
        fresh.worktree.autoCompletedAs = kind
        this.persistence.scheduleSave()
      }
      this.getWin()?.webContents.send('worktree:autocompleted', sessionId, event)
      this.notifyChanged()
    } catch (err) {
      console.error('auto-complete failed', err)
    } finally {
      this.autoCompleteInFlight.delete(sessionId)
    }
  }

  /**
   * Close a worktree task, remove its git worktree, and optionally delete its
   * branch. Kills the task's terminals first and WAITS for them to exit —
   * Windows can't delete a folder that's still some process's cwd. Tolerates
   * half-removed worktrees (missing folder, stale registration) so a broken
   * task can always be cleaned up from the UI.
   */
  async removeWorktree(sessionId: string, deleteBranch: boolean): Promise<void> {
    const config = this.getConfig(sessionId)
    if (!config?.worktree) return
    const { baseFolder, branch } = config.worktree

    const pids: number[] = []
    for (const terminal of config.terminals) {
      const pty = this.ptys.get(terminal.id)
      if (pty?.pid) pids.push(pty.pid)
      pty?.kill()
      this.ptys.delete(terminal.id)
      this.scrollback.delete(terminal.id)
    }
    this.fs.stop(sessionId)

    const deadline = Date.now() + PTY_EXIT_WAIT_MS
    while (pids.some(pidAlive) && Date.now() < deadline) await sleep(150)

    try {
      await Git.pruneWorktrees(baseFolder)
      const registered = (await Git.listWorktreePaths(baseFolder)).includes(
        config.folder.replace(/\\/g, '/')
      )
      if (registered) {
        let removed = false
        try {
          await Git.removeWorktree(baseFolder, config.folder, true)
          removed = true
        } catch {
          await sleep(1000) // file locks can outlive the process briefly
          try {
            await Git.removeWorktree(baseFolder, config.folder, true)
            removed = true
          } catch {
            // fall through to the manual path below
          }
        }
        if (!removed) {
          // Damaged worktree (e.g. "is not a working tree": registration and
          // folder out of sync from an earlier failed removal). Git can't
          // remove what it half-forgot — delete manually, then prune the
          // dangling registration.
          if (existsSync(config.folder)) {
            rmSync(config.folder, { recursive: true, force: true })
          }
          await Git.pruneWorktrees(baseFolder)
        }
      } else if (existsSync(config.folder)) {
        // Orphaned leftover of a failed removal — git no longer tracks it.
        rmSync(config.folder, { recursive: true, force: true })
      }
      if (deleteBranch) await Git.deleteBranch(baseFolder, branch, true)
    } catch (err) {
      console.error('removeWorktree (git) failed', err)
      throw new Error(
        `Couldn't delete the worktree folder — something may still be using it ` +
          `(an editor or terminal in that folder?).\n\n${(err as Error).message}`
      )
    }

    this.clearQueueTimer(sessionId)
    this.clearAutoCompleteTimer(sessionId)
    this.tokenEff.clearApplied(sessionId)
    this.worktreeWorked.delete(sessionId)
    this.autoCompleteInFlight.delete(sessionId)
    this.state.sessions = this.state.sessions.filter((s) => s.id !== sessionId)
    if (this.state.activeSessionId === sessionId) this.state.activeSessionId = null
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  addTerminal(sessionId: string, kind: TerminalKind): TerminalInfo | null {
    const config = this.getConfig(sessionId)
    if (!config) return null
    const terminal: TerminalConfig = {
      id: randomUUID(),
      kind,
      title: kind,
      order: Math.max(0, ...config.terminals.map((t) => t.order + 1)),
      ...(kind === 'claude' ? { claudeArgs: [], startMode: 'continue' } : {})
    }
    config.terminals.push(terminal)
    config.activeTerminalId = terminal.id
    this.persistence.scheduleSave()
    this.spawnTerminal(config, terminal, 'fresh')
    this.notifyChanged()
    return this.terminalInfo(terminal)
  }

  closeTerminal(sessionId: string, terminalId: string): void {
    const config = this.getConfig(sessionId)
    if (!config) return
    this.ptys.get(terminalId)?.kill()
    this.ptys.delete(terminalId)
    this.scrollback.delete(terminalId)
    config.terminals = config.terminals.filter((t) => t.id !== terminalId)
    if (config.activeTerminalId === terminalId) {
      config.activeTerminalId = config.terminals[0]?.id ?? null
    }
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  restartTerminal(terminalId: string, mode: 'fresh' | 'resume'): void {
    const config = this.sessionOfTerminal(terminalId)
    if (!config) return
    const terminal = config.terminals.find((t) => t.id === terminalId)
    if (!terminal) return
    this.ptys.get(terminalId)?.kill()
    if (terminal.kind === 'claude') this.applyProfile(config)
    // On resume, replay the persisted scrollback above the divider so visible
    // history survives the respawn (same seeding restoreAll does on launch).
    const history = mode === 'resume' ? this.scrollback.load(terminalId) : ''
    this.spawnTerminal(
      config,
      terminal,
      mode === 'resume' ? 'continue' : 'fresh',
      history || undefined
    )
    this.notifyChanged()
  }

  /**
   * Reassign a session's repo category, re-materialize its profile, and report
   * which claude terminals must be restarted for the new context to take effect
   * (skills/MCP are only read at claude startup). The renderer drives the
   * restart so xterm remounts cleanly.
   */
  setSessionCategory(sessionId: string, categoryId: string | null): string[] {
    const config = this.getConfig(sessionId)
    if (!config) return []
    config.categoryId = categoryId
    this.persistence.scheduleSave()
    this.applyProfile(config)
    this.notifyChanged()
    return config.terminals.filter((t) => t.kind === 'claude').map((t) => t.id)
  }

  /**
   * Replace a session's per-session environment map and report which of its
   * terminals must be restarted for the new environment to take effect — env is
   * only read by a process at spawn time. Unlike category, env reaches every
   * terminal (claude and shells alike), so all *currently-running* terminals are
   * reported; terminals that aren't running are left alone (not force-started).
   * Empty/whitespace-only keys are dropped, and an empty map clears the field.
   */
  setSessionEnv(sessionId: string, env: Record<string, string>): string[] {
    const config = this.getConfig(sessionId)
    if (!config) return []
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      const key = k.trim()
      if (key) cleaned[key] = v
    }
    config.env = Object.keys(cleaned).length > 0 ? cleaned : undefined
    this.persistence.scheduleSave()
    this.notifyChanged()
    return config.terminals.filter((t) => this.ptys.get(t.id)?.alive).map((t) => t.id)
  }

  /**
   * Replace the category definitions. Changes take effect for a session the
   * next time its claude terminal starts or is restarted (we don't force-restart
   * running sessions here).
   */
  saveCategories(categories: RepoCategory[]): void {
    this.state.categories = categories
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  get actions(): ReusableAction[] {
    return this.state.actions
  }

  /** Replace the saved reusable actions (the renderer edits the full list). */
  saveActions(actions: ReusableAction[]): void {
    this.state.actions = actions
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  /**
   * Run a reusable action in a session. Shell actions type their command into
   * the action's own terminal tab, creating or re-spawning that tab first when
   * needed — each action owns at most one tab per session (matched by
   * `actionId`), so re-triggering reuses the same terminal instead of piling
   * up tabs. Claude actions instead send their prompt to the session's
   * existing claude conversation.
   */
  runAction(sessionId: string, actionId: string): RunActionResult | null {
    const config = this.getConfig(sessionId)
    const action = this.state.actions.find((a) => a.id === actionId)
    const command = action?.command.trim()
    if (!config || !action || !command) return null

    if (action.shell === 'claude') return this.runClaudeAction(config, command)

    let terminal = config.terminals.find((t) => t.actionId === action.id)
    let respawned = false
    if (terminal) {
      terminal.title = action.name // follow action renames
      const pty = this.ptys.get(terminal.id)
      if (terminal.kind !== action.shell) {
        // The action's shell changed since this tab was created — replace it.
        pty?.kill()
        terminal.kind = action.shell
        this.spawnTerminal(config, terminal, 'fresh')
        respawned = true
      } else if (!pty?.alive) {
        this.spawnTerminal(config, terminal, 'fresh')
        respawned = true
      }
    } else {
      terminal = {
        id: randomUUID(),
        kind: action.shell,
        title: action.name,
        order: Math.max(0, ...config.terminals.map((t) => t.order + 1)),
        actionId: action.id
      }
      config.terminals.push(terminal)
      this.spawnTerminal(config, terminal, 'fresh')
      respawned = true
    }
    config.activeTerminalId = terminal.id
    this.persistence.scheduleSave()

    // \r submits the command; a fresh shell gets a beat to finish its startup
    // (PTY input is buffered, but init scripts can redraw over early echo).
    const terminalId = terminal.id
    const delay = respawned ? ACTION_SHELL_READY_MS : 0
    setTimeout(() => this.ptys.get(terminalId)?.write(command + '\r'), delay)

    this.notifyChanged()
    return { terminalId, respawned }
  }

  /**
   * Run a claude action: type the prompt into the session's claude
   * conversation and submit it. Prefers the focused claude tab, falls back to
   * the first one, and (re)spawns claude with `continue` when none is alive —
   * the prompt usually concerns the session's ongoing work, so it goes to the
   * existing conversation rather than a dedicated per-action tab.
   */
  private runClaudeAction(config: SessionConfig, prompt: string): RunActionResult {
    let terminal = this.claudeTargetTerminal(config)
    let respawned = false
    if (!terminal) {
      terminal = {
        id: randomUUID(),
        kind: 'claude',
        title: 'claude',
        order: Math.max(0, ...config.terminals.map((t) => t.order + 1)),
        claudeArgs: [],
        startMode: 'continue'
      }
      config.terminals.push(terminal)
      this.applyProfile(config)
      this.spawnTerminal(config, terminal, 'continue')
      respawned = true
    } else if (!this.ptys.get(terminal.id)?.alive) {
      this.applyProfile(config)
      this.spawnTerminal(config, terminal, 'continue')
      respawned = true
    }
    config.activeTerminalId = terminal.id
    this.persistence.scheduleSave()

    // Type the prompt once claude is ready, then submit. The \r is written
    // separately (see CLAUDE_SUBMIT_DELAY_MS) so claude reads it as Enter.
    const terminalId = terminal.id
    setTimeout(
      () => {
        const pty = this.ptys.get(terminalId)
        if (!pty?.alive) return
        pty.write(prompt)
        setTimeout(() => this.ptys.get(terminalId)?.write('\r'), CLAUDE_SUBMIT_DELAY_MS)
      },
      respawned ? INITIAL_PROMPT_DELAY_MS : 0
    )

    this.notifyChanged()
    return { terminalId, respawned }
  }

  /** Where prompts for "the session's claude" go: the active claude tab, else the first one. */
  private claudeTargetTerminal(config: SessionConfig): TerminalConfig | undefined {
    return (
      config.terminals.find((t) => t.id === config.activeTerminalId && t.kind === 'claude') ??
      config.terminals.filter((t) => t.kind === 'claude').sort((a, b) => a.order - b.order)[0]
    )
  }

  /** Append a prompt to a session's queue; it dispatches when claude next sits idle. */
  queueAdd(sessionId: string, text: string): void {
    const config = this.getConfig(sessionId)
    const trimmed = text.trim()
    if (!config || !trimmed) return
    config.promptQueue = [...(config.promptQueue ?? []), { id: randomUUID(), text: trimmed }]
    this.persistence.scheduleSave()
    this.notifyChanged()
    // The terminal may already be sitting idle, with no further transition
    // coming to kick the queue — start the idle countdown now.
    this.scheduleQueueDispatch(sessionId)
  }

  queueRemove(sessionId: string, itemId: string): void {
    const config = this.getConfig(sessionId)
    if (!config?.promptQueue) return
    config.promptQueue = config.promptQueue.filter((q) => q.id !== itemId)
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  /** Move a queued prompt one slot up (-1) or down (+1); dispatch follows display order. */
  queueMove(sessionId: string, itemId: string, delta: -1 | 1): void {
    const config = this.getConfig(sessionId)
    const queue = config?.promptQueue
    if (!queue) return
    const idx = queue.findIndex((q) => q.id === itemId)
    const target = idx + delta
    if (idx < 0 || target < 0 || target >= queue.length) return
    ;[queue[idx], queue[target]] = [queue[target], queue[idx]]
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  /** (Re)start a session's prompt-queue idle countdown. */
  private scheduleQueueDispatch(sessionId: string): void {
    this.clearQueueTimer(sessionId)
    const config = this.getConfig(sessionId)
    if (!config?.promptQueue?.length) return
    this.queueTimers.set(
      sessionId,
      setTimeout(() => {
        this.queueTimers.delete(sessionId)
        this.dispatchQueuedPrompt(sessionId)
      }, QUEUE_IDLE_DELAY_MS)
    )
  }

  private clearQueueTimer(sessionId: string): void {
    const timer = this.queueTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.queueTimers.delete(sessionId)
  }

  /**
   * Send the oldest queued prompt to the session's claude — but only if that
   * terminal is alive and still idle when the countdown fires. Anything else
   * (working, needs-attention, starting, exited, error, no claude tab) leaves
   * the queue untouched; the next idle transition restarts the countdown.
   */
  private dispatchQueuedPrompt(sessionId: string): void {
    const config = this.getConfig(sessionId)
    const next = config?.promptQueue?.[0]
    if (!config || !next) return
    const terminal = this.claudeTargetTerminal(config)
    if (!terminal) return // session has no claude terminal — never dispatch
    const pty = this.ptys.get(terminal.id)
    const settled = pty?.detector.current === 'done' || pty?.detector.current === 'idle'
    if (!pty?.alive || !settled) return
    config.promptQueue = config.promptQueue!.slice(1)
    this.persistence.scheduleSave()
    // Same two-step write as runClaudeAction: a \r in the prompt's chunk would
    // paste a newline into claude's input box instead of submitting.
    pty.write(next.text)
    setTimeout(() => this.ptys.get(terminal.id)?.write('\r'), CLAUDE_SUBMIT_DELAY_MS)
    this.notifyChanged()
  }

  updateTerminal(terminalId: string, patch: Partial<TerminalConfig>): void {
    const config = this.sessionOfTerminal(terminalId)
    if (!config) return
    const terminal = config.terminals.find((t) => t.id === terminalId)
    if (!terminal) return
    // id/kind are immutable
    const { id: _id, kind: _kind, ...rest } = patch
    Object.assign(terminal, rest)
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  update(id: string, patch: Partial<SessionConfig>): void {
    const config = this.getConfig(id)
    if (!config) return
    // id/folder/terminals are managed separately
    const { id: _id, folder: _folder, terminals: _terminals, ...rest } = patch
    Object.assign(config, rest)
    this.persistence.scheduleSave()
    this.notifyChanged()
  }

  setActive(id: string | null): void {
    this.state.activeSessionId = id
    this.persistence.scheduleSave()
  }

  setActiveTerminal(sessionId: string, terminalId: string): void {
    const config = this.getConfig(sessionId)
    if (!config || !config.terminals.some((t) => t.id === terminalId)) return
    config.activeTerminalId = terminalId
    this.persistence.scheduleSave()
  }

  write(terminalId: string, data: string): void {
    this.ptys.get(terminalId)?.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.ptys.get(terminalId)?.resize(cols, rows)
  }

  attach(terminalId: string): string {
    return this.ptys.get(terminalId)?.attach() ?? ''
  }

  restoreAll(): void {
    const liveIds = new Set(this.state.sessions.flatMap((s) => s.terminals.map((t) => t.id)))
    this.scrollback.prune(liveIds)
    for (const config of [...this.state.sessions].sort((a, b) => a.order - b.order)) {
      this.applyProfile(config)
      for (const terminal of config.terminals) {
        // Seed the previous run's saved output (if any) into the ring buffer
        // so attach() replays it, divider, then the live process output.
        const history = this.scrollback.load(terminal.id)
        this.spawnTerminal(config, terminal, terminal.startMode ?? 'fresh', history || undefined)
      }
      this.fs.start(config.id, config.folder, config.expandedPaths)
    }
  }

  disposeAll(): void {
    this.scrollback.flushAll()
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
    for (const timer of this.queueTimers.values()) clearTimeout(timer)
    this.queueTimers.clear()
    for (const timer of this.autoCompleteTimers.values()) clearTimeout(timer)
    this.autoCompleteTimers.clear()
    for (const pty of this.ptys.values()) pty.kill()
    this.ptys.clear()
    this.fs.stopAll()
  }

  private spawnTerminal(
    config: SessionConfig,
    terminal: TerminalConfig,
    mode: StartMode,
    history?: string
  ): void {
    // Token-efficiency env caps apply to claude only; the user's per-session
    // env overlays them, so an explicit session entry always wins.
    const te =
      terminal.kind === 'claude'
        ? this.tokenEff.envFor(config)
        : { set: {} as Record<string, string>, drop: [] as string[] }
    const session = new PtySession(
      terminal,
      config.folder,
      {
        onData: (id, data) => {
          this.getWin()?.webContents.send('pty:data', id, data)
        },
        onStatus: (id, status) => this.handleStatus(id, status),
        onExit: () => {
          this.getWin()?.webContents.send('session:changed')
        },
        // Snapshot lazily at write time — the store throttles to ~1 write/s.
        onOutput: (id) => this.scrollback.markDirty(id, () => session.tail(SCROLLBACK_MAX_BYTES))
      },
      { ...te.set, ...(config.env ?? {}) },
      te.drop
    )
    if (history) session.seedHistory(history + SCROLLBACK_DIVIDER)
    this.ptys.set(terminal.id, session)
    session.spawn(mode)
    if (terminal.kind === 'claude') this.tokenEff.markApplied(config)
  }

  private handleStatus(terminalId: string, status: SessionStatus): void {
    const win = this.getWin()
    win?.webContents.send('session:status', terminalId, status)

    const config = this.sessionOfTerminal(terminalId)
    if (!config) return
    const terminal = config.terminals.find((t) => t.id === terminalId)
    // Only claude terminals dispatch queues or raise attention; shells stop here.
    if (!terminal || terminal.kind !== 'claude') return

    // Queue dispatch rides the settled transition: claude must then stay
    // settled (done/idle) for QUEUE_IDLE_DELAY_MS (re-checked when the countdown
    // fires) before the oldest queued prompt is typed in.
    if (status === 'done' || status === 'idle') this.scheduleQueueDispatch(config.id)

    // Auto-complete (auto-merge / auto-PR) rides the same idle transition but on
    // a much longer countdown, and only for worktree tasks that opted in. Mark
    // the task as "has worked" the first time its claude runs, so the idle that
    // precedes the initial prompt never triggers completion.
    if (config.worktree?.autoComplete) {
      if (status === 'working') this.worktreeWorked.add(config.id)
      if (status === 'idle') this.scheduleAutoComplete(config.id)
      else this.clearAutoCompleteTimer(config.id)
    }

    if (status !== 'needs-attention') return
    const focused = win?.isFocused() ?? false
    const isActive =
      this.state.activeSessionId === config.id && config.activeTerminalId === terminalId

    if (!focused) win?.flashFrame(true)
    if (this.state.settings.notifyOnAttention && (!focused || !isActive)) {
      const notification = new Notification({
        title: `${config.name} · ${terminal.title}`,
        body: 'Claude session needs your input'
      })
      notification.on('click', () => {
        win?.show()
        win?.focus()
        win?.webContents.send('app:focus-session', config.id, terminalId)
      })
      notification.show()
    }
  }

  /**
   * Begin the periodic stall/runaway watchdog. Idempotent — a second call is a
   * no-op so it can't pile up timers. Each tick re-derives every live claude
   * terminal's alert and (a) fires exactly one OS notification per episode the
   * first time it crosses a threshold, and (b) pushes a `session:changed` when a
   * badge appears or clears so the sidebar updates without waiting for another
   * trigger.
   */
  startWatchdog(): void {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(() => this.watchdogTick(), WATCHDOG_TICK_MS)
  }

  private watchdogTick(): void {
    const liveClaudeIds = new Set<string>()
    let changed = false
    for (const config of this.state.sessions) {
      for (const terminal of config.terminals) {
        if (terminal.kind !== 'claude') continue
        const pty = this.ptys.get(terminal.id)
        if (!pty?.alive) continue
        liveClaudeIds.add(terminal.id)

        const status = pty.detector.current
        const since = pty.detector.since
        const alert = this.watchdogAlert(terminal, status, since)
        const prev = this.watchdog.get(terminal.id) ?? { notifiedSince: null, lastAlert: null }

        // A fresh episode (new status entry) re-arms the notification.
        let notifiedSince = prev.notifiedSince === since ? prev.notifiedSince : null
        if (alert && notifiedSince !== since) {
          this.fireWatchdogNotification(config, terminal, alert, since)
          notifiedSince = since
        }
        if (alert !== prev.lastAlert) changed = true
        this.watchdog.set(terminal.id, { notifiedSince, lastAlert: alert })
      }
    }
    // Forget terminals that closed/exited, so a later re-spawn starts clean.
    for (const id of [...this.watchdog.keys()]) {
      if (!liveClaudeIds.has(id)) this.watchdog.delete(id)
    }
    if (changed) this.notifyChanged()
  }

  /** Fire one stall/unanswered OS notification, reusing the attention pattern. */
  private fireWatchdogNotification(
    config: SessionConfig,
    terminal: TerminalConfig,
    alert: WatchdogAlert,
    since: number
  ): void {
    const win = this.getWin()
    const mins = Math.max(1, Math.round((Date.now() - since) / 60000))
    const body =
      alert === 'stalled'
        ? `Claude has been working ${mins} min without stopping — it may be stuck.`
        : `Claude has been awaiting your input for ${mins} min.`
    if (!(win?.isFocused() ?? false)) win?.flashFrame(true)
    const notification = new Notification({
      title: `${config.name} · ${terminal.title}`,
      body
    })
    notification.on('click', () => {
      win?.show()
      win?.focus()
      win?.webContents.send('app:focus-session', config.id, terminal.id)
    })
    notification.show()
  }

  private terminalInfo(terminal: TerminalConfig): TerminalInfo {
    const pty = this.ptys.get(terminal.id)
    const status = pty?.detector.current ?? 'exited'
    const statusSince = pty?.detector.since ?? 0
    return {
      config: terminal,
      status,
      pid: pty?.pid ?? null,
      lastOutputAt: pty?.detector.lastOutput ?? 0,
      exitCode: pty?.exitCode ?? null,
      statusSince,
      watchdog: pty?.alive ? this.watchdogAlert(terminal, status, statusSince) : null,
      outputChars: pty?.outputChars ?? 0
    }
  }

  /**
   * Derive a terminal's current watchdog alert purely from its kind, status,
   * how long it has held that status, and the persisted thresholds — no episode
   * state. Returns null for non-claude terminals, when the watchdog is off, when
   * a threshold is 0, or when the elapsed time hasn't crossed it yet.
   */
  private watchdogAlert(
    terminal: TerminalConfig,
    status: SessionStatus,
    statusSince: number
  ): WatchdogAlert | null {
    if (terminal.kind !== 'claude') return null
    const s = this.state.settings
    if (!s.watchdogEnabled || !statusSince) return null
    const elapsedMin = (Date.now() - statusSince) / 60000
    if (status === 'working' && s.watchdogStallMinutes > 0 && elapsedMin >= s.watchdogStallMinutes) {
      return 'stalled'
    }
    if (
      status === 'needs-attention' &&
      s.watchdogUnansweredMinutes > 0 &&
      elapsedMin >= s.watchdogUnansweredMinutes
    ) {
      return 'unanswered'
    }
    return null
  }

  private toInfo(config: SessionConfig): SessionInfo {
    const terminals = [...config.terminals]
      .sort((a, b) => a.order - b.order)
      .map((t) => this.terminalInfo(t))
    return {
      config,
      terminals,
      status: this.aggregateStatus(terminals),
      watchdog: terminals.find((t) => t.watchdog)?.watchdog ?? null
    }
  }

  private aggregateStatus(terminals: TerminalInfo[]): SessionStatus {
    if (terminals.length === 0) return 'exited'
    const present = new Set(terminals.map((t) => t.status))
    return STATUS_PRIORITY.find((s) => present.has(s)) ?? 'idle'
  }

  private notifyChanged(): void {
    this.getWin()?.webContents.send('session:changed')
  }
}
