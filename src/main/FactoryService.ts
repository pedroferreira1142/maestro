import { BrowserWindow, shell } from 'electron'
import { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import {
  FactoryArtifact,
  FactoryArtifactKind,
  FactoryAudit,
  FactoryCandidate,
  FactoryLesson,
  FactoryRun,
  FactorySource,
  FactoryState
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
  /** The in-flight agent child, so dispose()/cancel() can kill it. */
  private inFlight: ChildProcess | null = null
  private busy = false
  /** Set by cancel(); the in-flight scan/author reports 'cancelled' instead of 'error'. */
  private cancelRequested = false

  constructor(private getWin: () => BrowserWindow | null) {
    this.state = this.store.load()
    this.runs = restoreRuns(this.store.loadRuns())
  }

  getState(): FactoryState {
    return this.state
  }

  listRuns(): FactoryRun[] {
    return this.runs
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
   */
  async listSources(refresh = false): Promise<FactorySource[]> {
    if (this.sources && !refresh) return this.sources
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

    const out = await runHeadlessClaude({
      cwd: process.cwd(),
      prompt,
      allowedTools: ['Read'],
      timeoutMs: DISCOVER_TIMEOUT_MS,
      onSpawn: (child) => (this.inFlight = child)
    }).finally(() => (this.inFlight = null))

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

  /** Explore a source and propose skill/agent candidates. */
  async scan(serverKey: string, guidance: string): Promise<void> {
    if (this.busy) return
    const sources = await this.listSources()
    const source = sources.find((s) => s.server === serverKey)
    if (!source) throw new Error(`Unknown source: ${serverKey}`)
    this.busy = true
    this.cancelRequested = false

    const run: FactoryRun = {
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

    try {
      const allowedTools = ['Read', 'Grep', 'Glob', source.toolPrefix, ...source.readTools]
      run.phase = 'discovering'
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
      run.status = this.cancelRequested ? 'cancelled' : 'error'
      run.phase = 'done'
      run.summary = this.cancelRequested ? 'Cancelled.' : (err as Error).message || String(err)
    } finally {
      run.finishedAt = Date.now()
      this.inFlight = null
      this.busy = false
      this.broadcastRuns()
    }
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
    this.busy = true
    this.cancelRequested = false
    candidate.status = 'authoring'
    candidate.result = undefined
    this.broadcastRuns()

    try {
      const source =
        (await this.listSources()).find((s) => s.server === run.source) ??
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
      this.busy = false
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
