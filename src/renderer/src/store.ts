import { create } from 'zustand'
import type {
  AttachmentInfo,
  FsEvent,
  RepoCategory,
  SessionInfo,
  SessionStatus,
  Settings,
  SkillInfo,
  TerminalKind
} from '../../shared/types'

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

export interface ViewerState {
  /** Open file tabs (relPaths). Terminals come from the session config. */
  tabs: string[]
  /** A terminal id or a relPath from `tabs`. */
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
  loadCategoriesAndSkills(): Promise<void>
  saveCategories(categories: RepoCategory[]): Promise<void>
  setSessionCategory(sessionId: string, categoryId: string | null): Promise<void>
  openCategories(): void
  closeCategories(): void
  closeSession(id: string): Promise<void>
  addTerminal(sessionId: string, kind: TerminalKind): Promise<void>
  closeTerminal(sessionId: string, terminalId: string): Promise<void>
  restartTerminal(terminalId: string, mode: 'fresh' | 'resume'): Promise<void>
  renameTerminal(terminalId: string, title: string): Promise<void>
  openFile(sessionId: string, relPath: string): void
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

  async init() {
    const [settings, savedActive] = await Promise.all([
      window.api.getSettings(),
      window.api.getActiveSession()
    ])
    set({ settings })
    await get().loadCategoriesAndSkills()
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
      activeId: stillActive ? activeId : (sessions[0]?.config.id ?? null)
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
    const info = await window.api.worktreeInfo(parentSessionId)
    if (!info.isRepo || !info.repoRoot) {
      window.alert(`"${parent.config.name}" isn't a git repository, so it can't host worktree tasks.`)
      return
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
    if (result.ok) {
      const cleanup = window.confirm(
        `Merged "${wt.branch}" into "${wt.baseBranch}".\n\nRemove the worktree and delete the branch now?`
      )
      if (cleanup) await get().removeWorktreeTask(sessionId)
      return
    }
    if (result.nothingToMerge) {
      window.alert(result.output)
      return
    }
    if (result.conflict) {
      get().setActive(sessionId)
      window.alert(
        `Merge of "${wt.branch}" into "${wt.baseBranch}" stopped on conflicts.\n\n` +
          `Resolve them in the terminal (in the BASE repo: ${wt.baseFolder}), then commit.\n\n${result.output}`
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
    set((st) => ({
      sessions: st.sessions.map((s) => {
        if (!s.terminals.some((t) => t.config.id === terminalId)) return s
        const terminals = s.terminals.map((t) =>
          t.config.id === terminalId ? { ...t, status, lastOutputAt: Date.now() } : t
        )
        const next = { ...s, terminals }
        return { ...next, status: aggregate(next) }
      })
    }))
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
