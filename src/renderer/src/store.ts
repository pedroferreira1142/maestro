import { create } from 'zustand'
import type {
  AttachmentInfo,
  AutoExpandConfig,
  AutoExpandRun,
  Feature,
  FsEvent,
  RepoCategory,
  ReusableAction,
  SentinelConfig,
  SentinelRun,
  SessionInfo,
  SessionStatus,
  Settings,
  SkillInfo,
  TerminalKind
} from '../../shared/types'

/** One terminal waiting for user input, queued when it entered 'needs-attention'. */
export interface AttentionEntry {
  sessionId: string
  terminalId: string
  /** When the terminal entered 'needs-attention' (as observed by the renderer). */
  since: number
}

/** Pending state for the new-session dialog (set after a folder is picked). */
export interface PendingNewSession {
  folder: string
  defaultName: string
  suggestedCategoryId: string | null
}

/** Pending state for the parallel-task (worktree) dialog. */
export interface PendingWorktree {
  parentSessionId: string
  parentName: string
  repoRoot: string
  baseBranch: string
}

/** Human suffix for a merge alert describing the post-merge push outcome. */
function pushNote(pushed: boolean | undefined): string {
  if (pushed === true) return ' and pushed to the remote'
  if (pushed === false) return ' (push to remote FAILED — see next message)'
  return '' // no upstream: purely local repo, nothing to mention
}

/**
 * Order sessions for display/navigation: each top-level session is immediately
 * followed by its worktree task children. Worktrees whose parent isn't present
 * are shown at the end as top-level entries.
 */
export function orderedSessions(sessions: SessionInfo[]): SessionInfo[] {
  const byOrder = (a: SessionInfo, b: SessionInfo): number => a.config.order - b.config.order
  const ids = new Set(sessions.map((s) => s.config.id))
  const childrenOf = (id: string): SessionInfo[] =>
    sessions.filter((s) => s.config.worktree?.parentSessionId === id).sort(byOrder)
  const isTopLevel = (s: SessionInfo): boolean =>
    !s.config.worktree || !ids.has(s.config.worktree.parentSessionId)
  const out: SessionInfo[] = []
  for (const top of sessions.filter(isTopLevel).sort(byOrder)) {
    out.push(top)
    if (!top.config.worktree) out.push(...childrenOf(top.config.id))
  }
  return out
}

function basename(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? folder
}

const STATUS_PRIORITY: SessionStatus[] = [
  'needs-attention',
  'working',
  'starting',
  'idle',
  'error',
  'exited'
]

function aggregate(session: SessionInfo): SessionStatus {
  if (session.terminals.length === 0) return 'exited'
  const present = new Set(session.terminals.map((t) => t.status))
  return STATUS_PRIORITY.find((s) => present.has(s)) ?? 'idle'
}

/**
 * Tab-id encoding for git diff tabs. Plain file tabs are bare relPaths, so
 * diff tabs carry this prefix to stay distinguishable in the same `tabs` list
 * ('diff:' is never a valid path start — paths from main are normalized).
 */
export const DIFF_TAB_PREFIX = 'diff:'

/** True when a viewer tab id refers to a git diff tab. */
export function isDiffTab(tab: string): boolean {
  return tab.startsWith(DIFF_TAB_PREFIX)
}

/** The repo-root-relative path encoded in a diff tab id. */
export function diffTabPath(tab: string): string {
  return tab.slice(DIFF_TAB_PREFIX.length)
}

/**
 * Reconcile the attention queue against a fresh session list: drop entries
 * whose terminal is gone or no longer 'needs-attention', and append terminals
 * that are 'needs-attention' but missing from the queue (their transition was
 * never observed — e.g. at startup, where listSessions seeds the statuses).
 * Existing entries keep their position, so wait order survives refreshes.
 */
function reconcileAttentionQueue(
  queue: AttentionEntry[],
  sessions: SessionInfo[]
): AttentionEntry[] {
  const waiting = new Map<string, string>() // terminalId -> sessionId
  for (const s of sessions) {
    for (const t of s.terminals) {
      if (t.status === 'needs-attention') waiting.set(t.config.id, s.config.id)
    }
  }
  const next = queue.filter((e) => waiting.get(e.terminalId) === e.sessionId)
  const now = Date.now()
  for (const [terminalId, sessionId] of waiting) {
    if (!next.some((e) => e.terminalId === terminalId)) {
      next.push({ sessionId, terminalId, since: now })
    }
  }
  return next
}

