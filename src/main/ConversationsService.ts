import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ConversationSummary } from '../shared/types'

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
