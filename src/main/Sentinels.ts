import { BrowserWindow } from 'electron'
import { ChildProcess, execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import type { GameEvent } from '../shared/gamification'
import {
  SentinelConfig,
  SentinelFinding,
  SentinelRun,
  SentinelSeverity,
  SessionConfig
} from '../shared/types'
import { Persistence } from './Persistence'
import { resolveClaude } from './PtySession'

/** How often sessions are reconciled and git HEAD is polled for commit triggers. */
const TICK_MS = 15_000
/** A run that hasn't finished by then is killed and reported as an error. */
const RUN_TIMEOUT_MS = 5 * 60_000
const MAX_RUNS_PER_SESSION = 50

/**
 * Read-only tools the headless agent may use without prompting. Anything else
 * (writes, other shell commands) is denied by claude's -p permission model.
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
  'Bash(git blame:*)',
  'Bash(git rev-parse:*)',
  'Bash(gh pr list:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)'
].join(',')

const SEVERITIES: SentinelSeverity[] = ['info', 'warning', 'critical']

/** Resolve the current HEAD sha of a folder; null when not a repo / git missing. */
function gitHead(folder: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: folder, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim() || null)
    )
  })
}

/**
 * Runs the sentinels configured on sessions: watches their triggers (new
 * commits on the session folder's HEAD, or a timer) and executes each fired
 * sentinel as a headless read-only `claude -p` in the session's folder.
 * Run history is in-memory only; the renderer is kept in sync via the
 * 'sentinel:runs' broadcast.
 */
export class SentinelService {
  private timer: NodeJS.Timeout | null = null
  /** Last observed HEAD per session id; baseline is set without firing. */
  private heads = new Map<string, string>()
  /** Sessions with a HEAD poll currently in flight (skip re-entry). */
  private polling = new Set<string>()
  /** Next scheduled run (ms epoch) per interval-sentinel id. */
  private nextRunAt = new Map<string, number>()
  /** Sentinel ids with a run in flight, mapped to the child for dispose(). */
  private running = new Map<string, ChildProcess | null>()
  private runs = new Map<string, SentinelRun[]>()

  constructor(
    private persistence: Persistence,
    private getWin: () => BrowserWindow | null,
    private emitGame: (e: GameEvent) => void = () => {}
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

  listRuns(sessionId: string): SentinelRun[] {
    return this.runs.get(sessionId) ?? []
  }

  /** Manual trigger from the UI; runs even when the sentinel is disabled. */
  runNow(sessionId: string, sentinelId: string): void {
    const session = this.persistence.state.sessions.find((s) => s.id === sessionId)
    const sentinel = session?.sentinels?.find((s) => s.id === sentinelId)
    if (!session || !sentinel) return
    this.execute(session, sentinel, 'manual')
  }

  /**
   * One reconcile pass over the persisted sessions: poll HEAD where commit
   * sentinels exist, fire due interval sentinels, and drop runtime state for
   * sessions/sentinels that no longer exist. Driven by configuration alone,
   * so saves via the ordinary session-update path need no extra wiring.
   */
  private tick(): void {
    const sessions = this.persistence.state.sessions
    const liveSessionIds = new Set(sessions.map((s) => s.id))
    const liveSentinelIds = new Set(sessions.flatMap((s) => (s.sentinels ?? []).map((x) => x.id)))
    for (const id of [...this.heads.keys()]) {
      if (!liveSessionIds.has(id)) {
        this.heads.delete(id)
        this.runs.delete(id)
      }
    }
    for (const id of [...this.nextRunAt.keys()]) {
      if (!liveSentinelIds.has(id)) this.nextRunAt.delete(id)
    }

    for (const session of sessions) {
      const enabled = (session.sentinels ?? []).filter((s) => s.enabled)
      if (enabled.length === 0) continue
      if (enabled.some((s) => s.trigger === 'commit')) void this.pollHead(session, enabled)
      const now = Date.now()
      for (const sentinel of enabled.filter((s) => s.trigger === 'interval')) {
        const due = this.nextRunAt.get(sentinel.id)
        const intervalMs = Math.max(1, sentinel.intervalMinutes ?? 15) * 60_000
        if (due === undefined) {
          // First sighting (just created, or app start): run right away so the
          // user gets immediate feedback, then settle into the cadence.
          this.nextRunAt.set(sentinel.id, now + intervalMs)
          this.execute(session, sentinel, 'interval')
        } else if (now >= due) {
          this.nextRunAt.set(sentinel.id, now + intervalMs)
          this.execute(session, sentinel, 'interval')
        }
      }
    }
  }

  /** Detect a HEAD move since the last tick and fire the commit sentinels. */
  private async pollHead(session: SessionConfig, enabled: SentinelConfig[]): Promise<void> {
    if (this.polling.has(session.id) || !existsSync(session.folder)) return
    this.polling.add(session.id)
    try {
      const head = await gitHead(session.folder)
      if (!head) return
      const previous = this.heads.get(session.id)
      this.heads.set(session.id, head)
      // First observation is a baseline only — don't review history on startup.
      if (!previous || previous === head) return
      const reason = `commits ${previous.slice(0, 7)} → ${head.slice(0, 7)}`
      for (const sentinel of enabled.filter((s) => s.trigger === 'commit')) {
        this.execute(session, sentinel, reason, { from: previous, to: head })
      }
    } finally {
      this.polling.delete(session.id)
    }
  }

  /** Spawn one headless run; results land in the run list + broadcast. */
  private execute(
    session: SessionConfig,
    sentinel: SentinelConfig,
    reason: string,
    range?: { from: string; to: string }
  ): void {
    if (this.running.has(sentinel.id)) return // one run per sentinel at a time
    const run: SentinelRun = {
      id: randomUUID(),
      sentinelId: sentinel.id,
      sessionId: session.id,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      reason,
      summary: '',
      findings: []
    }
    this.pushRun(run)

    const claude = resolveClaude()
    if (!claude) {
      this.finishRun(run, 'error', 'claude CLI not found on PATH.', [])
      return
    }

    this.running.set(sentinel.id, null)
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
      this.running.delete(sentinel.id)
      this.finishRun(run, 'error', `Failed to start claude: ${String(err)}`, [])
      return
    }
    this.running.set(sentinel.id, child)

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdin?.write(buildPrompt(sentinel, session, reason, range))
    child.stdin?.end()

    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }, RUN_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timeout)
      this.running.delete(sentinel.id)
      this.finishRun(run, 'error', `Failed to run claude: ${String(err)}`, [])
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      this.running.delete(sentinel.id)
      if (run.finishedAt !== null) return // 'error' event already finished it
      if (code !== 0 && !stdout.trim()) {
        const detail = stderr.trim() || `claude exited with code ${code}`
        this.finishRun(run, 'error', detail.slice(0, 500), [])
        return
      }
      const { summary, findings, error } = parseAgentOutput(stdout)
      if (error) this.finishRun(run, 'error', error, [])
      else this.finishRun(run, findings.length > 0 ? 'findings' : 'ok', summary, findings)
    })
  }

  private pushRun(run: SentinelRun): void {
    const list = this.runs.get(run.sessionId) ?? []
    list.unshift(run)
    if (list.length > MAX_RUNS_PER_SESSION) list.length = MAX_RUNS_PER_SESSION
    this.runs.set(run.sessionId, list)
    this.broadcast(run.sessionId)
  }

  private finishRun(
    run: SentinelRun,
    status: SentinelRun['status'],
    summary: string,
    findings: SentinelFinding[]
  ): void {
    run.finishedAt = Date.now()
    run.status = status
    run.summary = summary
    run.findings = findings
    this.broadcast(run.sessionId)
    if (status !== 'error') this.emitGame({ type: 'sentinel.run' })
  }

  private broadcast(sessionId: string): void {
    this.getWin()?.webContents.send('sentinel:runs', sessionId, this.listRuns(sessionId))
  }
}