export interface ViewerState {
  /** Open file tabs (relPaths) and diff tabs ('diff:' + repo-relative path). */
  tabs: string[]
  /** A terminal id or an entry from `tabs`. */
  active: string
}

interface AppStore {
  sessions: SessionInfo[]
  activeId: string | null
  settings: Settings | null
  explorerVisible: boolean
  viewers: Record<string, ViewerState>
  recent: Record<string, FsEvent[]>
  /** Per-session image attachment history (newest first), keyed by session id. */
  attachments: Record<string, AttachmentInfo[]>
  /** Bumped per terminal on restart to remount its xterm. */
  epochs: Record<string, number>
  /** Context-profile categories and the skills they can toggle. */
  categories: RepoCategory[]
  skills: SkillInfo[]
  /** New-session dialog payload; non-null while the dialog is open. */
  pendingNewSession: PendingNewSession | null
  /** Parallel-task dialog payload; non-null while the dialog is open. */
  pendingWorktree: PendingWorktree | null
  /** Whether the category-management dialog is open. */
  categoriesOpen: boolean
  /** Saved reusable actions (shell commands), shared across sessions. */
  actions: ReusableAction[]
  /** Action create/edit dialog payload; non-null while the dialog is open. */
  actionEditor: ReusableAction | 'new' | null
  /** Sentinel run history per session id, newest first. */
  sentinelRuns: Record<string, SentinelRun[]>
  /** Sentinel create/edit dialog payload; non-null while the dialog is open. */
  sentinelEditor: { sessionId: string; sentinel: SentinelConfig | 'new' } | null
  /** Auto-expand run history per session id, newest first. */
  autoExpandRuns: Record<string, AutoExpandRun[]>
  /** The session whose auto-expand dialog is open; null when closed. */
  autoExpandSessionId: string | null
  /** Bumped to make the Git panel reload (after commits/merges/init). */
  gitNonce: number
  /** The session whose Features & Specs dialog is open; null when closed. */
  featuresSessionId: string | null
  /** Features for the session whose dialog is open, oldest first. */
  features: Feature[]
  /** The custom app background image as a data URL; null when none is set. */
  backgroundDataUrl: string | null
  /** Whether the background-image dialog is open. */
  backgroundDialogOpen: boolean
  /** Terminals waiting for user input, oldest-waiting first. */
  attentionQueue: AttentionEntry[]

