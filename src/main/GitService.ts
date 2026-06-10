import { execFile, execFileSync } from 'child_process'
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
 * Merge `branch` into the base repo's current branch with `git merge --no-ff`.
 * Returns a structured result instead of throwing so the UI can route conflicts
 * to the terminal. The caller is responsible for the base repo being on the
 * intended branch (we check out `baseBranch` first if it differs).
 */
export async function mergeBranch(
  baseFolder: string,
  branch: string,
  baseBranch: string
): Promise<MergeResult> {
  const head = await git(baseFolder, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.code === 0 && head.stdout.trim() !== baseBranch) {
    const co = await git(baseFolder, ['checkout', baseBranch])
    if (co.code !== 0) {
      return { ok: false, conflict: false, output: co.output }
    }
  }
  const res = await git(baseFolder, ['merge', '--no-ff', branch])
  if (res.code === 0) return { ok: true, conflict: false, output: res.output }
  // A merge that stops on conflicts leaves MERGE_HEAD present.
  const merging = await git(baseFolder, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  return { ok: false, conflict: merging.code === 0, output: res.output }
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
      encoding: 'utf8'
    }).trim()
    if (!out) return null
    // With `-C folder`, a relative path is relative to `folder`; resolve also
    // passes through an absolute path unchanged (the linked-worktree case).
    return resolve(folder, out)
  } catch {
    return null
  }
}
