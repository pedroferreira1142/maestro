import { watch, FSWatcher } from 'chokidar'
import { promises as fsp, existsSync } from 'fs'
import { extname, isAbsolute, relative, resolve, sep } from 'path'
import { DirEntry, FileContent, FsEvent } from '../shared/types'

const TEXT_MAX_BYTES = 2 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

interface SessionWatch {
  root: string
  watcher: FSWatcher
  pending: FsEvent[]
  timer: NodeJS.Timeout | null
}

/** Resolve a renderer-supplied relative path against a session root, refusing escapes. */
export function resolveSafe(root: string, relPath: string): string {
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes session folder: ${relPath}`)
  }
  return abs
}

/**
 * Per-session file watching + directory/file reads.
 * Watch scope is bounded: the session root (depth 0) plus explicitly expanded
 * directories, with ignored names excluded at the watcher level.
 */
export class FsService {
  private watches = new Map<string, SessionWatch>()

  constructor(
    private send: (sessionId: string, events: FsEvent[]) => void,
    private getIgnoreNames: () => string[]
  ) {}

  start(sessionId: string, root: string, expandedRel: string[]): void {
    this.stop(sessionId)
    if (!existsSync(root)) return

    const ignored = (p: string): boolean => {
      const rel = relative(root, p)
      if (!rel || rel.startsWith('..')) return false
      const ignore = new Set(this.getIgnoreNames())
      return rel.split(sep).some((seg) => ignore.has(seg))
    }

    const paths = [root]
    for (const rel of expandedRel) {
      try {
        const abs = resolveSafe(root, rel)
        if (existsSync(abs)) paths.push(abs)
      } catch {
        // stale persisted path — skip
      }
    }

    const watcher = watch(paths, { depth: 0, ignoreInitial: true, ignored })
    const entry: SessionWatch = { root, watcher, pending: [], timer: null }
    this.watches.set(sessionId, entry)

    watcher.on('all', (event, p) => {
      if (
        event !== 'add' &&
        event !== 'change' &&
        event !== 'unlink' &&
        event !== 'addDir' &&
        event !== 'unlinkDir'
      ) {
        return
      }
      const rel = relative(root, p)
      if (!rel) return
      entry.pending.push({ kind: event, relPath: rel.split(sep).join('/'), at: Date.now() })
      if (!entry.timer) {
        entry.timer = setTimeout(() => {
          entry.timer = null
          const batch = entry.pending.splice(0, entry.pending.length)
          if (batch.length) this.send(sessionId, batch)
        }, 80)
      }
    })
    watcher.on('error', () => {
      // network drives / locked dirs — non-fatal
    })
  }

  watchPath(sessionId: string, relPath: string): void {
    const entry = this.watches.get(sessionId)
    if (!entry) return
    const abs = resolveSafe(entry.root, relPath)
    if (existsSync(abs)) entry.watcher.add(abs)
  }

  unwatchPath(sessionId: string, relPath: string): void {
    const entry = this.watches.get(sessionId)
    if (!entry) return
    entry.watcher.unwatch(resolveSafe(entry.root, relPath))
  }

  stop(sessionId: string): void {
    const entry = this.watches.get(sessionId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    void entry.watcher.close()
    this.watches.delete(sessionId)
  }

  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id)
  }

  async readDir(root: string, relPath: string): Promise<DirEntry[]> {
    const abs = resolveSafe(root, relPath)
    const dirents = await fsp.readdir(abs, { withFileTypes: true })
    const entries: DirEntry[] = []
    for (const d of dirents) {
      const childRel = relPath ? `${relPath}/${d.name}` : d.name
      let size = 0
      let mtimeMs = 0
      try {
        const st = await fsp.stat(resolve(abs, d.name))
        size = st.size
        mtimeMs = st.mtimeMs
      } catch {
        // broken symlink / locked file — list it anyway
      }
      entries.push({
        name: d.name,
        relPath: childRel,
        isDir: d.isDirectory(),
        size,
        mtimeMs
      })
    }
    entries.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
    )
    return entries
  }

  async readFile(root: string, relPath: string): Promise<FileContent> {
    const abs = resolveSafe(root, relPath)
    const st = await fsp.stat(abs)
    const ext = extname(abs).toLowerCase()

    if (IMAGE_MIME[ext]) {
      const buf = await fsp.readFile(abs)
      return {
        kind: 'image',
        dataUrl: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`,
        size: st.size
      }
    }

    const fh = await fsp.open(abs, 'r')
    try {
      const readBytes = Math.min(st.size, TEXT_MAX_BYTES)
      const buf = Buffer.alloc(readBytes)
      await fh.read(buf, 0, readBytes, 0)
      const sniff = buf.subarray(0, Math.min(8000, buf.length))
      if (sniff.includes(0)) {
        return { kind: 'binary', size: st.size }
      }
      return {
        kind: 'text',
        content: buf.toString('utf8'),
        truncated: st.size > TEXT_MAX_BYTES,
        size: st.size
      }
    } finally {
      await fh.close()
    }
  }
}