  init(): Promise<void>
  refresh(): Promise<void>
  setActive(id: string | null): void
  newSession(): Promise<void>
  confirmNewSession(opts: {
    name: string
    color: string | null
    categoryId: string | null
  }): Promise<void>
  cancelNewSession(): void
  newWorktreeTask(parentSessionId: string): Promise<void>
  confirmWorktreeTask(opts: {
    name: string
    branch: string
    baseBranch: string
    initialPrompt: string
  }): Promise<void>
  cancelWorktreeTask(): void
  mergeWorktree(sessionId: string): Promise<void>
  removeWorktreeTask(sessionId: string): Promise<void>
  /** Force the Git panel to reload its status + history. */
  refreshGit(): void
  loadCategoriesAndSkills(): Promise<void>
  saveCategories(categories: RepoCategory[]): Promise<void>
  setSessionCategory(sessionId: string, categoryId: string | null): Promise<void>
  openCategories(): void
  closeCategories(): void
  loadActions(): Promise<void>
  /** Create or update one action (upsert by id). */
  saveAction(action: ReusableAction): Promise<void>
  deleteAction(actionId: string): Promise<void>
  /** Run an action in a session and focus the terminal tab it ran in. */
  runAction(sessionId: string, actionId: string): Promise<void>
  openActionEditor(editor: ReusableAction | 'new'): void
  closeActionEditor(): void
  loadSentinelRuns(sessionId: string): Promise<void>
  /** Replace a session's run list (pushed from main on every run start/finish). */
  applySentinelRuns(sessionId: string, runs: SentinelRun[]): void
  /** Create or update one sentinel on a session (upsert by id). */
  saveSentinel(sessionId: string, sentinel: SentinelConfig): Promise<void>
  deleteSentinel(sessionId: string, sentinelId: string): Promise<void>
  runSentinel(sessionId: string, sentinelId: string): Promise<void>
  openSentinelEditor(sessionId: string, sentinel: SentinelConfig | 'new'): void
  closeSentinelEditor(): void
  openAutoExpand(sessionId: string): Promise<void>
  closeAutoExpand(): void
  loadAutoExpandRuns(sessionId: string): Promise<void>
  /** Replace a session's run list (pushed from main on every phase change). */
  applyAutoExpandRuns(sessionId: string, runs: AutoExpandRun[]): void
  /** Persist a session's auto-expand config (saved on the session, like sentinels). */
  saveAutoExpand(sessionId: string, config: AutoExpandConfig): Promise<void>
  /** Trigger one pipeline run right now. */
  runAutoExpand(sessionId: string): Promise<void>
  openFeatures(sessionId: string): Promise<void>
  closeFeatures(): void
  loadFeatures(sessionId: string): Promise<void>
  /** Create or update one feature (upsert by id), then reload the list. */
  saveFeature(feature: Feature): Promise<void>
  deleteFeature(id: string): Promise<void>
  /** Spin off a worktree task to implement a feature; focuses the new session. */
  implementFeature(id: string): Promise<void>
  closeSession(id: string): Promise<void>
  addTerminal(sessionId: string, kind: TerminalKind): Promise<void>
  closeTerminal(sessionId: string, terminalId: string): Promise<void>
  restartTerminal(terminalId: string, mode: 'fresh' | 'resume'): Promise<void>
  renameTerminal(terminalId: string, title: string): Promise<void>
  openFile(sessionId: string, relPath: string): void
  /** Open (or focus) the git diff tab for a changed file (repo-root-relative path). */
  openDiff(sessionId: string, relPath: string): void
  closeTab(sessionId: string, relPath: string): void
  setActiveTab(sessionId: string, tab: string): void
  toggleExplorer(): void
  cycleSession(dir: 1 | -1): void
  jumpToSession(index: number): void
  applyStatus(terminalId: string, status: SessionStatus): void
  applyFsEvents(id: string, events: FsEvent[]): void
  loadAttachments(sessionId: string): Promise<void>
  /** Save the clipboard image as an attachment; null when no image is on the clipboard. */
  attachClipboardImage(sessionId: string): Promise<AttachmentInfo | null>
  /** Attach a dropped file: by path when the OS provides one, else by content. */
  attachDroppedFile(sessionId: string, file: File): Promise<AttachmentInfo | null>
  deleteAttachment(sessionId: string, fileName: string): Promise<void>
  openBackgroundDialog(): void
  closeBackgroundDialog(): void
  /** Pick a new background image; updates settings + the cached data URL. */
  pickBackground(): Promise<void>
  /** Remove the custom background image. */
  clearBackground(): Promise<void>
  /** Persist a new background image opacity (0–1). */
  setBackgroundOpacity(opacity: number): Promise<void>
}

/** Default active tab for a session: its persisted active terminal, else first. */
function defaultActive(session: SessionInfo): string {
  return session.config.activeTerminalId ?? session.terminals[0]?.config.id ?? 'terminal'
}

