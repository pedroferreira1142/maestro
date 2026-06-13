import { BrowserWindow } from 'electron'
import { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import {
  ConductorAction,
  ConductorActionKind,
  ConductorImage,
  ConductorMessage,
  ConductorRisk,
  ConductorTaskOptions,
  Feature,
  SessionInfo
} from '../shared/types'
import { AutoExpandService } from './AutoExpand'
import { ConductorStore } from './ConductorStore'
import { FeatureService } from './FeatureService'
import { extractJson, runHeadlessClaude } from './HeadlessClaude'
import { Persistence } from './Persistence'
import { SessionManager } from './SessionManager'

/** Headless planner timeout — long enough for it to read files, short enough to fail fast. */
const PLANNER_TIMEOUT_MS = 90_000

/** Conversation turns fed back to the planner as context (most recent). */
const HISTORY_TURNS = 8

/** Cap on actions accepted from one planner turn. */
const MAX_ACTIONS = 10

/** Read-only tools the planner may use to dig into any repo while reasoning. */
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git branch:*)',
  'Bash(git rev-parse:*)'
]

/** Risk is decided here from the kind — never trusted from the model's output. */
const RISK_BY_KIND: Record<ConductorActionKind, ConductorRisk> = {
  create_session: 'write',
  author_feature: 'write',
  implement_feature: 'write',
  create_worktree_task: 'write',
  queue_prompt: 'write',
  broadcast_prompt: 'write',
  run_auto_expand: 'write',
  merge_worktree: 'destructive',
  remove_worktree: 'destructive'
}

const VALID_KINDS = new Set<string>(Object.keys(RISK_BY_KIND))

/**
 * The Maestro Conductor: an app-level AI chat that reasons across ALL sessions,
 * worktree tasks and repos and proposes management actions. It follows a
 * propose→confirm model — each user message runs one headless `claude -p` that
 * returns a reply plus proposed actions; nothing runs until the user approves
 * it, and execution is delegated entirely to the existing services
 * (SessionManager / FeatureService / AutoExpandService). Conversation is
 * persisted via ConductorStore (its own file). Mirrors AutoExpandService in
 * shape (timer-less): one turn in flight at a time, renderer kept in sync via
 * the 'conductor:changed' broadcast.
 */
export class ConductorService {
  private store = new ConductorStore()
  private messages: ConductorMessage[] = []
  /** The in-flight planner child, so dispose()/a new turn can cancel it. */
  private inFlight: ChildProcess | null = null
  private busy = false
  /** Observer fired after each completed (non-error) turn — wired to the Factory's
   *  self-growth detector in index.ts. A post-construction setter avoids a
   *  constructor cycle (conductor is built before the factory). */
  private turnCompleteCb: ((messages: ConductorMessage[]) => void) | null = null

  constructor(
    private persistence: Persistence,
    private sessions: SessionManager,
    private features: FeatureService,
    private autoExpand: AutoExpandService,
    private getWin: () => BrowserWindow | null
  ) {
    this.messages = this.store.load()
  }

  /** Register an observer notified after each successful turn (e.g. the Factory). */
  onTurnComplete(cb: (messages: ConductorMessage[]) => void): void {
    this.turnCompleteCb = cb
  }

  list(): ConductorMessage[] {
    return this.messages
  }

  dispose(): void {
    try {
      this.inFlight?.kill()
    } catch {
      // already gone
    }
    this.inFlight = null
    this.store.saveNow()
  }

  clear(): void {
    this.messages = []
    this.store.clear()
    this.broadcast()
  }

