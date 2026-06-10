import { app, clipboard, nativeImage } from 'electron'
import { promises as fsp } from 'fs'
import { basename, extname, join } from 'path'
import type { AttachmentInfo } from '../shared/types'

/**
 * Stores images attached to a session's chat. Files live under
 * userData/attachments/<sessionId>/ so the history is derived from disk —
 * nothing extra to persist, and it survives renderer crashes/reloads.
 */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const THUMB_HEIGHT = 64
const MAX_LISTED = 100

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

function rootFor(sessionId: string): string {
  // sessionId comes from our own persisted configs, but it lands in a path —
  // refuse anything that could escape the attachments root.
  if (!/^[\w-]+$/.test(sessionId)) throw new Error(`Bad session id: ${sessionId}`)
  return join(app.getPath('userData'), 'attachments', sessionId)
}

export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase())
}

/** Filenames are timestamp-prefixed so lexical order ≈ chronological order. */
function uniqueName(original: string): string {
  const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  const safe = basename(original).replace(/[^\w.-]+/g, '_')
  return `${stamp}_${safe}`
}

function thumbOf(absPath: string): string {
  const img = nativeImage.createFromPath(absPath)
  if (img.isEmpty()) return ''
  const { height } = img.getSize()
  return (height > THUMB_HEIGHT ? img.resize({ height: THUMB_HEIGHT }) : img).toDataURL()
}

async function toInfo(sessionId: string, fileName: string): Promise<AttachmentInfo> {
  const absPath = join(rootFor(sessionId), fileName)
  const stat = await fsp.stat(absPath)
  return { fileName, absPath, at: stat.mtimeMs, size: stat.size, thumbDataUrl: thumbOf(absPath) }
}

async function save(sessionId: string, fileName: string, data: Buffer): Promise<AttachmentInfo> {
  const root = rootFor(sessionId)
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(join(root, fileName), data)
  return toInfo(sessionId, fileName)
}

/** Save the clipboard image (if any) as a PNG attachment. Null if no image. */
export async function attachClipboardImage(sessionId: string): Promise<AttachmentInfo | null> {
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  return save(sessionId, uniqueName('pasted.png'), img.toPNG())
}

/** Copy an image file (e.g. dropped from Explorer) into the session's attachments. */
export async function attachImageFile(
  sessionId: string,
  srcPath: string
): Promise<AttachmentInfo | null> {
  if (!isImagePath(srcPath)) return null
  return save(sessionId, uniqueName(srcPath), await fsp.readFile(srcPath))
}

/** Save raw image bytes (dropped content without a filesystem path). */
export async function attachImageData(
  sessionId: string,
  name: string,
  bytes: Uint8Array
): Promise<AttachmentInfo | null> {
  if (!isImagePath(name)) return null
  return save(sessionId, uniqueName(name), Buffer.from(bytes))
}

/** Newest-first attachment history for a session. */
export async function listAttachments(sessionId: string): Promise<AttachmentInfo[]> {
  let names: string[]
  try {
    names = await fsp.readdir(rootFor(sessionId))
  } catch {
    return [] // no folder yet — nothing attached
  }
  const infos = await Promise.all(
    names.filter(isImagePath).map((n) => toInfo(sessionId, n).catch(() => null))
  )
  return infos
    .filter((i): i is AttachmentInfo => i !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_LISTED)
}

/** Full-size image as a data URL, for the preview lightbox. */
export async function readAttachment(sessionId: string, fileName: string): Promise<string> {
  if (fileName !== basename(fileName)) throw new Error(`Bad attachment name: ${fileName}`)
  const data = await fsp.readFile(join(rootFor(sessionId), fileName))
  const mime = MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream'
  return `data:${mime};base64,${data.toString('base64')}`
}

export async function deleteAttachment(sessionId: string, fileName: string): Promise<void> {
  if (fileName !== basename(fileName)) throw new Error(`Bad attachment name: ${fileName}`)
  await fsp.rm(join(rootFor(sessionId), fileName), { force: true })
}

/** Drop a closed session's whole attachment folder. */
export async function deleteAllAttachments(sessionId: string): Promise<void> {
  await fsp.rm(rootFor(sessionId), { recursive: true, force: true })
}
