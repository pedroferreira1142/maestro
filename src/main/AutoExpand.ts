import { BrowserWindow } from 'electron'
import { ChildProcess, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import {
  AutoExpandConfig,
  AutoExpandIdea,
  AutoExpandRun,
  Feature,
  SessionConfig
} from '../shared/types'
import { FeatureService } from './FeatureService'
import * as Git from './GitService'
import { Persistence } from './Persistence'
import { resolveClaude } from './PtySession'

/** How often configured sessions are reconciled and due runs fired. */
const TICK_MS = 30_000
/** An agent phase that hasn't finished by then is killed and the run errors. */
const AGENT_TIMEOUT_MS = 5 * 60_000
const MAX_RUNS_PER_SESSION = 30
const IDEA_COUNT = 4

/**
 * Read-only tools the headless idea/evaluator agents may use. Writes never
 * happen here — implementation runs in an ordinary worktree task session.
 */
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(git branch:*)',
  'Bash(git rev-parse:*)'
].join(',')

/**
 * Runs the self-expanding-features pipeline on sessions that enabled it: on a
 * timer (or manual trigger), an idea agent proposes feature ideas for the
 * repo, an evaluator agent picks the best one and writes it up as specs, and
 * the result is implemented through FeatureService as a worktree task session
 * branched off the session's dedicated expansion branch. Run history is
 * in-memory; the renderer is kept in sync via the 'autoexpand:runs' broadcast.
 */
export class AutoExpandService {
  private timer: NodeJS.Timeout | null = null
  /** Next scheduled run (ms epoch) per session id. */
  private nextRunAt = new Map<string, number>()
  /** Session ids with a pipeline in flight, mapped to the current agent child. */
  private running = new Map<string, ChildProcess | null>()
  private runs = new Map<string, AutoExpandRun[]>()

