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
 * active tab is a file viewer rather than a terminal.
 */
export function focusActiveTerminal(): void {
  const st = useStore.getState()
  if (st.pendingNewSession || st.pendingWorktree || st.categoriesOpen || st.actionEditor) return
  if (st.paletteOpen) return
  const el = document.activeElement as HTMLElement | null
  if (
    el &&
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
