import type { FsEvent } from '../../shared/types'

type Handler = (events: FsEvent[]) => void

const handlers = new Map<string, Set<Handler>>()

/** Tiny per-session pub/sub for file-system event batches coming from main. */
export const fsBus = {
  on(sessionId: string, handler: Handler): () => void {
    let set = handlers.get(sessionId)
    if (!set) {
      set = new Set()
      handlers.set(sessionId, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) handlers.delete(sessionId)
    }
  },
  emit(sessionId: string, events: FsEvent[]): void {
    handlers.get(sessionId)?.forEach((h) => h(events))
  }
}