export const useStore = create<AppStore>()((set, get) => ({
  sessions: [],
  activeId: null,
  settings: null,
  explorerVisible: true,
  viewers: {},
  recent: {},
  attachments: {},
  epochs: {},
  categories: [],
  skills: [],
  pendingNewSession: null,
  pendingWorktree: null,
  categoriesOpen: false,
  actions: [],
  actionEditor: null,
  sentinelRuns: {},
  sentinelEditor: null,
  autoExpandRuns: {},
  autoExpandSessionId: null,
  gitNonce: 0,
  featuresSessionId: null,
  features: [],
  backgroundDataUrl: null,
  backgroundDialogOpen: false,
  attentionQueue: [],

  async init() {
    const [settings, savedActive, backgroundDataUrl] = await Promise.all([
      window.api.getSettings(),
      window.api.getActiveSession(),
      window.api.getBackgroundImage()
    ])
    set({ settings, backgroundDataUrl })
    await Promise.all([get().loadCategoriesAndSkills(), get().loadActions()])
    await get().refresh()
    const { sessions } = get()
    const active =
      sessions.find((s) => s.config.id === savedActive)?.config.id ??
      sessions[0]?.config.id ??
      null
    get().setActive(active)
  },

  async refresh() {
    const sessions = await window.api.listSessions()
    const { activeId, viewers } = get()
    const nextViewers = { ...viewers }
    for (const s of sessions) {
      const existing = nextViewers[s.config.id]
      if (!existing) {
        nextViewers[s.config.id] = { tabs: [], active: defaultActive(s) }
        continue
      }
      // If the active tab points at a terminal that no longer exists (closed),
      // fall back to another terminal; file tabs are validated on their own.
      const isTerminal = s.terminals.some((t) => t.config.id === existing.active)
      const isFile = existing.tabs.includes(existing.active)
      if (!isTerminal && !isFile) {
        nextViewers[s.config.id] = { ...existing, active: defaultActive(s) }
      }
    }
    const stillActive = sessions.some((s) => s.config.id === activeId)
    set({
      sessions,
      viewers: nextViewers,
      activeId: stillActive ? activeId : (sessions[0]?.config.id ?? null),
      attentionQueue: reconcileAttentionQueue(get().attentionQueue, sessions)
    })
  },

  setActive(id) {
    set({ activeId: id })
    void window.api.setActiveSession(id)
  },

  async newSession() {
    const folder = await window.api.pickFolder()
    if (!folder) return
    const suggestedCategoryId = await window.api.detectCategory(folder)
    set({ pendingNewSession: { folder, defaultName: basename(folder), suggestedCategoryId } })
  },

  async confirmNewSession(opts) {
    const pending = get().pendingNewSession
    if (!pending) return
    set({ pendingNewSession: null })
    const info = await window.api.createSession(pending.folder, {
      name: opts.name,
      color: opts.color,
      categoryId: opts.categoryId
    })
    await get().refresh()
    get().setActive(info.config.id)
  },

  cancelNewSession() {
    set({ pendingNewSession: null })
  },

  async newWorktreeTask(parentSessionId) {
    const parent = get().sessions.find((s) => s.config.id === parentSessionId)
    if (!parent) return
    let info = await window.api.worktreeInfo(parentSessionId)
    if (!info.isRepo || !info.repoRoot) {
      // Parallel tasks need a git repo to branch off. Offer to create one here
      // rather than dead-ending the user.
      const create = window.confirm(
        `"${parent.config.name}" isn't a git repository yet.\n\n` +
          `Initialize a new git repository in this folder so it can host parallel tasks?\n\n` +
          `(Your files are left untracked — only an empty initial commit is added.)`
      )
      if (!create) return
      try {
        info = await window.api.gitInit(parentSessionId)
      } catch (err) {
        window.alert(`Couldn't initialize a git repository:\n\n${(err as Error).message}`)
        return
      }
      get().refreshGit()
      if (!info.isRepo || !info.repoRoot) {
        window.alert(
          `The folder still isn't a git repository after initializing — check that git is installed.`
        )
        return
      }
    }
    set({
      pendingWorktree: {
        parentSessionId,
        parentName: parent.config.name,
        repoRoot: info.repoRoot,
        baseBranch: info.branch ?? 'HEAD'
      }
    })
  },

  refreshGit() {
    set((st) => ({ gitNonce: st.gitNonce + 1 }))
  },

  async confirmWorktreeTask(opts) {
    const pending = get().pendingWorktree
    if (!pending) return
    set({ pendingWorktree: null })
    try {
      const info = await window.api.createWorktree(pending.parentSessionId, {
        name: opts.name,
        branch: opts.branch,
        baseBranch: opts.baseBranch,
        initialPrompt: opts.initialPrompt || undefined
      })
      await get().refresh()
      get().setActive(info.config.id)
      get().refreshGit()
    } catch (err) {
      window.alert(`Couldn't create the worktree:\n\n${(err as Error).message}`)
    }
  },

  cancelWorktreeTask() {
    set({ pendingWorktree: null })
  },

  async mergeWorktree(sessionId) {
    const session = get().sessions.find((s) => s.config.id === sessionId)
    const wt = session?.config.worktree
    if (!session || !wt) return

    const state = await window.api.worktreeState(sessionId)
    if (!state.folderExists) {
      window.alert(
        `The worktree folder for "${session.config.name}" no longer exists.\n\n` +
          `Use ✕ on the task to clean it up.`
      )
      return
    }

    // Claude edits files but doesn't commit — pending work must be committed
    // to the task branch or the merge would silently miss it.
    let commitFirst = false
    if (state.dirty > 0) {
      commitFirst = window.confirm(
        `"${session.config.name}" has ${state.dirty} uncommitted file(s).\n\n` +
          `Commit them to "${wt.branch}" and merge into "${wt.baseBranch}"?`
      )
      if (!commitFirst) return
    } else if (state.ahead === 0) {
      window.alert(
        `Nothing to merge: "${wt.branch}" has no uncommitted changes and no commits ` +
          `beyond "${wt.baseBranch}".\n\nAsk claude to make (or commit) changes first.`
      )
      return
    }

    const result = await window.api.mergeWorktree(sessionId, commitFirst)
    get().refreshGit() // history changed (commit and/or merge)
    if (result.ok) {
      const cleanup = window.confirm(
        `Merged "${wt.branch}" into "${wt.baseBranch}"${pushNote(result.pushed)}.\n\n` +
          `Remove the worktree and delete the branch now?`
      )
      if (cleanup) await get().removeWorktreeTask(sessionId)
      if (result.pushed === false) {
        window.alert(`The merge succeeded but pushing "${wt.baseBranch}" failed:\n\n${result.output}`)
      }
      return
    }
    if (result.nothingToMerge) {
      window.alert(result.output)
      return
    }
    if (result.conflict) {
      const assist = window.confirm(
        `${result.output}\n\n` +
          `Start the merge and let Claude resolve the conflicts in the parent session ` +
          `("${get().sessions.find((s) => s.config.id === wt.parentSessionId)?.config.name ?? wt.baseFolder}")?\n\n` +
          `OK = Claude resolves there · Cancel = leave everything untouched`
      )
      if (!assist) return

      const started = await window.api.startConflictedMerge(sessionId)
      if (started.ok) {
        // Conflict prediction was conservative — it merged cleanly after all.
        const cleanup = window.confirm(
          `Merged "${wt.branch}" into "${wt.baseBranch}" (no conflicts after all)${pushNote(started.pushed)}.\n\n` +
            `Remove the worktree and delete the branch now?`
        )
        if (cleanup) await get().removeWorktreeTask(sessionId)
        if (started.pushed === false) {
          window.alert(
            `The merge succeeded but pushing "${wt.baseBranch}" failed:\n\n${started.output}`
          )
        }
        return
      }
      if (!started.conflict) {
        window.alert(`Couldn't start the merge:\n\n${started.output}`)
        return
      }

      // The merge now sits conflicted in the base repo. Put the parent session's
      // claude on it: focus that terminal and type (not submit) the prompt.
      const parent = get().sessions.find((s) => s.config.id === wt.parentSessionId)
      const claudeTerm = parent?.terminals.find(
        (t) => t.config.kind === 'claude' && t.status !== 'exited' && t.status !== 'error'
      )
      if (!parent || !claudeTerm) {
        window.alert(
          `The merge is started and stopped on conflicts in:\n${wt.baseFolder}\n\n` +
            `No running claude terminal found in the parent session — resolve the conflicts ` +
            `there manually, then commit (or abort with "git merge --abort").`
        )
        return
      }
      get().setActive(parent.config.id)
      get().setActiveTab(parent.config.id, claudeTerm.config.id)
      window.api.ptyWrite(
        claudeTerm.config.id,
        `We are merging the parallel-task branch "${wt.branch}" into "${wt.baseBranch}" and git ` +
          `stopped on merge conflicts in this repo. Resolve all conflicts (see git status), ` +
          `preserving the intent of both sides, then stage everything and complete the merge commit.`
      )
      return
    }
    window.alert(`Merge failed:\n\n${result.output}`)
  },

  async removeWorktreeTask(sessionId) {
    const session = get().sessions.find((s) => s.config.id === sessionId)
    const wt = session?.config.worktree
    if (!session || !wt) return

    const state = await window.api.worktreeState(sessionId)
    const lossWarning =
      state.folderExists && state.dirty > 0
        ? `\n\n⚠ ${state.dirty} uncommitted file(s) will be PERMANENTLY DELETED.`
        : ''
    const prompt = state.folderExists
      ? `Remove worktree task "${session.config.name}"?\n\nThis deletes the worktree folder:\n${session.config.folder}${lossWarning}`
      : `Remove the broken task "${session.config.name}"? (Its worktree folder is already gone.)`
    if (!window.confirm(prompt)) return

    const unmergedWarning =
      state.ahead > 0 ? ` It has ${state.ahead} commit(s) not merged into "${wt.baseBranch}".` : ''
    const delBranch = window.confirm(`Also delete the branch "${wt.branch}"?${unmergedWarning}`)
    try {
      await window.api.removeWorktree(sessionId, delBranch)
      await get().refresh()
      get().refreshGit()
    } catch (err) {
      window.alert(`Couldn't remove the worktree:\n\n${(err as Error).message}`)
      await get().refresh()
    }
  },

  async loadCategoriesAndSkills() {
    const [categories, skills] = await Promise.all([
      window.api.listCategories(),
      window.api.listClaudeSkills()
    ])
    set({ categories, skills })
  },

  async saveCategories(categories) {
    await window.api.saveCategories(categories)
    set({ categories })
  },

  async setSessionCategory(sessionId, categoryId) {
    const restartIds = await window.api.setSessionCategory(sessionId, categoryId)
    // Skills/MCP only load at claude startup, so restart the affected terminals
    // (resume keeps the conversation). restartTerminal bumps epochs + refreshes.
    for (const id of restartIds) await get().restartTerminal(id, 'resume')
    await get().refresh()
  },

  openCategories() {
    set({ categoriesOpen: true })
    void get().loadCategoriesAndSkills()
  },

  closeCategories() {
    set({ categoriesOpen: false })
  },

  async loadActions() {
    set({ actions: await window.api.listActions() })
  },

  async saveAction(action) {
    const list = get().actions
    const next = list.some((a) => a.id === action.id)
      ? list.map((a) => (a.id === action.id ? action : a))
      : [...list, action]
    await window.api.saveActions(next)
    set({ actions: next })
  },

  async deleteAction(actionId) {
    const next = get().actions.filter((a) => a.id !== actionId)
    await window.api.saveActions(next)
    set({ actions: next })
  },

  async runAction(sessionId, actionId) {
    const result = await window.api.runAction(sessionId, actionId)
    if (!result) return
    if (result.respawned) {
      // The terminal's pty was (re)started — remount xterm so it re-attaches.
      set((st) => ({
        epochs: { ...st.epochs, [result.terminalId]: (st.epochs[result.terminalId] ?? 0) + 1 }
      }))
    }
    await get().refresh()
    get().setActiveTab(sessionId, result.terminalId)
  },

  openActionEditor(editor) {
    set({ actionEditor: editor })
  },

  closeActionEditor() {
    set({ actionEditor: null })
  },

  async loadSentinelRuns(sessionId) {
    const runs = await window.api.listSentinelRuns(sessionId)
    set((st) => ({ sentinelRuns: { ...st.sentinelRuns, [sessionId]: runs } }))
  },

  applySentinelRuns(sessionId, runs) {
    set((st) => ({ sentinelRuns: { ...st.sentinelRuns, [sessionId]: runs } }))
  },

  async saveSentinel(sessionId, sentinel) {
    const session = get().sessions.find((s) => s.config.id === sessionId)
    if (!session) return
    const list = session.config.sentinels ?? []
    const sentinels = list.some((s) => s.id === sentinel.id)
      ? list.map((s) => (s.id === sentinel.id ? sentinel : s))
      : [...list, sentinel]
    await window.api.updateSession(sessionId, { sentinels })
    await get().refresh()
  },

  async deleteSentinel(sessionId, sentinelId) {
    const session = get().sessions.find((s) => s.config.id === sessionId)
    if (!session) return
    const sentinels = (session.config.sentinels ?? []).filter((s) => s.id !== sentinelId)
    await window.api.updateSession(sessionId, { sentinels })
    await get().refresh()
  },

  async runSentinel(sessionId, sentinelId) {
    await window.api.runSentinel(sessionId, sentinelId)
  },

  openSentinelEditor(sessionId, sentinel) {
    set({ sentinelEditor: { sessionId, sentinel } })
  },

  closeSentinelEditor() {
    set({ sentinelEditor: null })
  },

  async openAutoExpand(sessionId) {
    set({ autoExpandSessionId: sessionId })
    await get().loadAutoExpandRuns(sessionId)
  },

  closeAutoExpand() {
    set({ autoExpandSessionId: null })
  },

  async loadAutoExpandRuns(sessionId) {
    const runs = await window.api.listAutoExpandRuns(sessionId)
    set((st) => ({ autoExpandRuns: { ...st.autoExpandRuns, [sessionId]: runs } }))
  },

  applyAutoExpandRuns(sessionId, runs) {
    set((st) => ({ autoExpandRuns: { ...st.autoExpandRuns, [sessionId]: runs } }))
  },

  async saveAutoExpand(sessionId, config) {
    await window.api.updateSession(sessionId, { autoExpand: config })
    await get().refresh()
  },

  async runAutoExpand(sessionId) {
    await window.api.runAutoExpand(sessionId)
  },

  async openFeatures(sessionId) {
    set({ featuresSessionId: sessionId, features: [] })
    await get().loadFeatures(sessionId)
  },

  closeFeatures() {
    set({ featuresSessionId: null, features: [] })
  },

  async loadFeatures(sessionId) {
    const features = await window.api.listFeatures(sessionId)
    // Ignore a late response if the dialog was closed or switched in the meantime.
    if (get().featuresSessionId === sessionId) set({ features })
  },

  async saveFeature(feature) {
    await window.api.saveFeature(feature)
    await get().loadFeatures(feature.sessionId)
  },

  async deleteFeature(id) {
    const sessionId = get().featuresSessionId
    await window.api.deleteFeature(id)
    if (sessionId) await get().loadFeatures(sessionId)
  },

  async implementFeature(id) {
    try {
      const info = await window.api.implementFeature(id)
      set({ featuresSessionId: null, features: [] })
      await get().refresh()
      get().setActive(info.config.id)
    } catch (err) {
      window.alert(`Couldn't start implementing the feature:\n\n${(err as Error).message}`)
      const sessionId = get().featuresSessionId
      if (sessionId) await get().loadFeatures(sessionId)
    }
  },

  async closeSession(id) {
    const session = get().sessions.find((s) => s.config.id === id)
    if (!session) return
    const alive = session.status !== 'exited' && session.status !== 'error'
    if (alive && !window.confirm(`Close session "${session.config.name}"?`)) return
    await window.api.closeSession(id)
    await get().refresh()
  },

  async addTerminal(sessionId, kind) {
    const info = await window.api.addTerminal(sessionId, kind)
    await get().refresh()
    if (info) get().setActiveTab(sessionId, info.config.id)
  },

  async closeTerminal(sessionId, terminalId) {
    await window.api.closeTerminal(sessionId, terminalId)
    await get().refresh()
  },

  async restartTerminal(terminalId, mode) {
    await window.api.restartTerminal(terminalId, mode)
    set((st) => ({ epochs: { ...st.epochs, [terminalId]: (st.epochs[terminalId] ?? 0) + 1 } }))
    await get().refresh()
  },

  async renameTerminal(terminalId, title) {
    await window.api.updateTerminal(terminalId, { title })
    await get().refresh()
  },

  openFile(sessionId, relPath) {
    set((st) => {
      const s = st.sessions.find((x) => x.config.id === sessionId)
      const v = st.viewers[sessionId] ?? { tabs: [], active: s ? defaultActive(s) : 'terminal' }
      const tabs = v.tabs.includes(relPath) ? v.tabs : [...v.tabs, relPath]
      return { viewers: { ...st.viewers, [sessionId]: { tabs, active: relPath } } }
    })
  },

  openDiff(sessionId, relPath) {
    const tab = DIFF_TAB_PREFIX + relPath
    set((st) => {
      const s = st.sessions.find((x) => x.config.id === sessionId)
      const v = st.viewers[sessionId] ?? { tabs: [], active: s ? defaultActive(s) : 'terminal' }
      const tabs = v.tabs.includes(tab) ? v.tabs : [...v.tabs, tab]
      return { viewers: { ...st.viewers, [sessionId]: { tabs, active: tab } } }
    })
  },

  closeTab(sessionId, relPath) {
    set((st) => {
      const v = st.viewers[sessionId]
      if (!v) return st
      const s = st.sessions.find((x) => x.config.id === sessionId)
      const tabs = v.tabs.filter((t) => t !== relPath)
      const active = v.active === relPath ? (s ? defaultActive(s) : 'terminal') : v.active
      return { viewers: { ...st.viewers, [sessionId]: { tabs, active } } }
    })
  },

  setActiveTab(sessionId, tab) {
    set((st) => {
      const s = st.sessions.find((x) => x.config.id === sessionId)
      const v = st.viewers[sessionId] ?? { tabs: [], active: s ? defaultActive(s) : 'terminal' }
      return { viewers: { ...st.viewers, [sessionId]: { ...v, active: tab } } }
    })
    // Persist terminal selection so it's restored on relaunch.
    const s = get().sessions.find((x) => x.config.id === sessionId)
    if (s?.terminals.some((t) => t.config.id === tab)) {
      void window.api.setActiveTerminal(sessionId, tab)
    }
  },

  toggleExplorer() {
    set((st) => ({ explorerVisible: !st.explorerVisible }))
  },

  cycleSession(dir) {
    const ordered = orderedSessions(get().sessions)
    if (ordered.length === 0) return
    const idx = ordered.findIndex((s) => s.config.id === get().activeId)
    const next = ordered[(idx + dir + ordered.length) % ordered.length]
    get().setActive(next.config.id)
  },

  jumpToSession(index) {
    const ordered = orderedSessions(get().sessions)
    if (index >= 0 && index < ordered.length) get().setActive(ordered[index].config.id)
  },

  applyStatus(terminalId, status) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (!s.terminals.some((t) => t.config.id === terminalId)) return s
        const terminals = s.terminals.map((t) =>
          t.config.id === terminalId ? { ...t, status, lastOutputAt: Date.now() } : t
        )
        const next = { ...s, terminals }
        return { ...next, status: aggregate(next) }
      })
      // Keep the attention queue in sync with the transition: enqueue when a
      // terminal enters 'needs-attention', dequeue the moment it leaves.
      let attentionQueue = st.attentionQueue
      const queued = attentionQueue.some((e) => e.terminalId === terminalId)
      if (status === 'needs-attention' && !queued) {
        const owner = sessions.find((s) => s.terminals.some((t) => t.config.id === terminalId))
        if (owner) {
          attentionQueue = [
            ...attentionQueue,
            { sessionId: owner.config.id, terminalId, since: Date.now() }
          ]
        }
      } else if (status !== 'needs-attention' && queued) {
        attentionQueue = attentionQueue.filter((e) => e.terminalId !== terminalId)
      }
      return { sessions, attentionQueue }
    })
  },

  async loadAttachments(sessionId) {
    const list = await window.api.listAttachments(sessionId)
    set((st) => ({ attachments: { ...st.attachments, [sessionId]: list } }))
  },

  async attachClipboardImage(sessionId) {
    const info = await window.api.attachClipboardImage(sessionId)
    if (info) await get().loadAttachments(sessionId)
    return info
  },

  async attachDroppedFile(sessionId, file) {
    const path = window.api.pathForFile(file)
    let info: AttachmentInfo | null = null
    if (path) {
      info = await window.api.attachImageFile(sessionId, path)
    } else if (file.type.startsWith('image/')) {
      // No filesystem path (e.g. an image dragged out of a browser).
      const ext = file.type === 'image/jpeg' ? '.jpg' : `.${file.type.slice(6)}`
      const bytes = new Uint8Array(await file.arrayBuffer())
      info = await window.api.attachImageData(sessionId, file.name || `dropped${ext}`, bytes)
    }
    if (info) await get().loadAttachments(sessionId)
    return info
  },

  async deleteAttachment(sessionId, fileName) {
    await window.api.deleteAttachment(sessionId, fileName)
    await get().loadAttachments(sessionId)
  },

  openBackgroundDialog() {
    set({ backgroundDialogOpen: true })
  },

  closeBackgroundDialog() {
    set({ backgroundDialogOpen: false })
  },

  async pickBackground() {
    const dataUrl = await window.api.pickBackgroundImage()
    if (!dataUrl) return // cancelled or not an image
    // Main already persisted settings.backgroundImage; refresh our copy so
    // terminals/UI react (the file name itself doesn't matter to the renderer).
    const settings = await window.api.getSettings()
    set({ backgroundDataUrl: dataUrl, settings })
  },

  async clearBackground() {
    await window.api.clearBackgroundImage()
    const settings = await window.api.getSettings()
    set({ backgroundDataUrl: null, settings })
  },

  async setBackgroundOpacity(opacity) {
    const settings = get().settings
    if (!settings) return
    set({ settings: { ...settings, backgroundOpacity: opacity } })
    await window.api.setSettings({ backgroundOpacity: opacity })
  },

  applyFsEvents(id, events) {
    const fileChanges = events.filter((e) => e.kind === 'add' || e.kind === 'change')
    if (fileChanges.length === 0) return
    set((st) => {
      const prev = st.recent[id] ?? []
      const merged = [...fileChanges.reverse(), ...prev.filter(
        (p) => !fileChanges.some((c) => c.relPath === p.relPath)
      )].slice(0, 10)
      return { recent: { ...st.recent, [id]: merged } }
    })
  }
}))
