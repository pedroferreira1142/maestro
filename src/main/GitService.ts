import { execFile, execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { MergeResult, WorktreeInfo } from '../shared/types'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
  /** stdout + stderr trimmed, for surfacing to the user. */
  output: string
}

/**
 * Run a git command in `cwd`. Never rejects on a non-zero exit — callers
 * inspect `code`/`output`. Rejects only if git itself can't be spawned.
 */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('git was not found on PATH'))
          return
        }
        const code = err ? ((err as { code?: number }).code ?? 1) : 0
        const out = `${stdout}${stderr}`.trim()
        resolve({ code, stdout, stderr, output: out })
      }
    )
  })
}

/** A filesystem-safe slug for a branch component (used for the worktree folder name). */
export function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'task'
  )
}

/** Git facts about a folder; safe to call on any path (returns isRepo:false off-repo). */
export async function worktreeInfo(folder: string): Promise<WorktreeInfo> {
  try {
    const inside = await git(folder, ['rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return { isRepo: false, repoRoot: null, branch: null }
    }
    const [root, branch] = await Promise.all([
      git(folder, ['rev-parse', '--show-toplevel']),
      git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ])
    return {
      isRepo: true,
      repoRoot: root.code === 0 ? root.stdout.trim() : null,
      branch: branch.code === 0 ? branch.stdout.trim() : null
    }
  } catch {
    // git missing → treat as "not a repo" so the UI just hides the action.
    return { isRepo: false, repoRoot: null, branch: null }
  }
}

/**
 * Pick a worktree directory for `branch`, as a sibling of the repo:
 * `<parent>/<repo>.worktrees/<branch-slug>`. Kept outside the repo so it's
 * never watched as part of the parent session's tree.
 */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const base = `${basename(repoRoot)}.worktrees`
  return join(dirname(repoRoot), base, slugify(branch).replace(/\//g, '-'))
}

/** `git worktree add -b <branch> <path> <baseBranch>`. Throws with git output on failure. */
export async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<void> {
  const res = await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseBranch])
  if (res.code !== 0) {
    throw new Error(res.output || `git worktree add failed (exit ${res.code})`)
  }
}

/**
 * Files that would conflict if `branch` were merged into `baseBranch`, computed
 * in-memory with `git merge-tree` — no working tree, index, or HEAD is touched.
 * Returns [] for a clean merge, or null if the refs can't be compared.
 */
export async function mergeConflictFiles(
  baseFolder: string,
  branch: string,
  baseBranch: string
): Promise<string[] | null> {
  // --name-only lists conflicted paths; exit 1 means conflicts, 0 means clean.
  const res = await git(baseFolder, ['merge-tree', '--write-tree', '--name-only', baseBranch, branch])
  if (res.code === 0) return []
  if (res.code !== 1) return null // ref missing / not mergeable / old git
  // Output: <tree-oid>\n<conflicted paths...>\n\n<informational messages>
  const lines = res.stdout.split(/\r?\n/)
  const files: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') break // blank line separates file list from messages
    files.push(l.trim())
  }
  return files
}

/**
 * Merge `branch` into `baseBranch` in the base repo with `git merge --no-ff`.
 * Safe by construction: refuses if the base working tree is dirty, and on
 * conflict runs `git merge --abort` so the base checkout is never left in a
 * half-merged state — the caller's repo stays exactly as it was. Returns a
 * structured result instead of throwing.
 */
export async function mergeBranch(
  baseFolder: string,
  branch: string,
  baseBranch: string
): Promise<MergeResult> {
  // Don't risk the user's live working tree.
  const dirty = await dirtyCount(baseFolder)
  if (dirty && dirty > 0) {
    return {
      ok: false,
      conflict: false,
      output:
        `The base repo (${baseFolder}) has ${dirty} uncommitted file(s). ` +
        `Commit or stash them there before merging, so a merge can't clobber your work.`
    }
  }

  // Predict conflicts without mutating anything.
  const conflicts = await mergeConflictFiles(baseFolder, branch, baseBranch)
  if (conflicts && conflicts.length > 0) {
    return {
      ok: false,
      conflict: true,
      output:
        `Merging "${branch}" into "${baseBranch}" would conflict in:\n` +
        conflicts.map((f) => `  • ${f}`).join('\n') +
        `\n\nThe base repo was left untouched. To resolve manually, run in ${baseFolder}:\n` +
        `  git merge --no-ff ${branch}\n` +
        `  (fix conflicts, then) git commit\n` +
        `  or abort with: git merge --abort`
    }
  }

  const head = await git(baseFolder, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.code === 0 && head.stdout.trim() !== baseBranch) {
    const co = await git(baseFolder, ['checkout', baseBranch])
    if (co.code !== 0) return { ok: false, conflict: false, output: co.output }
  }

  const res = await git(baseFolder, ['merge', '--no-ff', branch])
  if (res.code === 0) return { ok: true, conflict: false, output: res.output }

  // Shouldn't happen (pre-flight was clean), but never leave a half-merge behind.
  const merging = await git(baseFolder, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  if (merging.code === 0) await git(baseFolder, ['merge', '--abort'])
  return {
    ok: false,
    conflict: merging.code === 0,
    output: `Merge failed and was rolled back:\n${res.output}`
  }
}

/** Number of dirty (changed/untracked) files in a working tree; null if not a repo. */
export async function dirtyCount(folder: string): Promise<number | null> {
  try {
    const res = await git(folder, ['status', '--porcelain'])
    if (res.code !== 0) return null
    return res.stdout.split(/\r?\n/).filter((l) => l.trim()).length
  } catch {
    return null
  }
}

/** Commits on `branch` that aren't on `base`; null when either ref is unknown. */
export async function aheadCount(
  repoRoot: string,
  base: string,
  branch: string
): Promise<number | null> {
  try {
    const res = await git(repoRoot, ['rev-list', '--count', `${base}..${branch}`])
    if (res.code !== 0) return null
    const n = Number.parseInt(res.stdout.trim(), 10)
    return Number.isNaN(n) ? null : n
  } catch {
    return null
  }
}

/** Stage everything and commit. Returns ok:false (with output) when there's nothing to commit. */
export async function commitAll(folder: string, message: string): Promise<GitResult> {
  const add = await git(folder, ['add', '-A'])
  if (add.code !== 0) return add
  return git(folder, ['commit', '-m', message])
}

/** True if a local branch with this name exists. */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const res = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return res.code === 0
}

