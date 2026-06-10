import { BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { existsSync, rmSync } from 'fs'
import {
  MergeResult,
  RepoCategory,
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

/** How long to wait before typing a worktree task's initial prompt into claude. */
const INITIAL_PROMPT_DELAY_MS = 3500

/** How long to wait for killed PTY processes to release their cwd (Windows file locks). */
const PTY_EXIT_WAIT_MS = 4000

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
      }
    }
    this.fs.stop(id)
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
      // Type (but don't submit) the first prompt once claude has booted, so the
      // user reviews it and presses Enter. Best-effort; skipped if the pty died.
      setTimeout(() => this.ptys.get(claudeTerminal.id)?.write(prompt), INITIAL_PROMPT_DELAY_MS)
    }

    this.notifyChanged()
    return this.toInfo(config)
  }

  /** Live git facts about a worktree task (uncommitted files, commits ahead). */
  async getWorktreeTaskState(sessionId: string): Promise<WorktreeTaskState> {
    const config = this.getConfig(sessionId)
    if (!config?.worktree) return { folderExists: false, dirty: -1, ahead: -1 }
    const folderExists = existsSync(config.folder)
    const dirty = folderExists ? await Git.dirtyCount(config.folder) : null
    const ahead = await Git.aheadCount(
      config.worktree.baseFolder,
      config.worktree.baseBranch,
      config.worktree.branch
    )
    return { folderExists, dirty: dirty ?? -1, ahead: ahead ?? -1 }
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
    return { ...result, autoCommitted }
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
        try {
          await Git.removeWorktree(baseFolder, config.folder, true)
        } catch {
          await sleep(1000) // file locks can outlive the process briefly
          await Git.removeWorktree(baseFolder, config.folder, true)
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
    this.spawnTerminal(config, terminal, mode === 'resume' ? 'continue' : 'fresh')
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
    for (const config of [...this.state.sessions].sort((a, b) => a.order - b.order)) {
      this.applyProfile(config)
      for (const terminal of config.terminals) {
        this.spawnTerminal(config, terminal, terminal.startMode ?? 'fresh')
      }
      this.fs.start(config.id, config.folder, config.expandedPaths)
    }
  }

  disposeAll(): void {
    for (const pty of this.ptys.values()) pty.kill()
    this.ptys.clear()
    this.fs.stopAll()
  }

  private spawnTerminal(config: SessionConfig, terminal: TerminalConfig, mode: StartMode): void {
    const session = new PtySession(terminal, config.folder, {
      onData: (id, data) => {
        this.getWin()?.webContents.send('pty:data', id, data)
      },
      onStatus: (id, status) => this.handleStatus(id, status),
      onExit: () => {
        this.getWin()?.webContents.send('session:changed')
      }
    })
    this.ptys.set(terminal.id, session)
    session.spawn(mode)
  }

  private handleStatus(terminalId: string, status: SessionStatus): void {
    const win = this.getWin()
    win?.webContents.send('session:status', terminalId, status)

    if (status !== 'needs-attention') return
    const config = this.sessionOfTerminal(terminalId)
    if (!config) return
    const terminal = config.terminals.find((t) => t.id === terminalId)
    // Only claude terminals raise attention; shells never reach this branch.
    if (!terminal || terminal.kind !== 'claude') return
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