  constructor(
    private persistence: Persistence,
    private features: FeatureService,
    private getWin: () => BrowserWindow | null
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const child of this.running.values()) {
      try {
        child?.kill()
      } catch {
        // already gone
      }
    }
    this.running.clear()
  }

  listRuns(sessionId: string): AutoExpandRun[] {
    return this.runs.get(sessionId) ?? []
  }

  /** Manual trigger from the UI; runs even when auto-expand is disabled. */
  runNow(sessionId: string): void {
    const session = this.persistence.state.sessions.find((s) => s.id === sessionId)
    if (!session?.autoExpand) return
    void this.execute(session, session.autoExpand, 'manual')
  }

  /**
   * Create the session's expansion branch (if missing) and publish it to the
   * remote so it shows up on the host (e.g. GitHub). Called when the user
   * enables/saves auto-expand, so the branch appears immediately rather than
   * only when the first run fires. Best-effort and idempotent.
   */
  async prepareBranch(sessionId: string): Promise<void> {
    const session = this.persistence.state.sessions.find((s) => s.id === sessionId)
    const cfg = session?.autoExpand
    if (!session || !cfg?.enabled || !cfg.branch) return
    if (!existsSync(session.folder)) return
    const info = await Git.worktreeInfo(session.folder)
    if (!info.isRepo || !info.repoRoot) return
    await Git.ensureBranch(info.repoRoot, cfg.branch)
    try {
      await Git.publishBranch(info.repoRoot, cfg.branch)
    } catch {
      // offline / no remote / auth — the branch still exists locally
    }
  }

  /**
   * One reconcile pass: schedule/fire due sessions and drop runtime state for
   * sessions that no longer exist or disabled the pipeline. Driven purely by
   * the persisted config, so saves via the ordinary session-update path need
   * no extra wiring. The first sighting of an enabled config only schedules
   * (interval from now) — pipeline runs spend real tokens, so nothing fires
   * just because the app started; "Run now" covers the impatient case.
   */
  private tick(): void {
    const sessions = this.persistence.state.sessions
    const liveIds = new Set(sessions.map((s) => s.id))
    for (const id of [...this.nextRunAt.keys()]) {
      if (!liveIds.has(id)) {
        this.nextRunAt.delete(id)
        this.runs.delete(id)
      }
    }

    const now = Date.now()
    for (const session of sessions) {
      const cfg = session.autoExpand
      if (!cfg?.enabled) {
        this.nextRunAt.delete(session.id)
        continue
      }
      const intervalMs = Math.max(1, cfg.intervalMinutes) * 60_000
      const due = this.nextRunAt.get(session.id)
      if (due === undefined) {
        this.nextRunAt.set(session.id, now + intervalMs)
      } else if (now >= due) {
        this.nextRunAt.set(session.id, now + intervalMs)
        void this.execute(session, cfg, 'interval')
      }
    }
  }

  /** The whole pipeline for one run: ideate → evaluate → implement. */
  private async execute(
    session: SessionConfig,
    cfg: AutoExpandConfig,
    reason: string
  ): Promise<void> {
    if (this.running.has(session.id)) return // one pipeline per session at a time

    const run: AutoExpandRun = {
      id: randomUUID(),
      sessionId: session.id,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      phase: 'ideating',
      reason,
      ideas: [],
      chosenTitle: null,
      verdict: '',
      featureId: null,
      taskSessionId: null
    }

    // Reconcile stale state first: a feature stuck in 'implementing' whose task
    // session was merged or removed (its taskSessionId no longer resolves to a
    // live session) is not actually in flight. Without this, such features pile
    // up and block the throttle forever — "N still implementing" with nothing to
    // merge. Flip them to 'merged' so they stop counting.
    const liveIds = new Set(this.persistence.state.sessions.map((s) => s.id))
    for (const f of this.features.list(session.id)) {
      if (
        f.auto &&
        f.status === 'implementing' &&
        (!f.taskSessionId || !liveIds.has(f.taskSessionId))
      ) {
        f.status = 'merged'
        this.features.save(f)
      }
    }

    // Throttle: don't pile up auto tasks faster than they get merged/reviewed.
    const inFlight = this.features
      .list(session.id)
      .filter((f) => f.auto && f.status === 'implementing').length
    if (inFlight >= Math.max(1, cfg.maxConcurrent)) {
      run.status = 'skipped'
      run.finishedAt = Date.now()
      run.verdict = `${inFlight} auto feature(s) still implementing (limit ${cfg.maxConcurrent}) — merge or remove them first.`
      this.pushRun(run)
      return
    }

    this.pushRun(run)
    this.running.set(session.id, null)
    try {
      if (!existsSync(session.folder)) throw new Error('The session folder no longer exists.')
      const info = await Git.worktreeInfo(session.folder)
      if (!info.isRepo || !info.repoRoot) {
        throw new Error('This session’s folder is not a git repository.')
      }
      // The expansion branch the user named: created from HEAD when missing,
      // never checked out — the user's working tree stays untouched. Publish it
      // so it's visible on the remote (e.g. GitHub); best-effort if offline.
      await Git.ensureBranch(info.repoRoot, cfg.branch)
      try {
        await Git.publishBranch(info.repoRoot, cfg.branch)
      } catch {
        // offline / no remote — keep going; the branch exists locally
      }

      // Phase 1 — idea agent proposes candidate features.
      const existingTitles = this.features.list(session.id).map((f) => f.title)
      const ideasText = await this.runAgent(
        session,
        ideaPrompt(session, cfg, existingTitles)
      )
      run.ideas = parseIdeas(ideasText)
      if (run.ideas.length === 0) {
        throw new Error(`The idea agent returned no usable ideas: ${ideasText.slice(0, 300)}`)
      }
      run.phase = 'evaluating'
      this.broadcast(session.id)

      // Phase 2 — evaluator picks the best idea and writes the specs.
      const verdictText = await this.runAgent(session, evaluatorPrompt(cfg, run.ideas))
      const winner = parseVerdict(verdictText, run.ideas)
      run.chosenTitle = winner.title
      run.verdict = winner.verdict
      run.phase = 'implementing'
      this.broadcast(session.id)

      // Phase 3 — persist the feature and implement it the ordinary way:
      // a worktree task session branched off (and merging back into) cfg.branch.
      const feature: Feature = {
        id: randomUUID(),
        sessionId: session.id,
        title: winner.title,
        description: winner.description,
        specs: winner.specs.map((text) => ({ id: randomUUID(), text, done: false })),
        status: 'draft',
        taskSessionId: null,
        auto: true,
        createdAt: Date.now()
      }
      this.features.save(feature)
      run.featureId = feature.id
      const taskSession = await this.features.implement(feature.id, cfg.branch)
      run.taskSessionId = taskSession.config.id

      run.phase = 'done'
      this.finishRun(run, 'done')
    } catch (err) {
      run.verdict = (err as Error).message || String(err)
      this.finishRun(run, 'error')
    } finally {
      this.running.delete(session.id)
    }
  }

  /**
   * One headless, read-only `claude -p` in the session's folder; resolves with
   * the agent's result text. Rejects on spawn failure, timeout, or empty output.
   */
  private runAgent(session: SessionConfig, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const claude = resolveClaude()
      if (!claude) {
        reject(new Error('claude CLI not found on PATH.'))
        return
      }
      const args = [
        ...claude.argsPrefix,
        '-p',
        '--output-format',
        'json',
        '--allowedTools',
        ALLOWED_TOOLS
      ]
      let child: ChildProcess
      try {
        child = spawn(claude.file, args, {
          cwd: session.folder,
          env: process.env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (err) {
        reject(new Error(`Failed to start claude: ${String(err)}`))
        return
      }
      this.running.set(session.id, child)

      let stdout = ''
      let stderr = ''
      let timedOut = false
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
      child.stdin?.write(prompt)
      child.stdin?.end()

      const timeout = setTimeout(() => {
        timedOut = true
        try {
          child.kill()
        } catch {
          // already gone
        }
      }, AGENT_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`Failed to run claude: ${String(err)}`))
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        if (timedOut) {
          reject(new Error('The agent timed out after 5 minutes.'))
          return
        }
        if (code !== 0 && !stdout.trim()) {
          reject(new Error((stderr.trim() || `claude exited with code ${code}`).slice(0, 500)))
          return
        }
        const text = unwrapResult(stdout)
        if (text instanceof Error) reject(text)
        else resolve(text)
      })
    })
  }

  private pushRun(run: AutoExpandRun): void {
    const list = this.runs.get(run.sessionId) ?? []
    list.unshift(run)
    if (list.length > MAX_RUNS_PER_SESSION) list.length = MAX_RUNS_PER_SESSION
    this.runs.set(run.sessionId, list)
    this.broadcast(run.sessionId)
  }

  private finishRun(run: AutoExpandRun, status: AutoExpandRun['status']): void {
    run.finishedAt = Date.now()
    run.status = status
    this.broadcast(run.sessionId)
  }

  private broadcast(sessionId: string): void {
    this.getWin()?.webContents.send('autoexpand:runs', sessionId, this.listRuns(sessionId))
  }
}

