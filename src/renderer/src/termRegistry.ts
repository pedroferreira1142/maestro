import type { SessionInfo } from '../../shared/types'
import { useStore } from './store'

/** Live xterm instances by terminal id, so chrome can hand focus back to them. */
const terms = new Map<string, { focus(): void }>()

export function registerTerm(id: string, term: { focus(): void }): void {
  terms.set(id, term)
}

export function unregisterTerm(id: string): void {
  terms.delete(id)
}

function defaultActive(session: SessionInfo): string {
  return session.config.activeTerminalId ?? session.terminals[0]?.config.id ?? 'terminal'
}

/**
 * Return keyboard focus to the active session's visible terminal — unless the
 * user is typing somewhere else (input/textarea/select, a dialog) or the
 * active tab is a file viewer rather than a terminal. Focus sitting in another
 * terminal doesn't count as "elsewhere": xterm's hidden helper textarea may
 * always be taken over (that's just a terminal-to-terminal switch).
 */
export function focusActiveTerminal(): void {
  const st = useStore.getState()
  if (st.pendingNewSession || st.pendingWorktree || st.categoriesOpen || st.actionEditor) return
  const el = document.activeElement as HTMLElement | null
  if (
    el &&
    !el.classList.contains('xterm-helper-textarea') &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  )
    return
  const session = st.sessions.find((s) => s.config.id === st.activeId)
  if (!session) return
  const tab = st.viewers[session.config.id]?.active ?? defaultActive(session)
  terms.get(tab)?.focus()
}

/**
 * Jump to the longest-waiting 'needs-attention' terminal: activate its session,
 * select its tab and put keyboard focus in it. If the currently viewed terminal
 * is itself a queue entry (e.g. the hotkey was just pressed), advance to the
 * next entry in wait order instead, wrapping around to the oldest.
 */
export function jumpToAttentionTerminal(): void {
  const st = useStore.getState()
  const queue = st.attentionQueue
  if (queue.length === 0) return
  const activeTab = st.activeId ? st.viewers[st.activeId]?.active : undefined
  const idx = queue.findIndex((e) => e.sessionId === st.activeId && e.terminalId === activeTab)
  const target = queue[(idx + 1) % queue.length] // not viewing an entry (idx -1) → oldest
  st.setActive(target.sessionId)
  st.setActiveTab(target.sessionId, target.terminalId)
  // A terminal that just became visible focuses itself; the deferred call covers
  // wrapping back onto the already-visible one (and steals focus from another
  // terminal — see the helper-textarea exception above).
  setTimeout(focusActiveTerminal, 0)
}