  /**
   * Handle one user message: record it, generate the assistant turn via the
   * headless planner, and surface any proposed actions. Ignored while a turn is
   * already in flight (the renderer disables the composer then). Never throws to
   * the caller — failures land as an `error` on the assistant turn.
   *
   * `tagSessionId` focuses the turn on one session: the planner runs in that
   * repo, sees only that session's state, and defaults its actions to it. Null
   * (or an id that no longer exists) keeps the cross-repo conductor behaviour.
   *
   * `images` are files already saved by the conductor attach IPC; the planner
   * is told to Read each one (its Read tool renders images), so a screenshot
   * pasted into the chat is actually seen, not just mentioned.
   */
  async send(
    text: string,
    tagSessionId: string | null = null,
    images: ConductorImage[] = []
  ): Promise<void> {
    const trimmed = text.trim()
    // Only forward images whose files still exist (renderer state can be stale).
    const attached = (images ?? []).filter(
      (i) => i && typeof i.path === 'string' && existsSync(i.path)
    )
    if ((!trimmed && attached.length === 0) || this.busy) return
    this.busy = true

    // Only honour the tag if it still points at a real session.
    const focusId = tagSessionId && this.sessions.getConfig(tagSessionId) ? tagSessionId : null

    const userMsg: ConductorMessage = {
      id: randomUUID(),
      role: 'user',
      text: trimmed,
      at: Date.now(),
      ...(attached.length > 0 ? { images: attached } : {})
    }
    const assistantMsg: ConductorMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: '',
      at: Date.now(),
      pending: true
    }
    this.messages = [...this.messages, userMsg, assistantMsg]
    this.persistAndBroadcast()

