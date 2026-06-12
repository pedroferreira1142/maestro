import { BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { existsSync, rmSync } from 'fs'
import {
  GitCommit,
  GitFileChange,
  GitFileDiff,
  GitStatus,
  MergeResult,
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

/** Sidebar aggregate order — earliest wins across a session's terminals. */
const STATUS_PRIORITY: SessionStatus[] = [
  'needs-attention',
  'working',
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

  /** On-disk tail of each terminal's output, replayed on app restart. */
  private scrollback = new ScrollbackStore()

  constructor(
    private persistence: Persistence,
    private fs: FsService,
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
      claudeArgs: [],
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
      worktree: { parentSessionId, branch, baseBranch, baseFolder: repoRoot }
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

  /**
   * Best-effort push of the base branch after a successful merge, so the merge
   * shows up on the remote (GitHub) and not just locally. A push failure never
   * fails the merge — it's reported via `pushed:false` + appended output.
   * Skipped (pushed stays undefined) when the base branch has no upstream.
   */
  private async pushAfterMerge(
    merge: MergeResult,
    baseFolder: string,
    baseBranch: string
  ): Promise<MergeResult> {
    const push = await Git.pushBranch(baseFolder, baseBranch)
    if (!push) return merge // no upstream — purely local repo, nothing to push to
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
    if (!pty?.alive || pty.detector.current !== 'idle') return
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
    for (const timer of this.queueTimers.values()) clearTimeout(timer)
    this.queueTimers.clear()
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
    const session = new PtySession(terminal, config.folder, {
      onData: (id, data) => {
        this.getWin()?.webContents.send('pty:data', id, data)
      },
      onStatus: (id, status) => this.handleStatus(id, status),
      onExit: () => {
        this.getWin()?.webContents.send('session:changed')
      },
      // Snapshot lazily at write time — the store throttles to ~1 write/s.
      onOutput: (id) => this.scrollback.markDirty(id, () => session.tail(SCROLLBACK_MAX_BYTES))
    })
    if (history) session.seedHistory(history + SCROLLBACK_DIVIDER)
    this.ptys.set(terminal.id, session)
    session.spawn(mode)
  }

  private handleStatus(terminalId: string, status: SessionStatus): void {
    const win = this.getWin()
    win?.webContents.send('session:status', terminalId, status)

    const config = this.sessionOfTerminal(terminalId)
    if (!config) return
    const terminal = config.terminals.find((t) => t.id === terminalId)
    // Only claude terminals dispatch queues or raise attention; shells stop here.
    if (!terminal || terminal.kind !== 'claude') return

    // Queue dispatch rides the idle transition: claude must then stay idle for
    // QUEUE_IDLE_DELAY_MS (re-checked when the countdown fires) before the
    // oldest queued prompt is typed in.
    if (status === 'idle') this.scheduleQueueDispatch(config.id)

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

  private terminalInfo(terminal: TerminalConfig): TerminalInfo {
    const pty = this.ptys.get(terminal.id)
    return {
      config: terminal,
      status: pty?.detector.current ?? 'exited',
      pid: pty?.pid ?? null,
      lastOutputAt: pty?.detector.lastOutput ?? 0,
      exitCode: pty?.exitCode ?? null
    }
  }

  private toInfo(config: SessionConfig): SessionInfo {
    const terminals = [...config.terminals]
      .sort((a, b) => a.order - b.order)
      .map((t) => this.terminalInfo(t))
    return {
      config,
      terminals,
      status: this.aggregateStatus(terminals)
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