/** Prompt for the idea agent: study the repo and propose candidate features. */
function ideaPrompt(
  session: SessionConfig,
  cfg: AutoExpandConfig,
  existingTitles: string[]
): string {
  const lines = [
    `You are an automated product-ideation agent for the repository at ${session.folder}.`,
    'You run unattended — nobody can answer questions.',
    '',
    'Study the repo first: README/docs, the code structure, and recent git history,',
    'to understand what this project is, who uses it, and where it is heading.',
    '',
    `Then propose exactly ${IDEA_COUNT} NEW feature ideas for it. Each idea must be:`,
    '- genuinely useful to this project’s users (no toy features, no busywork),',
    '- implementable by one developer in roughly a day inside this codebase,',
    '- self-contained (no external accounts, paid services, or new infrastructure),',
    '- clearly distinct from the other ideas and from the existing features below.'
  ]
  if (existingTitles.length > 0) {
    lines.push('', 'Features that already exist or are planned (do NOT repropose these):')
    lines.push(...existingTitles.map((t) => `- ${t}`))
  }
  if (cfg.guidance.trim()) {
    lines.push('', 'Steering from the user (follow it):', cfg.guidance.trim())
  }
  lines.push(
    '',
    'Respond with ONLY one JSON object — no markdown fences, no prose around it — shaped exactly like:',
    '{"ideas": [{"title": "<short feature name>",',
    '            "description": "<2-4 sentences: what it does and how it roughly works here>",',
    '            "rationale": "<1-2 sentences: why this repo’s users want it>"}]}'
  )
  return lines.join('\n')
}