    try {
      const snapshot = await this.buildSnapshot(focusId)
      const prompt = this.buildPrompt(snapshot, userMsg.text, focusId, attached)
      const cwd = this.plannerCwd(focusId)
      const out = await runHeadlessClaude({
        cwd,
        prompt,
        allowedTools: ALLOWED_TOOLS,
        timeoutMs: PLANNER_TIMEOUT_MS,
        onSpawn: (child) => (this.inFlight = child)
      })
      const parsed = this.parseResponse(out)
      assistantMsg.text = parsed.reply
      assistantMsg.actions = parsed.actions
      assistantMsg.pending = false
    } catch (err) {
      assistantMsg.pending = false
      assistantMsg.error = (err as Error).message || String(err)
      assistantMsg.text =
        assistantMsg.text ||
        'Sorry — I could not complete that turn. See the error below and try again.'
    } finally {
      this.inFlight = null
      this.busy = false
      this.persistAndBroadcast()
      // Let the Factory consider this completed exchange for skill/agent suggestions.
      // Fire-and-forget, only on a successful turn, and never break the turn.
      if (!assistantMsg.error) {
        try {
          this.turnCompleteCb?.(this.messages)
        } catch {
          // observer errors are not ours to surface
        }
      }
    }
  }

  /**
   * Approve and run one proposed action. For task-creating actions, `options`
   * carries the approval card's choices (base branch, model, PR/auto-merge);
   * they are applied to the created task and persisted as that repo's defaults
   * for the next proposal.
   */
  async approve(
    messageId: string,
    actionId: string,
    options?: ConductorTaskOptions
  ): Promise<void> {
    const action = this.findAction(messageId, actionId)
    if (!action || action.status !== 'proposed') return
    if (options) this.saveTaskDefaults(action, options)
    await this.runAction(action, options)
  }

  /** Persisted per-repo task-card defaults for a session, or null when none yet. */
  getTaskDefaults(sessionId: string): ConductorTaskOptions | null {
    return this.persistence.state.taskOptionDefaults?.[sessionId] ?? null
  }

  /** Approve every non-destructive proposed action on a turn, in order. */
  async approveAll(messageId: string): Promise<void> {
    const msg = this.messages.find((m) => m.id === messageId)
    if (!msg?.actions) return
    for (const action of msg.actions) {
      if (action.status === 'proposed' && action.risk !== 'destructive') {
        await this.runAction(action)
      }
    }
  }

  /** Reject one proposed action without running it. */
  reject(messageId: string, actionId: string): void {
    const action = this.findAction(messageId, actionId)
    if (!action || action.status !== 'proposed') return
    action.status = 'rejected'
    this.persistAndBroadcast()
  }

  // ---------- action execution ----------

  private findAction(messageId: string, actionId: string): ConductorAction | undefined {
    return this.messages.find((m) => m.id === messageId)?.actions?.find((a) => a.id === actionId)
  }

  /**
   * The session whose repo a task-creating action targets — where the card's
   * options apply and under which the per-repo defaults are stored.
   */
  private taskTargetSessionId(action: ConductorAction): string | null {
    const a = action.args
    if (action.kind === 'create_worktree_task') return String(a.parentSessionId ?? '') || null
    if (action.kind === 'author_feature') return String(a.sessionId ?? '') || null
    return null
  }

  /** Remember the card's choices as the defaults for that repo's next proposal. */
  private saveTaskDefaults(action: ConductorAction, options: ConductorTaskOptions): void {
    const sessionId = this.taskTargetSessionId(action)
    if (!sessionId) return
    const map = (this.persistence.state.taskOptionDefaults ??= {})
    map[sessionId] = options
    this.persistence.scheduleSave()
  }

  /**
   * The effective task options for an action: the card's explicit choices when
   * given, else the repo's persisted defaults (so Approve-all and re-approvals
   * honour the last configuration), else none (the planner's args as-is).
   */
  private taskOptionsFor(
    action: ConductorAction,
    explicit?: ConductorTaskOptions
  ): ConductorTaskOptions | undefined {
    if (explicit) return explicit
    const sessionId = this.taskTargetSessionId(action)
    return (sessionId && this.persistence.state.taskOptionDefaults?.[sessionId]) || undefined
  }

  /** Run one action by dispatching to the existing services; records the outcome. */
  private async runAction(action: ConductorAction, options?: ConductorTaskOptions): Promise<void> {
    action.status = 'running'
    action.result = undefined
    this.persistAndBroadcast()
    try {
      action.result = await this.dispatch(action, options)
      action.status = 'done'
    } catch (err) {
      action.status = 'error'
      action.result = (err as Error).message || String(err)
    }
    this.persistAndBroadcast()
  }

  /** Map one approved action to a concrete service call; returns a result line. */
  private async dispatch(action: ConductorAction, options?: ConductorTaskOptions): Promise<string> {
    const a = action.args
    switch (action.kind) {
      case 'create_session': {
        const folder = String(a.folder ?? '').trim()
        if (!folder) throw new Error('No folder given for the new session.')
        if (!existsSync(folder)) throw new Error(`Folder does not exist: ${folder}`)
        const info = this.sessions.create(folder, {
          name: a.name ? String(a.name) : undefined,
          categoryId: a.categoryId ? String(a.categoryId) : null
        })
        return `Created session “${info.config.name}” at ${folder}.`
      }
      case 'author_feature': {
        const session = this.requireSession(String(a.sessionId ?? ''))
        const feature = this.makeFeature(session.config.id, a)
        const opts = a.implement ? this.taskOptionsFor(action, options) : undefined
        if (opts) {
          // The card's PR/auto-merge choice rides on the feature into its task.
          if (opts.createPr) feature.completion = 'pr'
          if (opts.createPr || opts.autoMerge) feature.autoComplete = true
        }
        this.features.save(feature)
        if (a.implement) {
          const model = opts && opts.model !== 'inherit' ? opts.model : undefined
          const task = await this.features.implement(
            feature.id,
            opts?.baseBranch.trim() || undefined,
            model
          )
          return `Drafted “${feature.title}” and spun a task to implement it (${task.config.name}).`
        }
        return `Drafted feature “${feature.title}” with ${feature.specs.length} spec(s).`
      }
      case 'implement_feature': {
        const featureId = String(a.featureId ?? '').trim()
        if (!featureId) throw new Error('No featureId given.')
        const task = await this.features.implement(featureId)
        return `Implementing the feature in task session “${task.config.name}”.`
      }
      case 'create_worktree_task': {
        const parent = this.requireSession(String(a.parentSessionId ?? ''))
        const branch = String(a.branch ?? '').trim()
        if (!branch) throw new Error('A branch name is required.')
        const opts = this.taskOptionsFor(action, options)
        // Card choice wins over the planner's suggested base; '' = repo default
        // (resolved by createWorktreeSession to the checked-out branch).
        const baseBranch = (opts?.baseBranch.trim() || String(a.baseBranch ?? '')).trim()
        const model = opts && opts.model !== 'inherit' ? opts.model : undefined
        const task = await this.sessions.createWorktreeSession(parent.config.id, {
          name: a.name ? String(a.name) : branch,
          branch,
          baseBranch,
          initialPrompt: a.initialPrompt ? String(a.initialPrompt) : undefined,
          ...(opts?.createPr ? { completion: 'pr' as const } : {}),
          ...(opts && (opts.createPr || opts.autoMerge) ? { autoComplete: true } : {}),
          ...(model ? { model } : {})
        })
        const extras = [
          model ? `model ${model}` : '',
          opts?.createPr ? 'PR on completion' : '',
          opts?.autoMerge ? 'auto-merge when done' : ''
        ].filter(Boolean)
        return (
          `Spun task “${task.config.name}” on branch ${branch}` +
          (extras.length ? ` (${extras.join(', ')})` : '') +
          '.'
        )
      }
      case 'queue_prompt': {
        const session = this.requireSession(String(a.sessionId ?? ''))
        const text = String(a.text ?? '').trim()
        if (!text) throw new Error('No prompt text given.')
        this.sessions.queueAdd(session.config.id, text)
        return `Queued a prompt to “${session.config.name}”.`
      }
      case 'broadcast_prompt': {
        const ids = Array.isArray(a.sessionIds) ? a.sessionIds.map(String) : []
        const text = String(a.text ?? '').trim()
        if (!text) throw new Error('No prompt text given.')
        const valid = ids.filter((id) => this.sessions.getConfig(id))
        if (valid.length === 0) throw new Error('None of the given sessions exist.')
        for (const id of valid) this.sessions.queueAdd(id, text)
        return `Queued the prompt to ${valid.length} session(s).`
      }
      case 'run_auto_expand': {
        const session = this.requireSession(String(a.sessionId ?? ''))
        if (!session.config.autoExpand) {
          throw new Error(`“${session.config.name}” has no auto-expand configured.`)
        }
        this.autoExpand.runNow(session.config.id)
        return `Triggered an auto-expand run for “${session.config.name}”.`
      }
      case 'merge_worktree': {
        const session = this.requireSession(String(a.sessionId ?? ''))
        const commitFirst = a.commitFirst !== false
        const res = await this.sessions.mergeWorktree(session.config.id, commitFirst)
        if (res.ok) return `Merged “${session.config.name}”${res.pushed ? ' and pushed' : ''}.`
        if (res.conflict) return `Merge stopped on conflicts — resolve them in the parent session.`
        return `Merge did not complete: ${res.output.slice(0, 300)}`
      }
      case 'remove_worktree': {
        const session = this.requireSession(String(a.sessionId ?? ''))
        const deleteBranch = !!a.deleteBranch
        await this.sessions.removeWorktree(session.config.id, deleteBranch)
        return `Removed task “${session.config.name}”${deleteBranch ? ' and its branch' : ''}.`
      }
      default:
        throw new Error(`Unsupported action: ${action.kind}`)
    }
  }

  private requireSession(id: string): SessionInfo {
    const config = id ? this.sessions.getConfig(id) : undefined
    if (!config) throw new Error('That session no longer exists — ask me again for a fresh look.')
    return this.sessions.list().find((s) => s.config.id === id)!
  }

  private makeFeature(sessionId: string, a: Record<string, unknown>): Feature {
    const title = String(a.title ?? '').trim()
    if (!title) throw new Error('A feature title is required.')
    const specsIn = Array.isArray(a.specs) ? a.specs : []
    return {
      id: randomUUID(),
      sessionId,
      title,
      description: String(a.description ?? '').trim(),
      specs: specsIn
        .map((s) => String(s).trim())
        .filter(Boolean)
        .map((text) => ({ id: randomUUID(), text, done: false })),
      status: 'draft',
      taskSessionId: null,
      auto: false,
      createdAt: Date.now()
    }
  }

  // ---------- planner ----------

  /**
   * The repo the planner runs in: the focused session's folder when tagged,
   * else the active session's, else the app cwd.
   */
  private plannerCwd(focusId: string | null): string {
    const id = focusId ?? this.persistence.state.activeSessionId
    const cfg = id ? this.sessions.getConfig(id) : undefined
    return cfg && existsSync(cfg.folder) ? cfg.folder : process.cwd()
  }

  /**
   * Build the compact snapshot the planner reasons over. Without a focus it
   * covers every session; with one it is scoped to just that session (full
   * detail) so the chat works "into that session only".
   */
  private async buildSnapshot(focusId: string | null): Promise<unknown> {
    const activeId = this.persistence.state.activeSessionId
    const list = focusId
      ? this.sessions.list().filter((s) => s.config.id === focusId)
      : this.sessions.list()
    const sessions = await Promise.all(
      list.map(async (s) => {
        const c = s.config
        const git = await this.sessions
          .getGitStatus(c.id)
          .catch(() => null)
        const feats = this.features.list(c.id).map((f) => ({
          id: f.id,
          title: f.title,
          status: f.status,
          specs: f.specs.length,
          openSpecs: f.specs.filter((sp) => !sp.done).length
        }))
        const entry: Record<string, unknown> = {
          id: c.id,
          name: c.name,
          folder: c.folder,
          isActive: c.id === activeId,
          status: s.status,
          categoryId: c.categoryId ?? null,
          terminals: s.terminals.map((t) => ({ kind: t.config.kind, status: t.status })),
          worktree: c.worktree
            ? {
                parentSessionId: c.worktree.parentSessionId,
                branch: c.worktree.branch,
                baseBranch: c.worktree.baseBranch
              }
            : null,
          autoExpand: c.autoExpand ? { enabled: c.autoExpand.enabled, branch: c.autoExpand.branch } : null,
          git: git
            ? {
                branch: git.branch,
                ahead: git.ahead,
                behind: git.behind,
                dirty: git.staged + git.unstaged + git.untracked
              }
            : null,
          features: feats
        }
        if (c.worktree) {
          const task = await this.sessions.getWorktreeTaskState(c.id).catch(() => null)
          if (task) {
            entry.task = {
              dirty: task.dirty,
              ahead: task.ahead,
              conflictFiles: task.conflictFiles
            }
          }
        }
        return entry
      })
    )
    return focusId ? { focusedSessionId: focusId, sessions } : { sessions }
  }

  /** Compose the full planner prompt: role, action catalog, snapshot, history, ask. */
  private buildPrompt(
    snapshot: unknown,
    latest: string,
    focusId: string | null,
    images: ConductorImage[] = []
  ): string {
    const focusName = focusId ? this.sessions.getConfig(focusId)?.name : undefined
    // Recent conversation context (exclude the just-added pending assistant turn).
    const history = this.messages
      .filter((m) => !m.pending && (m.text || m.images?.length || (m.actions && m.actions.length)))
      .slice(-HISTORY_TURNS - 1, -1) // up to HISTORY_TURNS turns before the latest user msg
      .map((m) => {
        const acts =
          m.actions && m.actions.length
            ? ` [proposed: ${m.actions.map((a) => `${a.kind}(${a.status})`).join(', ')}]`
            : ''
        const imgs = m.images?.length
          ? ` [attached: ${m.images.map((i) => i.path).join(', ')}]`
          : ''
        return `${m.role.toUpperCase()}: ${m.text}${imgs}${acts}`
      })
      .join('\n')

    return [
      'You are the Conductor for Maestro, a desktop app that runs many Claude Code CLI',
      'sessions across different repositories at once. You see ALL of the user’s sessions,',
      'their git-worktree parallel tasks, and their repos, and you help the user understand',
      'and manage them through natural language.',
      '',
      'You operate in a PROPOSE-then-CONFIRM model. You NEVER perform actions yourself; you',
      'reply to the user and, when they clearly want work done, you PROPOSE actions that the',
      'user approves with a click. Use the read-only tools available to you (Read, Glob, Grep,',
      'git log/status/diff) to inspect repos before answering when it helps.',
      '',
      focusName
        ? `FOCUS: the user has tagged the session “${focusName}” (id ${focusId}). This chat is ` +
          'scoped to that session ONLY — answer about it and default every action you propose ' +
          '(sessionId, parentSessionId, etc.) to it. The snapshot below contains only that ' +
          'session. You are running inside its repo, so Read/Glob/Grep/git operate on it ' +
          'directly. Do NOT propose actions on other sessions unless the user explicitly asks.'
        : '',
      focusName
        ? `LIVE STATE SNAPSHOT (the focused session “${focusName}”; use the real id/folder from here):`
        : 'LIVE STATE SNAPSHOT (all sessions; use the real ids/folders from here):',
      '```json',
      JSON.stringify(snapshot, null, 2),
      '```',
      '',
      history ? `RECENT CONVERSATION:\n${history}\n` : '',
      `THE USER NOW SAYS:\n${latest || '(no text — see the attached images)'}`,
      images.length
        ? '\nTHE USER ATTACHED IMAGE FILE(S) — e.g. screenshots to analyze. View each one ' +
          'with the Read tool (it renders images) using these ABSOLUTE paths, BEFORE answering:\n' +
          images.map((i) => `- ${i.path}`).join('\n')
        : '',
      '',
      'Respond with EXACTLY ONE JSON object and nothing else — no markdown fences, no prose',
      'around it — shaped like:',
      '{',
      '  "reply": "<your answer to the user, in GitHub-flavored markdown>",',
      '  "actions": [ { "kind": "<one of the kinds below>",',
      '                 "summary": "<one short line describing this exact action>",',
      '                 "args": { ...kind-specific... } } ]',
      '}',
      '',
      'Use "actions": [] when the user only wants information. Only propose actions that the',
      'snapshot supports (real session ids, real folders). Action kinds and their args:',
      '',
      '- author_feature {sessionId, title, description, specs:[string], implement?:bool}',
      '    Draft a feature on a repo. Set implement:true to ALSO spin a worktree task that',
      '    builds it now (this is the usual "add feature X" path — prefer it).',
      '- implement_feature {featureId}  — implement an EXISTING draft feature from the snapshot.',
      '- create_worktree_task {parentSessionId, name, branch, baseBranch?, initialPrompt?}',
      '    A parallel git-worktree task off a repo, with claude auto-prompted by initialPrompt.',
      '- create_session {folder, name?, categoryId?}  — open a repo as a new session. Only if',
      '    you know a real absolute folder path; otherwise ASK for it in "reply" instead.',
      '- queue_prompt {sessionId, text}  — queue a prompt to a session’s claude (sent when idle).',
      '- broadcast_prompt {sessionIds:[id], text}  — queue the same prompt to several sessions.',
      '- run_auto_expand {sessionId}  — trigger the self-expanding-features pipeline once.',
      '- merge_worktree {sessionId, commitFirst?}  — merge a task branch into its base. DESTRUCTIVE.',
      '- remove_worktree {sessionId, deleteBranch?}  — delete a task’s worktree. DESTRUCTIVE.',
      '',
      'Keep destructive actions rare and clearly justified. For a feature request, prefer one',
      'author_feature with implement:true. You may propose several actions in one turn',
      '(e.g. to fan work across repos). Keep "summary" specific and human.'
    ]
      .filter((l) => l !== '')
      .join('\n')
  }

  /** Parse the planner's JSON into a reply + normalized, risk-stamped actions. */
  private parseResponse(out: string): { reply: string; actions: ConductorAction[] } {
    const parsed = extractJson(out) as { reply?: unknown; actions?: unknown } | null
    if (!parsed) {
      // No JSON at all — surface the raw text so the turn is still useful.
      return { reply: out.trim() || 'No response.', actions: [] }
    }
    const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : ''
    const rawActions = Array.isArray(parsed.actions) ? parsed.actions : []
    const actions: ConductorAction[] = []
    for (const raw of rawActions) {
      if (actions.length >= MAX_ACTIONS) break
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const kind = String(r.kind ?? '')
      if (!VALID_KINDS.has(kind)) continue
      actions.push({
        id: randomUUID(),
        kind: kind as ConductorActionKind,
        summary: String(r.summary ?? kind).trim() || kind,
        risk: RISK_BY_KIND[kind as ConductorActionKind],
        args: r.args && typeof r.args === 'object' ? (r.args as Record<string, unknown>) : {},
        status: 'proposed'
      })
    }
    return {
      reply: reply || (actions.length ? 'Here’s what I can do:' : 'No response.'),
      actions
    }
  }

  private persistAndBroadcast(): void {
    this.store.set(this.messages)
    this.broadcast()
  }

  private broadcast(): void {
    this.getWin()?.webContents.send('conductor:changed', this.messages)
  }
}