/** Absolute paths of all registered worktrees (normalized to forward slashes). */
export async function listWorktreePaths(repoRoot: string): Promise<string[]> {
  const res = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  if (res.code !== 0) return []
  return res.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim().replace(/\\/g, '/'))
}

/** `git worktree add <path> <branch>` for an EXISTING branch. Throws on failure. */
export async function addWorktreeForBranch(
  repoRoot: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  const res = await git(repoRoot, ['worktree', 'add', worktreePath, branch])
  if (res.code !== 0) {
    throw new Error(res.output || `git worktree add failed (exit ${res.code})`)
  }
}

/** Drop stale worktree registrations (deleted folders). Best-effort. */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await git(repoRoot, ['worktree', 'prune'])
}

/** Patterns copied into a fresh worktree when no .worktreeinclude is present. */
const DEFAULT_INCLUDES = ['.env', '.env.local', '.env.*', '.envrc']

/** Parse a .worktreeinclude (gitignore-ish: one pattern per line, # comments). */
function readIncludePatterns(repoRoot: string): string[] {
  const file = join(repoRoot, '.worktreeinclude')
  if (!existsSync(file)) return DEFAULT_INCLUDES
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  } catch {
    return DEFAULT_INCLUDES
  }
}

/** Resolve a single pattern to existing relative file paths under repoRoot. */
function expandPattern(repoRoot: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  const slash = norm.lastIndexOf('/')
  const dirRel = slash >= 0 ? norm.slice(0, slash) : ''
  const namePart = slash >= 0 ? norm.slice(slash + 1) : norm
  const dirAbs = join(repoRoot, dirRel)
  if (!namePart.includes('*')) {
    const rel = dirRel ? `${dirRel}/${namePart}` : namePart
    return existsSync(join(repoRoot, rel)) ? [rel] : []
  }
  // Single-level basename glob (e.g. .env.* ) within dirRel.
  const re = new RegExp('^' + namePart.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  try {
    return readdirSync(dirAbs)
      .filter((n) => re.test(n))
      .map((n) => (dirRel ? `${dirRel}/${n}` : n))
      .filter((rel) => statSync(join(repoRoot, rel)).isFile())
  } catch {
    return []
  }
}

/**
 * Copy gitignored local config (e.g. .env) from the main checkout into a fresh
 * worktree, mirroring Claude Code's `.worktreeinclude`. Only files that match a
 * pattern AND are gitignored are copied (so tracked files are never duplicated),
 * and existing destination files are left alone. Best-effort; returns the count.
 */
export function copyWorktreeIncludes(repoRoot: string, worktreePath: string): number {
  let copied = 0
  const seen = new Set<string>()
  for (const pattern of readIncludePatterns(repoRoot)) {
    for (const rel of expandPattern(repoRoot, pattern)) {
      if (seen.has(rel)) continue
      seen.add(rel)
      const src = join(repoRoot, rel)
      const dest = join(worktreePath, rel)
      if (existsSync(dest)) continue // never clobber what's already there
      // Only copy if git actually ignores it (exit 0 = ignored).
      try {
        execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', '--', rel], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {
        continue // not ignored (tracked) or check failed → skip
      }
      try {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(src, dest)
        copied++
      } catch {
        // best-effort per file
      }
    }
  }
  return copied
}

/** `git worktree remove [--force] <path>`. Throws with git output on failure. */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  force: boolean
): Promise<void> {
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]
  const res = await git(repoRoot, args)
  if (res.code !== 0) throw new Error(res.output || 'git worktree remove failed')
}

/** Delete a branch (`-D` when force). Best-effort — never throws. */
export async function deleteBranch(
  repoRoot: string,
  branch: string,
  force: boolean
): Promise<void> {
  await git(repoRoot, ['branch', force ? '-D' : '-d', branch])
}

/**
 * Resolve the path to a folder's `info/exclude` file via git, which is correct
 * for both ordinary repos and linked worktrees (whose `.git` is a file pointing
 * at the shared git dir). Returns null if git can't resolve it.
 */
export function excludeFilePathSync(folder: string): string | null {
  try {
    // execFileSync is fine here — this runs once before a claude terminal spawns.
    const out = execFileSync('git', ['-C', folder, 'rev-parse', '--git-path', 'info/exclude'], {
      windowsHide: true,
      encoding: 'utf8',
      // Suppress "fatal: not a git repository" leaking to the app console.
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!out) return null
    // With `-C folder`, a relative path is relative to `folder`; resolve also
    // passes through an absolute path unchanged (the linked-worktree case).
    return resolve(folder, out)
  } catch {
    return null
  }
}