/** Prompt for the evaluator agent: pick the best idea and write its specs. */
function evaluatorPrompt(cfg: AutoExpandConfig, ideas: AutoExpandIdea[]): string {
  const lines = [
    'You are an automated feature-evaluation agent for the repository in the current directory.',
    'You run unattended — nobody can answer questions.',
    '',
    'An ideation agent proposed these candidate features:',
    JSON.stringify({ ideas }, null, 2),
    '',
    'Verify each idea against the actual codebase (read the relevant files), then pick the',
    'SINGLE best one, judged by: value to users, fit with the existing architecture,',
    'feasibility in about a day of work, and risk of breaking existing behavior.',
    'Reject ideas that already exist in the code or that the codebase makes impractical.'
  ]
  if (cfg.guidance.trim()) {
    lines.push('', 'Steering from the user (weigh it heavily):', cfg.guidance.trim())
  }
  lines.push(
    '',
    'For the winning idea, write the feature up for a developer agent that will implement',
    'it without further context: a refined description and 4-8 concrete, testable specs',
    '(each one observable behavior, not an implementation step).',
    '',
    'Respond with ONLY one JSON object — no markdown fences, no prose around it — shaped exactly like:',
    '{"chosenTitle": "<title of the winning idea>",',
    ' "verdict": "<2-3 sentences: why this idea won over the others>",',
    ' "feature": {"title": "<final feature title>",',
    '             "description": "<refined description, mentioning the key files/components involved>",',
    '             "specs": ["<spec 1>", "<spec 2>", "..."]}}'
  )
  return lines.join('\n')
}

/**
 * Unwrap `claude -p --output-format json` stdout (envelope with a `result`
 * string). Returns the agent's text, or an Error for an error envelope /
 * empty output.
 */
function unwrapResult(stdout: string): string | Error {
  let text = stdout.trim()
  try {
    const envelope = JSON.parse(text) as { result?: string; is_error?: boolean }
    if (typeof envelope.result === 'string') {
      if (envelope.is_error) return new Error(envelope.result.slice(0, 500))
      text = envelope.result.trim()
    }
  } catch {
    // Not the JSON envelope (older CLI?) — treat stdout as the agent's text.
  }
  if (!text) return new Error('The agent produced no output.')
  return text
}

/** Extract the outermost JSON object from agent text, tolerating fences/prose. */
function extractJson(text: string): unknown | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Parse the idea agent's output into a clean idea list (drops malformed entries). */
function parseIdeas(text: string): AutoExpandIdea[] {
  const parsed = extractJson(text) as { ideas?: unknown } | null
  if (!parsed || !Array.isArray(parsed.ideas)) return []
  return parsed.ideas
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .map((i) => ({
      title: String(i.title ?? '').trim(),
      description: String(i.description ?? '').trim(),
      rationale: String(i.rationale ?? '').trim()
    }))
    .filter((i) => i.title && i.description)
}

interface Winner {
  title: string
  description: string
  specs: string[]
  verdict: string
}

/**
 * Parse the evaluator's output. Falls back to the first proposed idea (with
 * its description as the only spec context) when the evaluator's feature
 * block is malformed — a slightly thin spec beats a dead pipeline.
 */
function parseVerdict(text: string, ideas: AutoExpandIdea[]): Winner {
  const parsed = extractJson(text) as {
    chosenTitle?: unknown
    verdict?: unknown
    feature?: { title?: unknown; description?: unknown; specs?: unknown }
  } | null
  const feature = parsed?.feature
  const specs = Array.isArray(feature?.specs)
    ? feature.specs.map((s) => String(s).trim()).filter(Boolean)
    : []
  const title = String(feature?.title ?? parsed?.chosenTitle ?? '').trim()
  if (title && specs.length > 0) {
    return {
      title,
      description: String(feature?.description ?? '').trim(),
      specs,
      verdict: String(parsed?.verdict ?? '').trim()
    }
  }
  const fallback = ideas[0]
  return {
    title: fallback.title,
    description: fallback.description,
    specs: [fallback.description],
    verdict: 'Evaluator output was malformed — fell back to the first proposed idea.'
  }
}
