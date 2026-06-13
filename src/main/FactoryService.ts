import { BrowserWindow, shell } from 'electron'
import { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import {
  ConductorMessage,
  FactoryArtifact,
  FactoryArtifactKind,
  FactoryAudit,
  FactoryCandidate,
  FactoryLesson,
  FactoryRun,
  FactorySource,
  FactoryState,
  FactorySuggestion
} from '../shared/types'
import { readUserMcpServers, scanSkills } from './ClaudeEnv'
import {
  deleteArtifactFile,
  listInstalled,
  scanAgents,
  slugify,
  writeAgent,
  writeSkill
} from './FactoryWriter'
import { FactoryStore } from './FactoryStore'
import { extractJson, runHeadlessClaude } from './HeadlessClaude'

/** No tools needed — the agent enumerates the MCP servers from its own tool list. */
const DISCOVER_TIMEOUT_MS = 60_000
/** A scan reads from the source (MCP calls are slow), so give it room. */
const SCAN_TIMEOUT_MS = 5 * 60_000
/** Authoring reads the source material and writes a full artifact file. */
const AUTHOR_TIMEOUT_MS = 6 * 60_000

const MAX_CANDIDATES = 8
const MAX_RUNS = 25
/** Bound the backlog/lessons so the snapshot fed back to the agent stays small. */
const MAX_TOPICS = 60
const MAX_LESSONS = 40

// ---- self-growth (suggestions: conversation detector + background timer) ----
/** Coarse scheduler tick. */
const TICK_MS = 60_000
/** Token-spending auto-propose cadence (scans ONE MCP source per pass). */
const AUTO_PROPOSE_INTERVAL_MS = 6 * 60 * 60_000
/** Quiet window after launch before any token-spending auto-propose may run, so
 *  reopening the app after a long gap never fires a headless scan right at boot. */
const AUTO_PROPOSE_BOOT_GRACE_MS = 10 * 60_000
/** Collapse a burst of conductor turns into one judge call. */
const DETECT_DEBOUNCE_MS = 4_000
/** A conversation judge is short (no source tools). */
const DETECT_TIMEOUT_MS = 45_000
/** Don't judge until at least this many turns happened (skip idle chit-chat)… */
const MIN_TURNS_SINCE_DETECT = 3
/** …unless this long has passed since the last judge. */
const DETECT_MIN_INTERVAL_MS = 20 * 60_000
/** How many recent conductor turns the judge reads. */
const DETECT_HISTORY_TURNS = 6
/** Largest chat excerpt (chars) carried on a suggestion for later authoring. */
const DETECT_CONTEXT_MAX = 6000
/** Drop conversation suggestions below this confidence. */
const MIN_CONFIDENCE = 0.6
/** Cap suggestions absorbed from a single judge call. */
const MAX_SUGGESTIONS_PER_DETECT = 2
/** Daily cap on conversation judge calls (token budget). */
const JUDGE_DAILY_CAP = 12
/** Total persisted suggestions (open + history) before oldest terminal ones are pruned. */
const MAX_SUGGESTIONS = 60

/** Local YYYY-M-D key for the daily judge-call budget. */
function localDay(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** Friendlier labels for well-known connector server keys (best-effort). */
const KNOWN_LABELS: Record<string, string> = {
  claude_ai_Atlassian: 'Atlassian (Confluence / Jira)',
  claude_ai_Figma: 'Figma',
  claude_ai_Microsoft_365: 'Microsoft 365',
  github: 'GitHub'
}

/**
 * The Agent & Skill Factory: mines a connected MCP context (Confluence/Jira via
 * Atlassian, GitHub, Figma, …) and generates reusable Claude skills and
 * sub-agents from it. It follows the same propose→confirm + headless-`claude -p`
 * model as AutoExpand/Conductor: a scan agent proposes candidates, the user
 * approves one, an author agent writes the full artifact content, and MAIN
 * writes the file to ~/.claude (the agent never writes to disk itself). A
 * self-extending registry (artifacts + connection map + topics-to-pursue
 * backlog + lessons) is persisted via FactoryStore; the renderer is kept in sync
 * via the 'factory:changed' / 'factory:runs' broadcasts.
 */
export class FactoryService {
  private store = new FactoryStore()
  private state: FactoryState
  private runs: FactoryRun[] = []
  private sources: FactorySource[] | null = null
  /** The in-flight cancellable agent child (scan/author/judge), so dispose()/cancel() can kill it. */
  private inFlight: ChildProcess | null = null
  /** Source-discovery child — a SEPARATE slot from `inFlight` so discovery (which
   *  can run while `busy` is false) never nulls a live scan/author/judge child. */
  private discoverChild: ChildProcess | null = null
  /** In-flight discovery promise; concurrent callers join it instead of spawning
   *  a second discovery agent (the single-headless-child invariant). */
  private discovering: Promise<FactorySource[]> | null = null
  private busy = false
  /** Resolves when the current heavy op (scan/author/judge) releases the lock —
   *  the public listSources() awaits it before starting a discovery agent so the
   *  two never run concurrently. Null while idle. */
  private busyPromise: Promise<void> | null = null
  private busyResolve: (() => void) | null = null
  /** Set by cancel(); the in-flight scan/author reports 'cancelled' instead of 'error'. */
  private cancelRequested = false
  /** Self-growth background timer; null until start(). */
  private timer: NodeJS.Timeout | null = null
  /** Debounce timer for the conversation detector. */
  private detectTimer: NodeJS.Timeout | null = null
  /** Claimed synchronously while an auto-propose pass is dispatched (incl. its
   *  pre-scan discovery await), so the 60s timer can't double-dispatch it. */
  private autoProposing = false

  constructor(private getWin: () => BrowserWindow | null) {
    this.state = this.store.load()
    this.runs = restoreRuns(this.store.loadRuns())
    // A suggestion caught mid-create when the app closed is settled back to 'open'.
    for (const s of this.state.suggestions) {
      if (s.status === 'creating') {
        s.status = 'open'
        s.result = undefined
      }
    }
  }

  getState(): FactoryState {
    return this.state
  }

  listRuns(): FactoryRun[] {
    return this.runs
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.detectTimer) clearTimeout(this.detectTimer)
    this.detectTimer = null
    try {
      this.inFlight?.kill()
    } catch {
      // already gone
    }
    try {
      this.discoverChild?.kill()
    } catch {
      // already gone
    }
    this.inFlight = null
    this.discoverChild = null
    this.store.saveNow()
  }

  // ---------- self-growth: background timer ----------

  /** Begin the self-growth loop: an infrequent token-spending auto-propose pass. */
  start(): void {
    if (this.timer) return
    // Defer the first auto-propose to at least AUTO_PROPOSE_BOOT_GRACE_MS after
    // launch. `lastAutoProposeAt` defaults to 0, so without this a launch after
    // any >6h gap (incl. a fresh install) would fire a headless scan ~60s in,
    // with no user action. Clamp the baseline forward so the gate can't open
    // until the grace window has elapsed, while preserving a recent pass time.
    const g = this.store.loadGrowth()
    const earliest = Date.now() - AUTO_PROPOSE_INTERVAL_MS + AUTO_PROPOSE_BOOT_GRACE_MS
    if (g.lastAutoProposeAt < earliest) {
      this.store.setGrowth({ ...g, lastAutoProposeAt: earliest })
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  private tick(): void {
    if (this.busy || this.autoProposing) return
    const g = this.store.loadGrowth()
    if (Date.now() - g.lastAutoProposeAt >= AUTO_PROPOSE_INTERVAL_MS) {
      void this.autoProposePass().catch(() => {})
    }
  }

  /**
   * Infrequent token-spending pass: scan the connected MCP source that's gone
   * longest without a scan (round-robin), then convert that scan's proposed
   * candidates into suggestions (never auto-installed). A dedicated
   * `autoProposing` guard (claimed synchronously) prevents a second tick from
   * dispatching while this one is parked in discovery; the budget/rotation slot
   * is only consumed when a scan actually runs, and we harvest exactly the run
   * this pass produced (never a stale older one).
   */
  private async autoProposePass(): Promise<void> {
    if (this.busy || this.autoProposing) return
    this.autoProposing = true
    try {
      const sources = await this.listSources().catch(() => [] as FactorySource[])
      if (sources.length === 0) return
      const g = this.store.loadGrowth()
      const next = [...sources].sort(
        (a, b) => (g.lastScannedAt[a.server] ?? 0) - (g.lastScannedAt[b.server] ?? 0)
      )[0]
      const runId = await this.scan(
        next.server,
        'Automated background scan: surface only a few high-value, clearly groundable candidates.'
      )
      // scan() returns null when it bailed on the busy guard (no tokens spent) —
      // only consume the rotation slot + 6h budget when a scan really ran.
      if (!runId) return
      const g2 = this.store.loadGrowth()
      this.store.setGrowth({
        ...g2,
        lastScannedAt: { ...g2.lastScannedAt, [next.server]: Date.now() },
        lastAutoProposeAt: Date.now()
      })
      const run = this.runs.find((r) => r.id === runId)
      if (run && run.status === 'done') this.absorbScanSuggestions(run)
    } finally {
      this.autoProposing = false
    }
  }

  private absorbScanSuggestions(run: FactoryRun): void {
    let newest: FactorySuggestion | null = null
    let added = 0
    for (const c of run.candidates) {
      if (c.status !== 'proposed') continue
      if (this.suggestionDuplicate(c.kind, c.name, c.description)) continue
      newest = this.enqueueSuggestion({
        suggestedKind: c.kind,
        name: c.name,
        title: c.description,
        description: c.description,
        rationale: c.rationale,
        origin: 'scan',
        sourceRef: run.source,
        sourceLabel: run.sourceLabel,
        source: run.source,
        context: run.summary,
        topics: c.topics,
        keywords: c.keywords,
        existing: c.existing,
        confidence: 0.8
      })
      added++
    }
    if (added > 0) {
      this.persist()
      if (newest) this.getWin()?.webContents.send('factory:suggestion', newest)
    }
  }

  // ---------- self-growth: conversation detector ----------

  /**
   * Called (fire-and-forget) after each completed Conductor turn. Debounced and
   * heavily rate-limited; schedules a short headless judge that may queue
   * skill/agent suggestions. Never blocks or throws into the caller.
   */
  considerConversation(messages: ConductorMessage[]): void {
    const g = this.store.loadGrowth()
    this.store.setGrowth({ ...g, turnsSinceDetect: (g.turnsSinceDetect ?? 0) + 1 })
    if (this.detectTimer) clearTimeout(this.detectTimer)
    this.detectTimer = setTimeout(() => {
      this.detectTimer = null
      void this.maybeRunJudge(messages).catch(() => {})
    }, DETECT_DEBOUNCE_MS)
  }

  private async maybeRunJudge(messages: ConductorMessage[]): Promise<void> {
    // Also bail while a discovery is in flight: discovery is its own headless
    // child outside the `busy` lock, and we keep to one agent at a time.
    if (this.busy || this.discovering) return
    const g = this.store.loadGrowth()
    const now = Date.now()
    if (g.turnsSinceDetect < MIN_TURNS_SINCE_DETECT && now - g.lastDetectAt < DETECT_MIN_INTERVAL_MS) {
      return
    }
    // Snapshot the turn count we're acting on; the judge runs for up to ~45s and
    // new turns may complete (and increment) during that window. Subtract this
    // snapshot in the finally instead of zeroing, so concurrent increments survive.
    const turnsAtStart = g.turnsSinceDetect
    const day = localDay()
    const callsToday = g.judgeDay === day ? g.judgeCallsToday : 0
    if (callsToday >= JUDGE_DAILY_CAP) return

    const recent = messages.filter((m) => !m.pending && m.text?.trim()).slice(-DETECT_HISTORY_TURNS)
    if (recent.length === 0) return

    this.setBusy(true)
    this.cancelRequested = false
    try {
      const convo = recent
        .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text.trim()}`)
        .join('\n\n')
      const out = await runHeadlessClaude({
        cwd: process.cwd(),
        prompt: this.judgePrompt(convo),
        allowedTools: ['Read'],
        timeoutMs: DETECT_TIMEOUT_MS,
        onSpawn: (child) => (this.inFlight = child)
      })
      this.absorbChatSuggestions(
        this.parseJudge(out),
        recent[recent.length - 1].id,
        convo.slice(0, DETECT_CONTEXT_MAX)
      )
    } catch {
      // Detector failures are invisible — never surface to the user.
    } finally {
      this.inFlight = null
      this.setBusy(false)
      const g2 = this.store.loadGrowth()
      const day2 = localDay()
      this.store.setGrowth({
        ...g2,
        lastDetectAt: Date.now(),
        turnsSinceDetect: Math.max(0, (g2.turnsSinceDetect ?? 0) - turnsAtStart),
        judgeDay: day2,
        judgeCallsToday: (g2.judgeDay === day2 ? g2.judgeCallsToday : 0) + 1
      })
    }
  }

  private judgePrompt(convo: string): string {
    const existing = this.existingNamesSnapshot()
    return [
      'You are the talent scout for an Agent & Skill Factory inside Maestro. You read a recent',
      "slice of the user's Conductor chat and decide whether it reveals a REUSABLE workflow or",
      'body of knowledge worth capturing as a Claude Code SKILL (a repeatable procedure the user',
      'invokes) or SUB-AGENT (a specialist for one bounded domain).',
      '',
      'Be conservative: most chats are one-offs and should yield NOTHING. Only suggest when the',
      'same kind of task would plausibly recur. Never suggest something that overlaps an artifact',
      'that already exists below — neither a near-duplicate name nor the same purpose.',
      '',
      `Artifacts that already exist (do NOT duplicate):\n${JSON.stringify(existing, null, 2)}`,
      '',
      'Recent Conductor conversation (oldest first):',
      convo,
      '',
      'Respond with ONLY one JSON object — no markdown fences, no prose:',
      '{"suggest": <true|false>,',
      ' "items": [{"kind":"skill|agent",',
      '   "name":"<kebab-case-slug>",',
      '   "title":"<short human title>",',
      '   "description":"<one line: when to use it>",',
      '   "rationale":"<why this conversation shows it would recur>",',
      '   "confidence": <0..1>}]}',
      'Return {"suggest": false, "items": []} when nothing is worth capturing.'
    ].join('\n')
  }

  /** Existing skills/agents (registered + on-disk), for judge prompts and dedupe. */
  private existingNamesSnapshot(): { kind: string; name: string; description: string }[] {
    return [
      ...this.state.artifacts.map((a) => ({ kind: a.kind, name: a.name, description: a.description })),
      ...scanSkills().map((s) => ({ kind: 'skill', name: s.name, description: s.description ?? '' })),
      ...scanAgents().map((a) => ({ kind: 'agent', name: a.name, description: a.description ?? '' }))
    ]
  }

  private parseJudge(out: string): {
    kind: FactoryArtifactKind
    name: string
    title: string
    description: string
    rationale: string
    confidence: number
  }[] {
    const parsed = extractJson(out) as { suggest?: unknown; items?: unknown } | null
    if (!parsed || parsed.suggest === false) return []
    const raw = Array.isArray(parsed.items) ? parsed.items : []
    const items: {
      kind: FactoryArtifactKind
      name: string
      title: string
      description: string
      rationale: string
      confidence: number
    }[] = []
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      const kind: FactoryArtifactKind = o.kind === 'agent' ? 'agent' : 'skill'
      const name = slugify(String(o.name ?? ''))
      const description = String(o.description ?? '').trim()
      if (!name || !description) continue
      let confidence = Number(o.confidence)
      if (!Number.isFinite(confidence)) confidence = 0
      items.push({
        kind,
        name,
        title: String(o.title ?? description).trim() || description,
        description,
        rationale: String(o.rationale ?? '').trim(),
        confidence: Math.max(0, Math.min(1, confidence))
      })
    }
    return items
  }

  private absorbChatSuggestions(
    items: { kind: FactoryArtifactKind; name: string; title: string; description: string; rationale: string; confidence: number }[],
    sourceMsgId: string,
    context: string
  ): void {
    let newest: FactorySuggestion | null = null
    let added = 0
    for (const it of items) {
      if (added >= MAX_SUGGESTIONS_PER_DETECT) break
      if (it.confidence < MIN_CONFIDENCE) continue
      if (this.suggestionDuplicate(it.kind, it.name, it.title)) continue
      newest = this.enqueueSuggestion({
        suggestedKind: it.kind,
        name: it.name,
        title: it.title,
        description: it.description,
        rationale: it.rationale,
        origin: 'chat',
        sourceRef: sourceMsgId,
        sourceLabel: 'Maestro chat',
        source: null,
        context,
        topics: [],
        keywords: [],
        existing: null,
        confidence: it.confidence
      })
      added++
    }
    if (added > 0) {
      this.persist()
      if (newest) this.getWin()?.webContents.send('factory:suggestion', newest)
    }
  }

  // ---------- self-growth: suggestion queue ----------

  private enqueueSuggestion(
    input: Omit<FactorySuggestion, 'id' | 'status' | 'createdAt' | 'updatedAt'>
  ): FactorySuggestion {
    const now = Date.now()
    const s: FactorySuggestion = { id: randomUUID(), status: 'open', createdAt: now, updatedAt: now, ...input }
    this.state.suggestions.push(s)
    this.capSuggestions()
    return s
  }

  /**
   * Keep the queue bounded by pruning ONLY the oldest terminal (created/dismissed)
   * entries. Actionable suggestions (open/creating/error) are never dropped — if
   * those alone exceed the cap we let the queue run over rather than silently
   * losing work the user still has to act on.
   */
  private capSuggestions(): void {
    if (this.state.suggestions.length <= MAX_SUGGESTIONS) return
    const terminalOldestFirst = this.state.suggestions
      .filter((s) => s.status === 'created' || s.status === 'dismissed')
      .sort((a, b) => a.updatedAt - b.updatedAt)
    const drop = new Set<string>()
    for (const s of terminalOldestFirst) {
      if (this.state.suggestions.length - drop.size <= MAX_SUGGESTIONS) break
      drop.add(s.id)
    }
    if (drop.size > 0) {
      this.state.suggestions = this.state.suggestions.filter((x) => !drop.has(x.id))
    }
  }

  /**
   * Deterministic, token-free dedupe: is this idea already installed/registered,
   * or already in the open queue, or semantically the same as one of those?
   */
  private suggestionDuplicate(kind: FactoryArtifactKind, slug: string, title: string): 'artifact' | 'suggestion' | null {
    const key = `${kind}:${slug}`
    const installed = new Set([
      ...this.state.artifacts.map((a) => `${a.kind}:${a.name}`),
      ...listInstalled().map((i) => `${i.kind}:${i.name}`)
    ])
    if (installed.has(key)) return 'artifact'

    const words = (t: string): Set<string> =>
      new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean))
    const jaccard = (a: Set<string>, b: Set<string>): number => {
      if (a.size === 0 || b.size === 0) return 0
      let inter = 0
      for (const w of a) if (b.has(w)) inter++
      return inter / (a.size + b.size - inter)
    }
    const t = words(title)
    for (const s of this.state.suggestions) {
      if (s.status !== 'open' && s.status !== 'creating') continue
      if (s.suggestedKind === kind && s.name === slug) return 'suggestion'
      if (jaccard(t, words(s.title)) >= 0.6) return 'suggestion'
    }
    for (const a of this.state.artifacts) {
      if (jaccard(t, words(`${a.name} ${a.description}`)) >= 0.6) return 'artifact'
    }
    return null
  }

  /** Author + write + register the artifact for a suggestion (the only way one is built). */
  async createFromSuggestion(id: string, kind?: FactoryArtifactKind): Promise<void> {
    const s = this.state.suggestions.find((x) => x.id === id)
    if (!s || (s.status !== 'open' && s.status !== 'error')) return
    if (this.busy) return
    const useKind: FactoryArtifactKind = kind ?? s.suggestedKind
    this.setBusy(true)
    this.cancelRequested = false
    s.status = 'creating'
    // Persist the kind the user actually clicked now, not just on success: if the
    // app is quit mid-create (creating→open on boot) the suggestion must remember
    // the chosen kind rather than reverting to the originally-suggested one.
    s.suggestedKind = useKind
    s.result = undefined
    s.updatedAt = Date.now()
    this.persist()

    try {
      // Don't let the author child overlap an in-flight discovery (its own headless
      // agent): wait it out so we keep to one agent at a time. The scan-origin path
      // below also awaits listSources(), which joins the same discovery.
      await this.discovering?.catch(() => {})
      const slug = slugify(s.name)
      let authored: ReturnType<FactoryService['parseAuthor']>
      if (s.origin === 'scan') {
        const sources = await this.discoverCache().catch(() => [] as FactorySource[])
        const source =
          sources.find((x) => x.server === s.source) ??
          ({ server: s.source ?? 'mcp', label: s.sourceLabel, toolPrefix: `mcp__${s.source ?? ''}`, readTools: [] } as FactorySource)
        const candidate: FactoryCandidate = {
          id: s.id,
          kind: useKind,
          name: slug,
          description: s.description,
          topics: s.topics,
          keywords: s.keywords,
          rationale: s.rationale,
          existing: s.existing,
          status: 'authoring'
        }
        const allowedTools = ['Read', 'Grep', 'Glob', source.toolPrefix, ...source.readTools]
        const out = await runHeadlessClaude({
          cwd: process.cwd(),
          prompt: this.authorPrompt(source, candidate, slug),
          allowedTools,
          timeoutMs: AUTHOR_TIMEOUT_MS,
          onSpawn: (child) => (this.inFlight = child)
        })
        authored = this.parseAuthor(out)
      } else {
        const out = await runHeadlessClaude({
          cwd: process.cwd(),
          prompt: this.conversationAuthorPrompt(s, useKind, slug),
          allowedTools: ['Read', 'Grep', 'Glob'],
          timeoutMs: AUTHOR_TIMEOUT_MS,
          onSpawn: (child) => (this.inFlight = child)
        })
        authored = this.parseAuthor(out)
      }
      if (!authored) throw new Error('The author agent did not return usable file content.')

      const filePath =
        useKind === 'skill' ? writeSkill(slug, authored.content) : writeAgent(slug, authored.content)
      this.registerArtifact({
        kind: useKind,
        name: slug,
        filePath,
        description: authored.description || s.description,
        topics: authored.topics.length ? authored.topics : s.topics,
        keywords: authored.keywords.length ? authored.keywords : s.keywords,
        source: s.origin === 'scan' ? (s.source ?? 'scan') : 'conversation',
        related: authored.related
      })
      const artifact = this.state.artifacts.find((a) => a.kind === useKind && a.name === slug)
      s.status = 'created'
      s.artifactId = artifact?.id
      s.filePath = filePath
      s.result = `Wrote ${useKind} to ${filePath}`
    } catch (err) {
      if (this.cancelRequested) {
        s.status = 'open'
        s.result = undefined
      } else {
        s.status = 'error'
        s.result = (err as Error).message || String(err)
      }
    } finally {
      s.updatedAt = Date.now()
      this.inFlight = null
      this.setBusy(false)
      this.persist()
    }
  }

  /** Dismiss a suggestion without building it (kept as history; may resurface later). */
  dismissSuggestion(id: string): void {
    const s = this.state.suggestions.find((x) => x.id === id)
    if (!s || (s.status !== 'open' && s.status !== 'error')) return
    s.status = 'dismissed'
    s.updatedAt = Date.now()
    this.persist()
  }

  private conversationAuthorPrompt(s: FactorySuggestion, kind: FactoryArtifactKind, slug: string): string {
    const related = this.state.artifacts.map((a) => ({ name: a.name, kind: a.kind, description: a.description }))
    const lessons = this.state.lessons.map((l) => l.text)
    const isSkill = kind === 'skill'
    return [
      `You are authoring a Claude Code ${isSkill ? 'SKILL' : 'SUB-AGENT'} that captures a reusable`,
      'workflow the user demonstrated in a Maestro Conductor conversation. You run unattended.',
      '',
      `Target artifact:\n${JSON.stringify({ kind, name: slug, description: s.description, topics: s.topics, rationale: s.rationale }, null, 2)}`,
      '',
      'The conversation that motivated this artifact — capture the GENERAL, reusable procedure it',
      'shows; strip one-off specifics (particular file names, ids, values) and keep the repeatable',
      'method:',
      s.context || '(no excerpt was captured; rely on the target description above)',
      '',
      'Write the COMPLETE file content as Markdown with a YAML frontmatter block.',
      isSkill
        ? [
            'For a SKILL the file is SKILL.md. Frontmatter MUST be exactly:',
            '---',
            `name: ${slug}`,
            'description: <one line describing WHEN to use this skill>',
            '---',
            'Then the body: a focused, step-by-step procedure the agent can follow.'
          ].join('\n')
        : [
            'For a SUB-AGENT the file is an agent definition. Frontmatter MUST be exactly:',
            '---',
            `name: ${slug}`,
            'description: <one line: when to route to this agent — be specific with trigger terms>',
            'model: claude-sonnet-4-6',
            '---',
            "Then the body: the agent's system prompt — its scope, what it knows, and what it does NOT cover."
          ].join('\n'),
      '',
      `Other artifacts that exist (name any genuinely related):\n${JSON.stringify(related, null, 2)}`,
      lessons.length ? `\nLessons learned (respect these):\n- ${lessons.join('\n- ')}` : '',
      '',
      'Respond with ONLY one JSON object — no markdown fences around the whole object, no prose:',
      '{"content":"<the FULL file content, frontmatter + body, as a single string>",',
      ' "description":"<final one-line description>",',
      ' "topics":["..."], "keywords":["..."],',
      ' "related":["<names of related existing artifacts>"]}'
    ]
      .filter((l) => l !== '')
      .join('\n')
  }

  /** Cancel the in-flight scan/author agent, if any (the run reports 'cancelled'). */
  cancel(): void {
    if (!this.inFlight) return
    this.cancelRequested = true
    try {
      this.inFlight.kill()
    } catch {
      // already gone
    }
  }

  /** Drop finished runs from the audit trail (a running one is kept). */
  clearRuns(): void {
    this.runs = this.runs.filter((r) => r.status === 'running')
    this.broadcastRuns()
  }

  // ---------- source discovery (phase 0) ----------

  /**
   * Enumerate the MCP contexts the factory can mine. The connected claude.ai
   * connectors are not in ~/.claude.json, so a no-tool headless agent reports
   * what it can see; we merge that with the user-scope servers from
   * ~/.claude.json. Cached for the app run; `refresh` forces a re-discovery.
   *
   * PUBLIC entry point (IPC / renderer refresh / auto-propose pre-scan): if a
   * heavy op holds the lock, WAIT for it before starting a discovery agent, so
   * we never run two headless `claude -p` children at once. Lock-holders
   * (scan/approve/createFromSuggestion) must call discoverCache() instead — they
   * already hold the lock and would otherwise wait on themselves (deadlock).
   */
  async listSources(refresh = false): Promise<FactorySource[]> {
    if (this.sources && !refresh) return this.sources
    while (this.busy && this.busyPromise) await this.busyPromise
    return this.discoverCache(refresh)
  }

  /**
   * The actual cached/memoized discovery, with NO busy-wait. Safe to call from a
   * lock-holder because discovery runs before that op spawns its own child, so
   * only one headless child is ever alive. Concurrent callers join one discovery.
   */
  private discoverCache(refresh = false): Promise<FactorySource[]> {
    if (this.sources && !refresh) return Promise.resolve(this.sources)
    if (this.discovering) return this.discovering
    this.discovering = (async () => {
      try {
        const discovered = await this.discoverSources().catch(() => [] as FactorySource[])
        const byKey = new Map<string, FactorySource>()
        for (const s of discovered) byKey.set(s.server, s)
        // Merge user-scope servers from ~/.claude.json (e.g. github) if not reported.
        for (const m of readUserMcpServers()) {
          if (!byKey.has(m.name)) {
            byKey.set(m.name, {
              server: m.name,
              label: KNOWN_LABELS[m.name] ?? m.name,
              toolPrefix: `mcp__${m.name}`,
              readTools: []
            })
          }
        }
        this.sources = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label))
        return this.sources
      } finally {
        this.discovering = null
      }
    })()
    return this.discovering
  }

  private async discoverSources(): Promise<FactorySource[]> {
    const prompt = [
      'You run unattended inside a tool that generates Claude skills and sub-agents from',
      'connected MCP data sources. List EVERY MCP server you currently have access to.',
      '',
      'For each server, report:',
      '- "server": the server key exactly as it appears in your tool names — the segment',
      '  between "mcp__" and the next "__" (e.g. for mcp__claude_ai_Atlassian__search it is',
      '  "claude_ai_Atlassian").',
      '- "label": a short human label (e.g. "Atlassian (Confluence / Jira)").',
      '- "canRead": true if it exposes tools that READ/search external data.',
      '- "readTools": up to 6 representative READ/search tool names (full names, with the',
      '  mcp__ prefix). Omit write/auth-only tools.',
      '',
      'Do NOT call any tools — answer purely from the tools you can see. Skip servers that',
      'only authenticate (e.g. *_authenticate) with no read tools.',
      '',
      'Respond with ONLY one JSON object — no markdown fences, no prose:',
      '{"servers":[{"server":"...","label":"...","canRead":true,"readTools":["mcp__..._..."]}]}'
    ].join('\n')

    // Discovery uses its OWN child slot, never the shared `inFlight`, so its
    // completion can't null out a concurrently-running scan/author/judge child.
    const out = await runHeadlessClaude({
      cwd: process.cwd(),
      prompt,
      allowedTools: ['Read'],
      timeoutMs: DISCOVER_TIMEOUT_MS,
      onSpawn: (child) => (this.discoverChild = child)
    }).finally(() => (this.discoverChild = null))

    const parsed = extractJson(out) as { servers?: unknown } | null
    const list = Array.isArray(parsed?.servers) ? parsed.servers : []
    const sources: FactorySource[] = []
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const server = String(r.server ?? '').trim()
      if (!server || r.canRead === false) continue
      const readTools = Array.isArray(r.readTools)
        ? r.readTools.map((t) => String(t).trim()).filter((t) => t.startsWith('mcp__'))
        : []
      sources.push({
        server,
        label: KNOWN_LABELS[server] ?? (String(r.label ?? server).trim() || server),
        toolPrefix: `mcp__${server}`,
        readTools
      })
    }
    return sources
  }

  // ---------- scan (phase 1) ----------

  /**
   * Explore a source and propose skill/agent candidates. Claims the single
   * `busy` lock SYNCHRONOUSLY (before any await) so two headless agents can
   * never run at once. Returns the created run's id, or null if it bailed on
   * the busy guard (no run, no tokens spent) — callers (auto-propose) use this
   * to harvest exactly this run and to only consume budget when a scan ran.
   * Throws (releasing the lock) only for an unknown source / discovery failure.
   */
  async scan(serverKey: string, guidance: string): Promise<string | null> {
    if (this.busy) return null
    this.setBusy(true)
    this.cancelRequested = false
    let run: FactoryRun | null = null
    try {
      // Lock-holder: discover without waiting on our own lock.
      const sources = await this.discoverCache()
      const source = sources.find((s) => s.server === serverKey)
      if (!source) throw new Error(`Unknown source: ${serverKey}`)

      run = {
        id: randomUUID(),
        source: source.server,
        sourceLabel: source.label,
        guidance: guidance.trim(),
        startedAt: Date.now(),
        finishedAt: null,
        status: 'running',
        phase: 'discovering',
        candidates: [],
        summary: ''
      }
      this.pushRun(run)

      const allowedTools = ['Read', 'Grep', 'Glob', source.toolPrefix, ...source.readTools]
      this.broadcastRuns()
      const out = await runHeadlessClaude({
        cwd: process.cwd(),
        prompt: this.scanPrompt(source, run.guidance),
        allowedTools,
        timeoutMs: SCAN_TIMEOUT_MS,
        onSpawn: (child) => (this.inFlight = child)
      })
      const parsed = this.parseScan(out)
      run.candidates = parsed.candidates
      run.summary = parsed.summary
      run.phase = 'done'
      run.status = 'done'
      this.absorbTopics(parsed.newTopics, source.server)
    } catch (err) {
      if (run) {
        run.status = this.cancelRequested ? 'cancelled' : 'error'
        run.phase = 'done'
        run.summary = this.cancelRequested ? 'Cancelled.' : (err as Error).message || String(err)
      } else {
        // Unknown source / discovery failure before a run existed — release and rethrow.
        this.inFlight = null
        this.setBusy(false)
        throw err
      }
    } finally {
      if (run) {
        run.finishedAt = Date.now()
        this.inFlight = null
        this.setBusy(false)
        this.broadcastRuns()
      }
    }
    return run ? run.id : null
  }

  private scanPrompt(source: FactorySource, guidance: string): string {
    const existing = [
      ...this.state.artifacts.map((a) => ({ kind: a.kind, name: a.name, topics: a.topics })),
      ...scanSkills().map((s) => ({ kind: 'skill', name: s.name, topics: [] as string[] })),
      ...scanAgents().map((a) => ({ kind: 'agent', name: a.name, topics: [] as string[] }))
    ]
    const openTopics = this.state.topics.filter((t) => t.status === 'open').map((t) => t.title)
    const lessons = this.state.lessons.map((l) => l.text)

    const lines = [
      'You are the managing editor of an Agent & Skill Factory. Your job is to turn a connected',
      `data source into reusable Claude Code SKILLS and SUB-AGENTS. The source is "${source.label}"`,
      `(MCP server key "${source.server}"). You run unattended — nobody can answer questions.`,
      '',
      'Use the source\'s MCP read/search tools to actually explore it (run searches, read a few',
      'representative documents/issues/pages) and learn what domains, processes and vocabulary it',
      'covers. Ground every proposal in things you actually found — never invent topics.',
      '',
      'A SKILL packages a repeatable procedure or knowledge the user invokes (a SKILL.md). A',
      'SUB-AGENT is a specialist that answers questions / advises about one bounded domain (an',
      'agent .md). Choose the kind that fits each proposal.',
      '',
      'CREATE vs ENRICH: if a proposal overlaps something that already exists below, set "existing"',
      "to that artifact's name (so it will be enriched) instead of duplicating it.",
      '',
      `Artifacts that already exist (do NOT duplicate; enrich instead):\n${JSON.stringify(existing, null, 2)}`,
      openTopics.length ? `\nBacklog topics already parked (don't re-add): ${openTopics.join('; ')}` : '',
      lessons.length ? `\nLessons learned (respect these):\n- ${lessons.join('\n- ')}` : ''
    ]
    if (guidance) lines.push('', 'Steering from the user (follow it closely):', guidance)
    lines.push(
      '',
      `Propose up to ${MAX_CANDIDATES} high-value candidates — each a coherent, bounded domain that`,
      'is genuinely groundable in this source. Also note ADJACENT topics worth their own artifact',
      'later (the backlog).',
      '',
      'Respond with ONLY one JSON object — no markdown fences, no prose — shaped exactly like:',
      '{"summary":"<1-2 sentences on what you found and propose>",',
      ' "candidates":[{"kind":"skill|agent",',
      '   "name":"<kebab-case-slug>",',
      '   "description":"<one line: when to use this artifact>",',
      '   "topics":["..."], "keywords":["..."],',
      '   "rationale":"<why it is worth building, citing what you saw>",',
      '   "existing":"<name of an existing artifact to enrich, or null>"}],',
      ' "newTopics":[{"title":"<short topic>","note":"<why it looks worth its own artifact>"}]}'
    )
    return lines.filter((l) => l !== '').join('\n')
  }

  private parseScan(out: string): {
    summary: string
    candidates: FactoryCandidate[]
    newTopics: { title: string; note: string }[]
  } {
    const parsed = extractJson(out) as {
      summary?: unknown
      candidates?: unknown
      newTopics?: unknown
    } | null
    const rawCands = Array.isArray(parsed?.candidates) ? parsed.candidates : []
    const candidates: FactoryCandidate[] = []
    for (const raw of rawCands) {
      if (candidates.length >= MAX_CANDIDATES) break
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const kind = r.kind === 'agent' ? 'agent' : 'skill'
      const name = slugify(String(r.name ?? ''))
      if (!name) continue
      const description = String(r.description ?? '').trim()
      if (!description) continue
      candidates.push({
        id: randomUUID(),
        kind,
        name,
        description,
        topics: toStringArray(r.topics),
        keywords: toStringArray(r.keywords),
        rationale: String(r.rationale ?? '').trim(),
        existing: r.existing && String(r.existing).trim() ? String(r.existing).trim() : null,
        status: 'proposed'
      })
    }
    const rawTopics = Array.isArray(parsed?.newTopics) ? parsed.newTopics : []
    const newTopics: { title: string; note: string }[] = []
    for (const raw of rawTopics) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const title = String(r.title ?? '').trim()
      if (title) newTopics.push({ title, note: String(r.note ?? '').trim() })
    }
    return {
      summary: String(parsed?.summary ?? '').trim() || (candidates.length ? 'Proposed candidates.' : 'No candidates found.'),
      candidates,
      newTopics
    }
  }

  // ---------- author (phase 2) ----------

  /** Approve a candidate: author its file content and write it to ~/.claude. An errored candidate can be retried. */
  async approve(runId: string, candidateId: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId)
    const candidate = run?.candidates.find((c) => c.id === candidateId)
    if (!run || !candidate || (candidate.status !== 'proposed' && candidate.status !== 'error')) return
    if (this.busy) return
    this.setBusy(true)
    this.cancelRequested = false
    candidate.status = 'authoring'
    candidate.result = undefined
    this.broadcastRuns()

    try {
      const source =
        (await this.discoverCache()).find((s) => s.server === run.source) ??
        ({ server: run.source, label: run.sourceLabel, toolPrefix: `mcp__${run.source}`, readTools: [] } as FactorySource)
      const allowedTools = ['Read', 'Grep', 'Glob', source.toolPrefix, ...source.readTools]
      const slug = slugify(candidate.name)
      const out = await runHeadlessClaude({
        cwd: process.cwd(),
        prompt: this.authorPrompt(source, candidate, slug),
        allowedTools,
        timeoutMs: AUTHOR_TIMEOUT_MS,
        onSpawn: (child) => (this.inFlight = child)
      })
      const authored = this.parseAuthor(out)
      if (!authored) throw new Error('The author agent did not return usable file content.')

      const filePath =
        candidate.kind === 'skill' ? writeSkill(slug, authored.content) : writeAgent(slug, authored.content)

      this.registerArtifact({
        kind: candidate.kind,
        name: slug,
        filePath,
        description: authored.description || candidate.description,
        topics: authored.topics.length ? authored.topics : candidate.topics,
        keywords: authored.keywords.length ? authored.keywords : candidate.keywords,
        source: run.source,
        related: authored.related
      })

      candidate.status = 'active'
      candidate.filePath = filePath
      candidate.result = `Wrote ${candidate.kind} to ${filePath}`
    } catch (err) {
      if (this.cancelRequested) {
        // Put the candidate back so the user can approve it again later.
        candidate.status = 'proposed'
        candidate.result = undefined
      } else {
        candidate.status = 'error'
        candidate.result = (err as Error).message || String(err)
      }
    } finally {
      this.inFlight = null
      this.setBusy(false)
      this.broadcastRuns()
      this.broadcastState()
    }
  }

  /** Approve every still-proposed candidate on a run, in order (stops on cancel). */
  async approveAll(runId: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId)
    if (!run) return
    for (const c of run.candidates) {
      if (c.status === 'proposed') await this.approve(runId, c.id)
      if (this.cancelRequested) break
    }
  }

  reject(runId: string, candidateId: string): void {
    const run = this.runs.find((r) => r.id === runId)
    const candidate = run?.candidates.find((c) => c.id === candidateId)
    if (!candidate || candidate.status !== 'proposed') return
    candidate.status = 'rejected'
    this.broadcastRuns()
  }

  private authorPrompt(source: FactorySource, candidate: FactoryCandidate, slug: string): string {
    const related = this.state.artifacts.map((a) => ({ name: a.name, kind: a.kind, description: a.description }))
    const lessons = this.state.lessons.map((l) => l.text)
    const isSkill = candidate.kind === 'skill'

    const lines = [
      `You are authoring a Claude Code ${isSkill ? 'SKILL' : 'SUB-AGENT'} grounded in the data`,
      `source "${source.label}" (MCP server key "${source.server}"). You run unattended.`,
      '',
      `Target artifact:\n${JSON.stringify(
        { kind: candidate.kind, name: slug, description: candidate.description, topics: candidate.topics, rationale: candidate.rationale },
        null,
        2
      )}`,
      candidate.existing ? `\nThis ENRICHES the existing artifact "${candidate.existing}".` : '',
      '',
      'First, USE the source\'s MCP read/search tools to gather the real material this artifact must',
      'encode — search the source, read the relevant pages/issues/files. Cite concrete references',
      '(page titles/ids, issue keys, repo paths) so the artifact is genuinely grounded, not generic.',
      '',
      'Then write the COMPLETE file content as Markdown with a YAML frontmatter block.',
      isSkill
        ? [
            'For a SKILL the file is SKILL.md. Frontmatter MUST be exactly:',
            '---',
            `name: ${slug}`,
            'description: <one line describing WHEN to use this skill>',
            '---',
            'Then the body: a focused, step-by-step procedure the agent can follow, including the',
            'specific MCP tools and example queries to run against this source.'
          ].join('\n')
        : [
            'For a SUB-AGENT the file is an agent definition. Frontmatter MUST be exactly:',
            '---',
            `name: ${slug}`,
            'description: <one line: when to route to this agent — be specific with trigger terms>',
            'model: claude-sonnet-4-6',
            '---',
            'Then the body: the agent\'s system prompt — its domain scope, what it knows, how it should',
            'use the source\'s MCP read tools to answer, and what it explicitly does NOT cover.'
          ].join('\n'),
      '',
      `Other artifacts that exist (name any that are genuinely related):\n${JSON.stringify(related, null, 2)}`,
      lessons.length ? `\nLessons learned (respect these):\n- ${lessons.join('\n- ')}` : '',
      '',
      'Respond with ONLY one JSON object — no markdown fences around the whole object, no prose:',
      '{"content":"<the FULL file content, frontmatter + body, as a single string>",',
      ' "description":"<final one-line description>",',
      ' "topics":["..."], "keywords":["..."],',
      ' "related":["<names of related existing artifacts>"]}'
    ]
    return lines.filter((l) => l !== '').join('\n')
  }

  private parseAuthor(out: string): {
    content: string
    description: string
    topics: string[]
    keywords: string[]
    related: string[]
  } | null {
    const parsed = extractJson(out) as {
      content?: unknown
      description?: unknown
      topics?: unknown
      keywords?: unknown
      related?: unknown
    } | null
    const content = typeof parsed?.content === 'string' ? parsed.content.trim() : ''
    if (!content || !content.includes('---')) return null
    return {
      content,
      description: String(parsed?.description ?? '').trim(),
      topics: toStringArray(parsed?.topics),
      keywords: toStringArray(parsed?.keywords),
      related: toStringArray(parsed?.related)
    }
  }

  // ---------- registry: artifacts, connection map ----------

  private registerArtifact(input: {
    kind: FactoryArtifact['kind']
    name: string
    filePath: string
    description: string
    topics: string[]
    keywords: string[]
    source: string
    related: string[]
  }): void {
    const now = Date.now()
    const known = new Set(this.state.artifacts.map((a) => a.name))
    const related = [...new Set(input.related.map((r) => slugify(r)).filter((r) => r && r !== input.name && known.has(r)))]

    const existing = this.state.artifacts.find((a) => a.name === input.name && a.kind === input.kind)
    if (existing) {
      existing.filePath = input.filePath
      existing.description = input.description
      existing.topics = input.topics
      existing.keywords = input.keywords
      existing.source = input.source
      existing.relatedArtifacts = [...new Set([...existing.relatedArtifacts, ...related])]
      existing.updatedAt = now
    } else {
      this.state.artifacts.push({
        id: randomUUID(),
        kind: input.kind,
        name: input.name,
        filePath: input.filePath,
        description: input.description,
        topics: input.topics,
        keywords: input.keywords,
        source: input.source,
        relatedArtifacts: related,
        createdAt: now,
        updatedAt: now
      })
    }
    // Add the reverse edges (connection map is bidirectional).
    for (const a of this.state.artifacts) {
      if (related.includes(a.name) && !a.relatedArtifacts.includes(input.name)) {
        a.relatedArtifacts.push(input.name)
        a.updatedAt = now
      }
    }
    this.persist()
  }

  deleteArtifact(id: string): void {
    const artifact = this.state.artifacts.find((a) => a.id === id)
    if (!artifact) return
    // Adopted artifacts pre-date the factory — never delete their file, only unregister.
    if (!artifact.adopted) deleteArtifactFile(artifact.kind, artifact.name)
    this.unregister(id)
  }

  /** Remove an artifact from the registry WITHOUT touching its file. */
  unregister(id: string): void {
    const artifact = this.state.artifacts.find((a) => a.id === id)
    if (!artifact) return
    this.state.artifacts = this.state.artifacts.filter((a) => a.id !== id)
    // Prune dangling edges.
    for (const a of this.state.artifacts) {
      a.relatedArtifacts = a.relatedArtifacts.filter((n) => n !== artifact.name)
    }
    this.persist()
  }

  /** Read a registered artifact's file content (null when the file is missing). */
  readArtifact(id: string): string | null {
    const artifact = this.state.artifacts.find((a) => a.id === id)
    if (!artifact) return null
    try {
      return readFileSync(artifact.filePath, 'utf8')
    } catch {
      return null
    }
  }

  /** Reveal a registered artifact's file in the OS file manager. */
  revealArtifact(id: string): void {
    const artifact = this.state.artifacts.find((a) => a.id === id)
    if (artifact && existsSync(artifact.filePath)) shell.showItemInFolder(artifact.filePath)
  }

  // ---------- registry↔disk audit (the lightweight validator) ----------

  /** Reconcile the registry against ~/.claude on disk. */
  audit(): FactoryAudit {
    const missingFileIds = this.state.artifacts.filter((a) => !existsSync(a.filePath)).map((a) => a.id)
    const registered = new Set(this.state.artifacts.map((a) => `${a.kind}:${a.name}`))
    const unregistered = listInstalled().filter((i) => !registered.has(`${i.kind}:${i.name}`))
    return { missingFileIds, unregistered }
  }

  /** Adopt a pre-existing on-disk skill/agent into the registry (file is left as-is). */
  adopt(kind: FactoryArtifactKind, name: string): void {
    if (this.state.artifacts.some((a) => a.kind === kind && a.name === name)) return
    const installed = listInstalled().find((i) => i.kind === kind && i.name === name)
    if (!installed) return
    const now = Date.now()
    this.state.artifacts.push({
      id: randomUUID(),
      kind,
      name,
      filePath: installed.filePath,
      description: installed.description,
      topics: [],
      keywords: [],
      source: 'adopted',
      relatedArtifacts: [],
      adopted: true,
      createdAt: now,
      updatedAt: now
    })
    this.persist()
  }

  // ---------- backlog (topics-to-pursue) ----------

  private absorbTopics(topics: { title: string; note: string }[], source: string): void {
    const have = new Set(this.state.topics.map((t) => t.title.toLowerCase()))
    for (const t of topics) {
      if (have.has(t.title.toLowerCase())) continue
      this.state.topics.push({
        id: randomUUID(),
        title: t.title,
        note: t.note,
        source,
        status: 'open',
        addedAt: Date.now()
      })
    }
    if (this.state.topics.length > MAX_TOPICS) {
      this.state.topics = this.state.topics.slice(-MAX_TOPICS)
    }
    this.persist()
  }

  dismissTopic(id: string): void {
    const topic = this.state.topics.find((t) => t.id === id)
    if (!topic) return
    topic.status = 'rejected'
    this.persist()
  }

  /** Promote a backlog topic into a fresh scan seeded by its title/note. */
  async promoteTopic(id: string): Promise<void> {
    const topic = this.state.topics.find((t) => t.id === id)
    if (!topic) return
    topic.status = 'done'
    this.persist()
    const guidance = `Focus on this specific topic: "${topic.title}". ${topic.note}`.trim()
    await this.scan(topic.source, guidance)
  }

  // ---------- lessons learned ----------

  addLesson(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const lesson: FactoryLesson = { id: randomUUID(), text: trimmed, addedAt: Date.now() }
    this.state.lessons.push(lesson)
    if (this.state.lessons.length > MAX_LESSONS) {
      this.state.lessons = this.state.lessons.slice(-MAX_LESSONS)
    }
    this.persist()
  }

  deleteLesson(id: string): void {
    this.state.lessons = this.state.lessons.filter((l) => l.id !== id)
    this.persist()
  }

  // ---------- plumbing ----------

  private pushRun(run: FactoryRun): void {
    this.runs.unshift(run)
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS
    this.broadcastRuns()
  }

  private persist(): void {
    this.store.set(this.state)
    this.broadcastState()
  }

  private broadcastState(): void {
    this.getWin()?.webContents.send('factory:changed', this.state)
  }

  /**
   * Single source of truth for the headless lock. Setting it broadcasts so the
   * renderer can reflect background work (judge / author / scan) that doesn't
   * create a visible FactoryRun — preventing buttons that would silently no-op
   * against the lock from staying enabled.
   */
  private setBusy(v: boolean): void {
    if (this.busy === v) return
    this.busy = v
    if (v) {
      // Fresh gate that an idle-waiter (public listSources) can await.
      this.busyPromise = new Promise<void>((resolve) => (this.busyResolve = resolve))
    } else {
      this.busyResolve?.()
      this.busyResolve = null
      this.busyPromise = null
    }
    this.getWin()?.webContents.send('factory:busy', v)
  }

  /** Current headless-lock state (for the initial renderer fetch). */
  isBusy(): boolean {
    return this.busy
  }

  private broadcastRuns(): void {
    this.store.setRuns(this.runs)
    this.getWin()?.webContents.send('factory:runs', this.runs)
  }
}

/**
 * Sanitize runs restored from disk: anything that was mid-flight when the app
 * closed is settled — the run is marked cancelled, an authoring candidate goes
 * back to 'proposed' so it can simply be approved again.
 */
function restoreRuns(runs: FactoryRun[]): FactoryRun[] {
  for (const run of runs) {
    if (run.status === 'running') {
      run.status = 'cancelled'
      run.phase = 'done'
      run.finishedAt = run.finishedAt ?? Date.now()
      run.summary = run.summary || 'Interrupted — the app was closed mid-scan.'
    }
    for (const c of run.candidates) {
      if (c.status === 'authoring') {
        c.status = 'proposed'
        c.result = undefined
      }
    }
  }
  return runs
}

/** Coerce an unknown into a clean, de-duped string array. */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))]
}
