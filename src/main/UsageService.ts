import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ProjectUsage, TokenTotals, UsageSnapshot } from '../shared/types'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/**
 * USD per million tokens, matched against the model id in transcript order.
 * Cache write is priced off the input rate: 1.25x for 5-minute TTL entries,
 * 2x for 1-hour TTL entries; cache reads are 0.1x input.
 */
const PRICING: { match: RegExp; input: number; output: number }[] = [
  { match: /fable/, input: 10, output: 50 },
  { match: /opus-4-[5-9]/, input: 5, output: 25 },
  { match: /opus/, input: 15, output: 75 },
  { match: /sonnet/, input: 3, output: 15 },
  { match: /haiku-4/, input: 1, output: 5 },
  { match: /3-5-haiku|haiku-3-5/, input: 0.8, output: 4 },
  { match: /haiku/, input: 0.25, output: 1.25 }
]

interface ParsedEntry {
  /** Dedup key — the same API response is logged multiple times (one line per
   *  content block, and again in resumed-session files). */
  key: string
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  /** Entry timestamp, ms since epoch. */
  at: number
  model: string
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  costUSD: number
}

interface FileCache {
  mtimeMs: number
  size: number
  entries: ParsedEntry[]
}

function zeroTotals(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUSD: 0 }
}

function add(t: TokenTotals, e: ParsedEntry): void {
  t.inputTokens += e.input
  t.outputTokens += e.output
  t.cacheWriteTokens += e.cacheWrite5m + e.cacheWrite1h
  t.cacheReadTokens += e.cacheRead
  t.costUSD += e.costUSD
}

function localDay(at: number): string {
  const d = new Date(at)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function computeCost(entry: ParsedEntry): number {
  const price = PRICING.find((p) => p.match.test(entry.model))
  if (!price) return 0
  return (
    (entry.input * price.input +
      entry.output * price.output +
      entry.cacheWrite5m * price.input * 1.25 +
      entry.cacheWrite1h * price.input * 2 +
      entry.cacheRead * price.input * 0.1) /
    1_000_000
  )
}

/** Parse one transcript .jsonl, keeping only assistant entries that carry usage. */
function parseFile(path: string): ParsedEntry[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const entries: ParsedEntry[] = []
  for (const line of raw.split('\n')) {
    // Cheap pre-filter: the vast majority of lines are not assistant messages.
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type !== 'assistant') continue
    const message = obj.message as Record<string, unknown> | undefined
    const usage = message?.usage as Record<string, unknown> | undefined
    const model = typeof message?.model === 'string' ? message.model : ''
    if (!usage || !model || model === '<synthetic>') continue

    const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined
    const totalWrite = num(usage.cache_creation_input_tokens)
    const write1h = num(cacheCreation?.ephemeral_1h_input_tokens)
    // Without a TTL breakdown, attribute all cache writes to the 5m bucket.
    const write5m = cacheCreation ? num(cacheCreation.ephemeral_5m_input_tokens) : totalWrite

    const at = Date.parse(typeof obj.timestamp === 'string' ? obj.timestamp : '') || 0
    const msgId = typeof message?.id === 'string' ? message.id : (obj.uuid as string) ?? ''
    const entry: ParsedEntry = {
      key: `${msgId}:${typeof obj.requestId === 'string' ? obj.requestId : ''}`,
      day: localDay(at),
      at,
      model,
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
      cacheRead: num(usage.cache_read_input_tokens),
      costUSD: 0
    }
    // Older Claude Code versions wrote a precomputed cost; prefer it when present.
    const precomputed = num(obj.costUSD)
    entry.costUSD = precomputed > 0 ? precomputed : computeCost(entry)
    entries.push(entry)
  }
  return entries
}

/**
 * Aggregates Claude Code token usage/cost from the transcript files under
 * `~/.claude/projects`. Files are re-parsed only when their mtime/size change,
 * so repeated snapshots are cheap; duplicate log lines for the same API
 * response (same message id + request id) are counted once.
 */
export class UsageService {
  private fileCache = new Map<string, FileCache>()

  snapshot(): UsageSnapshot {
    const now = Date.now()
    const today = localDay(now)
    const monthPrefix = today.slice(0, 7)

    const total = zeroTotals()
    const todayTotals = zeroTotals()
    const month = zeroTotals()
    const perModel = new Map<string, TokenTotals>()
    const perProject: ProjectUsage[] = []
    const seen = new Set<string>()
    const liveFiles = new Set<string>()

    let projectDirs: string[] = []
    try {
      if (existsSync(PROJECTS_DIR)) projectDirs = readdirSync(PROJECTS_DIR)
    } catch {
      projectDirs = []
    }

    for (const dir of projectDirs) {
      const dirPath = join(PROJECTS_DIR, dir)
      let files: string[]
      try {
        files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      const project: ProjectUsage = {
        dir,
        total: zeroTotals(),
        today: zeroTotals(),
        lastActivityAt: 0
      }
      for (const file of files) {
        const path = join(dirPath, file)
        liveFiles.add(path)
        for (const entry of this.entriesFor(path)) {
          if (seen.has(entry.key)) continue
          seen.add(entry.key)
          add(total, entry)
          add(project.total, entry)
          if (entry.day === today) {
            add(todayTotals, entry)
            add(project.today, entry)
          }
          if (entry.day.startsWith(monthPrefix)) add(month, entry)
          let m = perModel.get(entry.model)
          if (!m) perModel.set(entry.model, (m = zeroTotals()))
          add(m, entry)
          if (entry.at > project.lastActivityAt) project.lastActivityAt = entry.at
        }
      }
      if (project.total.costUSD > 0 || project.total.outputTokens > 0) perProject.push(project)
    }

    // Drop cache entries for files that no longer exist.
    for (const path of [...this.fileCache.keys()]) {
      if (!liveFiles.has(path)) this.fileCache.delete(path)
    }

    perProject.sort((a, b) => b.total.costUSD - a.total.costUSD)
    return {
      total,
      today: todayTotals,
      month,
      perProject,
      perModel: [...perModel.entries()]
        .map(([model, totals]) => ({ model, totals }))
        .sort((a, b) => b.totals.costUSD - a.totals.costUSD),
      updatedAt: now
    }
  }

  private entriesFor(path: string): ParsedEntry[] {
    let stat: { mtimeMs: number; size: number }
    try {
      stat = statSync(path)
    } catch {
      this.fileCache.delete(path)
      return []
    }
    const cached = this.fileCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entries
    }
    const entries = parseFile(path)
    this.fileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, entries })
    return entries
  }
}
