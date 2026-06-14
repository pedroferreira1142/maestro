import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ConversationSearchHit, ConversationSummary } from '../shared/types'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** Longest preview kept; the renderer further clamps it to one visual line. */
const PREVIEW_MAX_CHARS = 160

/**
 * Same path encoding Claude Code uses for its `~/.claude/projects/<dir>` names:
 * every character that isn't a letter or digit becomes '-'. Mirrors encodeFolder
 * in StatusBar.tsx / UsageWidget.tsx so we look in the directory claude wrote to.
 */
function encodeFolder(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Textual content of a transcript `message`, or null when it carries no text
 * (e.g. a tool-result-only or otherwise non-textual entry). Content is either a
 * plain string or an array of content blocks; only `text` blocks contribute.
 */
function messageText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content.trim() || null
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        parts.push((block as Record<string, unknown>).text as string)
      }
    }
    const joined = parts.join(' ').trim()
    return joined || null
  }
  return null
}

/** Collapse a message body to a single trimmed display line. */
function toPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > PREVIEW_MAX_CHARS ? oneLine.slice(0, PREVIEW_MAX_CHARS) + '…' : oneLine
}

/**
 * Summarize one transcript .jsonl. Parsing is tolerant per line (mirroring
 * UsageService.parseFile): a malformed or half-written line is skipped, so a
 * transcript still in the middle of being written summarizes from the lines
 * that did parse. Returns null only when nothing at all could be read.
 */
function summarizeFile(path: string, id: string): ConversationSummary | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let messageCount = 0
  let lastActivityAt = 0
  let preview = ''
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const type = obj.type
    if (type !== 'user' && type !== 'assistant') continue
    messageCount++
    const at = Date.parse(typeof obj.timestamp === 'string' ? obj.timestamp : '')
    if (Number.isFinite(at) && at > lastActivityAt) lastActivityAt = at
    // First textual user message becomes the preview; tool-result/meta-only
    // entries carry no text and are skipped so they never become the preview.
    if (!preview && type === 'user' && obj.isMeta !== true) {
      const text = messageText(obj.message)
      if (text) preview = toPreview(text)
    }
  }
  return { id, lastActivityAt, messageCount, preview }
}

/**
 * List the prior Claude Code conversations for a repo folder, newest first, by
 * reading `~/.claude/projects/<encoded>/*.jsonl`. Returns [] (never throws) when
 * the encoded project directory is missing or holds no transcripts, so the
 * picker can show an explicit empty state.
 */
export function listConversations(folder: string): ConversationSummary[] {
  const dir = join(PROJECTS_DIR, encodeFolder(folder))
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const out: ConversationSummary[] = []
  for (const file of files) {
    const summary = summarizeFile(join(dir, file), file.slice(0, -'.jsonl'.length))
    if (summary) out.push(summary)
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return out
}

// ---------- full-text history recall (search across ALL conversations) ----------

/** Shortest query searched — below this every conversation would match. */
const SEARCH_MIN_QUERY = 2
/** Stop counting a single conversation's matches once it hits this (UI safety). */
const SEARCH_MAX_PER_CONVERSATION = 50
/** Cap on returned conversations so a very common term can't flood the renderer. */
const SEARCH_MAX_RESULTS = 100
/** Context characters kept before/after the first match in a snippet. */
const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 140

/** One transcript parsed for search, cached and reused across queries. */
interface SearchableConversation {
  /** Transcript filename stem — the id claude resumes with `--resume`. */
  id: string
  /** Real working directory from the line's `cwd` field (most-recent non-empty). */
  cwd: string
  /** Newest user/assistant timestamp, ms since epoch. */
  lastActivityAt: number
  /** Extracted text, one entry per user/assistant message, in order. */
  messages: string[]
}

interface SearchFileCache {
  mtimeMs: number
  size: number
  conv: SearchableConversation
}

/**
 * Per-file mtime/size cache so repeated searches re-parse only changed
 * transcripts (mirrors UsageService.entriesFor). The parsed form is
 * query-independent, so it is reused across every query.
 */
const searchCache = new Map<string, SearchFileCache>()

/** A whitespace-collapsed window around the first match, ellipsed at the edges. */
function makeSnippet(text: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_BEFORE)
  const end = Math.min(text.length, matchIndex + queryLength + SNIPPET_AFTER)
  const core = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '… ' : '') + core + (end < text.length ? ' …' : '')
}

/** Parse one transcript into the searchable, query-independent shape. */
function parseForSearch(path: string, id: string): SearchableConversation {
  const conv: SearchableConversation = { id, cwd: '', lastActivityAt: 0, messages: [] }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return conv
  }
  for (const line of raw.split('\n')) {
    // Cheap pre-filter: only user/assistant lines carry searchable text + cwd.
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue
    const text = messageText(obj.message)
    if (text) conv.messages.push(text)
    if (typeof obj.cwd === 'string' && obj.cwd) conv.cwd = obj.cwd
    const at = Date.parse(typeof obj.timestamp === 'string' ? obj.timestamp : '')
    if (Number.isFinite(at) && at > conv.lastActivityAt) conv.lastActivityAt = at
  }
  return conv
}

function searchableFor(path: string, id: string): SearchableConversation {
  let stat: { mtimeMs: number; size: number }
  try {
    stat = statSync(path)
  } catch {
    searchCache.delete(path)
    return { id, cwd: '', lastActivityAt: 0, messages: [] }
  }
  const cached = searchCache.get(path)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.conv
  const conv = parseForSearch(path, id)
  searchCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, conv })
  return conv
}

/**
 * Full-text search across every past Claude Code conversation on disk
 * (`~/.claude/projects/*​/*.jsonl`, the same files UsageService reads),
 * newest-activity first. Read-only — nothing is ever written. Returns [] (never
 * throws) for a blank/too-short query or when the projects directory is missing.
 * Results are bounded (≤100 conversations, ≤50 counted matches each) so a very
 * common term can't freeze the UI.
 */
export function searchConversations(query: string): ConversationSearchHit[] {
  const q = query.trim()
  if (q.length < SEARCH_MIN_QUERY) return []
  const needle = q.toLowerCase()

  let projectDirs: string[] = []
  try {
    if (existsSync(PROJECTS_DIR)) projectDirs = readdirSync(PROJECTS_DIR)
  } catch {
    return []
  }

  const hits: ConversationSearchHit[] = []
  const liveFiles = new Set<string>()
  for (const dir of projectDirs) {
    const dirPath = join(PROJECTS_DIR, dir)
    let files: string[]
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(dirPath, file)
      liveFiles.add(path)
      const conv = searchableFor(path, file.slice(0, -'.jsonl'.length))

      let matchCount = 0
      let snippet: string | null = null
      for (const text of conv.messages) {
        const lower = text.toLowerCase()
        let idx = lower.indexOf(needle)
        while (idx !== -1) {
          if (!snippet) snippet = makeSnippet(text, idx, q.length)
          if (++matchCount >= SEARCH_MAX_PER_CONVERSATION) break
          idx = lower.indexOf(needle, idx + needle.length)
        }
        if (matchCount >= SEARCH_MAX_PER_CONVERSATION) break
      }
      if (matchCount > 0 && snippet) {
        hits.push({
          conversationId: conv.id,
          cwd: conv.cwd,
          lastActivityAt: conv.lastActivityAt,
          matchCount,
          snippet
        })
      }
    }
  }

  // Drop cache entries for transcript files that no longer exist.
  for (const path of [...searchCache.keys()]) {
    if (!liveFiles.has(path)) searchCache.delete(path)
  }

  hits.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return hits.slice(0, SEARCH_MAX_RESULTS)
}
