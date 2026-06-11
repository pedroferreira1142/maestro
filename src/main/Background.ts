import { app } from 'electron'
import { promises as fsp } from 'fs'
import { basename, extname, join } from 'path'

/**
 * Stores the user's custom app background image. Exactly one file lives under
 * userData/background/ at a time; its name is persisted in settings and the
 * renderer receives the image as a data URL (file:// is blocked by the
 * dev-server origin + webSecurity, data URLs are the established pattern here).
 */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

function root(): string {
  return join(app.getPath('userData'), 'background')
}

export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase())
}

/**
 * Copy `srcPath` in as the new background, replacing any previous one.
 * Returns the stored file name, or null when the file isn't a known image type.
 */
export async function saveBackgroundImage(srcPath: string): Promise<string | null> {
  if (!isImagePath(srcPath)) return null
  const data = await fsp.readFile(srcPath)
  const fileName = `background-${Date.now().toString(36)}${extname(srcPath).toLowerCase()}`
  await fsp.mkdir(root(), { recursive: true })
  await clearBackgroundImage()
  await fsp.writeFile(join(root(), fileName), data)
  return fileName
}

/** The stored background as a data URL, or null when missing/unreadable. */
export async function readBackgroundImage(fileName: string | null): Promise<string | null> {
  if (!fileName || fileName !== basename(fileName)) return null
  try {
    const data = await fsp.readFile(join(root(), fileName))
    const mime = MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

/** Remove all stored background files (there is at most one). */
export async function clearBackgroundImage(): Promise<void> {
  try {
    const names = await fsp.readdir(root())
    await Promise.all(names.map((n) => fsp.rm(join(root(), n), { force: true })))
  } catch {
    // no folder yet — nothing to clear
  }
}
