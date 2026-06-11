import type { SessionInfo, TerminalInfo } from '../../shared/types'
import { useStore } from './store'
import { getTranscript } from './termRegistry'

/**
 * Export/copy of a terminal's scrollback as a clean text artifact. The buffer
 * is serialized in termRegistry (rendered cells — no ANSI escapes); this
 * module owns the Markdown framing, file naming and the user-facing flows
 * shared by the command palette and the terminal-tab context menu.
 */

/** Resolve a session and one of its terminals from the store, or null. */
function resolve(
  sessionId: string,
  terminalId: string
): { session: SessionInfo; terminal: TerminalInfo } | null {
  const session = useStore.getState().sessions.find((s) => s.config.id === sessionId)
  const terminal = session?.terminals.find((t) => t.config.id === terminalId)
  return session && terminal ? { session, terminal } : null
}

/**
 * The terminal transcript actions act on: the session's focused terminal tab,
 * falling back to its first terminal when a file/diff tab is focused.
 */
export function transcriptTarget(session: SessionInfo): TerminalInfo | null {
  const active = useStore.getState().viewers[session.config.id]?.active
  return session.terminals.find((t) => t.config.id === active) ?? session.terminals[0] ?? null
}

/** `<session-name>-transcript-<yyyy-mm-dd>.md`, with filename-hostile chars stripped. */
function exportFileName(session: SessionInfo): string {
  const stripped = session.config.name.replace(/[<>:"/\\|?*]/g, '').trim()
  const safe = stripped.replace(/\s+/g, '-') || 'session'
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${safe}-transcript-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`
}

/**
 * A code fence longer than any backtick run in the text, so transcript
 * content (which may itself contain ``` blocks) can't break out of it.
 */
function fenceFor(text: string): string {
  const longest = text.match(/`+/g)?.reduce((m, r) => Math.max(m, r.length), 0) ?? 0
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The Markdown document: metadata header + transcript in a fenced code block. */
function buildMarkdown(
  session: SessionInfo,
  terminal: TerminalInfo,
  branch: string | null,
  transcript: string
): string {
  const lines = [
    `# Transcript — ${session.config.name}`,
    '',
    `- **Session:** ${session.config.name}`,
    `- **Folder:** ${session.config.folder}`,
    `- **Terminal:** ${terminal.config.title}`
  ]
  if (branch) lines.push(`- **Branch:** ${branch}`)
  lines.push(`- **Exported:** ${new Date().toLocaleString()}`)
  const fence = fenceFor(transcript)
  lines.push('', fence, transcript, fence, '')
  return lines.join('\n')
}

/**
 * Export a terminal's transcript as Markdown via the native save dialog.
 * Cancelling is silent; a write failure surfaces the OS error message.
 */
export async function exportTranscript(sessionId: string, terminalId: string): Promise<void> {
  const target = resolve(sessionId, terminalId)
  if (!target) return
  const transcript = getTranscript(terminalId)
  if (transcript === null) return
  let branch: string | null = null
  try {
    const git = await window.api.gitStatus(sessionId)
    if (git.isRepo) branch = git.branch
  } catch {
    // Branch is best-effort metadata — export proceeds without it.
  }
  const md = buildMarkdown(target.session, target.terminal, branch, transcript)
  try {
    const result = await window.api.exportTranscript(sessionId, exportFileName(target.session), md)
    if (result.error) {
      window.alert(`Couldn't write the transcript file:\n\n${result.error}`)
    } else if (!result.canceled) {
      useStore.getState().showNotice('Transcript exported')
    }
  } catch (err) {
    window.alert(`Couldn't export the transcript:\n\n${(err as Error).message}`)
  }
}

/** Copy the cleaned plain transcript (no Markdown framing) to the clipboard. */
export function copyTranscript(terminalId: string): void {
  const transcript = getTranscript(terminalId)
  if (transcript === null) return
  window.api.clipboardWrite(transcript)
  useStore.getState().showNotice('Transcript copied to clipboard')
}