/** The full prompt for one run: identity + trigger context + user instructions + output contract. */
function buildPrompt(
  sentinel: SentinelConfig,
  session: SessionConfig,
  reason: string,
  range?: { from: string; to: string }
): string {
  const lines = [
    `You are "${sentinel.name}", an automated read-only sentinel agent watching the git repository at ${session.folder}.`,
    'You run unattended in the background of a developer session — nobody can answer questions.',
    `Trigger for this run: ${reason}.`
  ]
  if (range) {
    lines.push(
      `New commits arrived since the last check. Inspect exactly that range first: ` +
        `\`git log ${range.from}..${range.to}\` and \`git diff ${range.from}..${range.to}\`.`
    )
  }
  lines.push(
    '',
    'Your watch instructions:',
    sentinel.prompt,
    '',
    'Rules:',
    '- You only have read access (files, git history, gh pull-request info). Never attempt to modify anything.',
    '- Report only genuine, actionable findings. An empty findings list is a perfectly good outcome.',
    '- Keep each title short; put the reasoning and file references in detail.',
    '',
    'Respond with ONLY one JSON object — no markdown fences, no prose around it — shaped exactly like:',
    '{"summary": "<1-2 sentences: what you checked and the overall verdict>",',
    ' "findings": [{"severity": "info"|"warning"|"critical", "title": "<short>", "detail": "<what, why, where>", "file": "<repo-relative path, omit if none>"}]}'
  )
  return lines.join('\n')
}

/**
 * Unwrap `claude -p --output-format json` stdout (envelope with a `result`
 * string) and parse the agent's JSON verdict out of it, tolerating fences or
 * stray prose. Falls back to treating the raw text as the summary.
 */
function parseAgentOutput(stdout: string): {
  summary: string
  findings: SentinelFinding[]
  error?: string
} {
  let text = stdout.trim()
  try {
    const envelope = JSON.parse(text) as { result?: string; is_error?: boolean; subtype?: string }
    if (typeof envelope.result === 'string') {
      if (envelope.is_error) return { summary: '', findings: [], error: envelope.result.slice(0, 500) }
      text = envelope.result.trim()
    }
  } catch {
    // Not the JSON envelope (older CLI?) — treat stdout as the agent's text.
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const verdict = JSON.parse(text.slice(start, end + 1)) as {
        summary?: unknown
        findings?: unknown
      }
      const findings: SentinelFinding[] = (Array.isArray(verdict.findings) ? verdict.findings : [])
        .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
        .map((f) => ({
          severity: SEVERITIES.includes(f.severity as SentinelSeverity)
            ? (f.severity as SentinelSeverity)
            : 'info',
          title: String(f.title ?? 'Finding'),
          detail: String(f.detail ?? ''),
          ...(typeof f.file === 'string' && f.file ? { file: f.file } : {})
        }))
      return {
        summary: typeof verdict.summary === 'string' ? verdict.summary : '',
        findings
      }
    } catch {
      // fall through to raw-text fallback
    }
  }
  if (!text) return { summary: '', findings: [], error: 'The agent produced no output.' }
  return { summary: text.slice(0, 500), findings: [] }
}
