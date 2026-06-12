import { execFile, execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import type {
  BranchListing,
  GitCommit,
  GitFileChange,
  GitFileDiff,
  GitStatus,
  MergeResult,
  PullRequestResult,
  RepoCheckpoint,
  RestoreCheckpointResult,
  WorktreeInfo
} from '../shared/types'

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
 * `env` entries are merged over the inherited environment (used by the
 * checkpoint helpers to redirect GIT_INDEX_FILE / set a commit identity).
 */
function git(cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        ...(env ? { env: { ...process.env, ...env } } : {})
      },
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
 * Local branches of `folder`'s repo plus its default branch, for the
 * Conductor's base-branch dropdown. The default branch is what origin/HEAD
 * points at; when that isn't recorded locally we fall back to main, then
 * master, then the current branch. Safe on any path (empty listing off-repo).
 */
export async function listBranches(folder: string): Promise<BranchListing> {
  try {
    const [refs, head] = await Promise.all([
      git(folder, ['for-each-ref', 'refs/heads', '--sort=refname', '--format=%(refname:short)']),
      git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ])
    if (refs.code !== 0) return { branches: [], current: null, defaultBranch: null }
    const branches = refs.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const current = head.code === 0 && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : null

    let defaultBranch: string | null = null
    const originHead = await git(folder, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (originHead.code === 0) {
      const name = originHead.stdout.trim().replace(/^origin\//, '')
      if (branches.includes(name)) defaultBranch = name
    }
    if (!defaultBranch) {
      defaultBranch =
        ['main', 'master'].find((b) => branches.includes(b)) ??
        (current && branches.includes(current) ? current : (branches[0] ?? null))
    }
    return { branches, current, defaultBranch }
  } catch {
    return { branches: [], current: null, defaultBranch: null }
  }
}

/**
 * Initialize a new git repository in `folder` and ensure HEAD points at a
 * commit, so the folder can immediately host worktree tasks (`git worktree add`
 * needs at least one commit — a fresh repo's branch is unborn). The user's
 * existing files are left untracked; we only add an empty initial commit. The
 * initial commit uses the user's configured git identity — if none is set, git
 * fails and that message is surfaced to the caller. No-op-safe on an existing repo.
 */
export async function gitInit(folder: string): Promise<GitResult> {
  const init = await git(folder, ['init'])
  if (init.code !== 0) return init
  const hasHead = await git(folder, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (hasHead.code !== 0) {
    const commit = await git(folder, ['commit', '--allow-empty', '-m', 'Initial commit'])
    if (commit.code !== 0) return commit
  }
  return init
}

/** Working-tree + branch state for the Git panel. Safe on any path. */
export async function gitStatus(folder: string): Promise<GitStatus> {
  const base: GitStatus = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    remoteUrl: null
  }
  try {
    const res = await git(folder, ['status', '--porcelain=v2', '--branch'])
    if (res.code !== 0) return base
    const out: GitStatus = { ...base, isRepo: true }
    for (const line of res.stdout.split(/\r?\n/)) {
      if (line.startsWith('# branch.head ')) {
        const b = line.slice('# branch.head '.length).trim()
        out.branch = b === '(detached)' ? null : b
      } else if (line.startsWith('# branch.upstream ')) {
        out.upstream = line.slice('# branch.upstream '.length).trim() || null
      } else if (line.startsWith('# branch.ab ')) {
        const m = line.slice('# branch.ab '.length).trim().match(/\+(\d+)\s+-(\d+)/)
        if (m) {
          out.ahead = Number.parseInt(m[1], 10)
          out.behind = Number.parseInt(m[2], 10)
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // "<1|2> XY ..." — X = staged, Y = unstaged; '.' means unmodified.
        const xy = line.slice(2, 4)
        if (xy[0] && xy[0] !== '.') out.staged++
        if (xy[1] && xy[1] !== '.') out.unstaged++
      } else if (line.startsWith('? ')) {
        out.untracked++
      } else if (line.startsWith('u ')) {
        out.unstaged++ // unmerged (conflicted) path
      }
    }
    const remote = await git(folder, ['remote', 'get-url', 'origin'])
    if (remote.code === 0) out.remoteUrl = remote.stdout.trim() || null
    return out
  } catch {
    return base
  }
}

/** Everything after the first `n` space-separated fields of a porcelain-v2 line. */
function skipFields(line: string, n: number): string {
  let idx = 0
  for (let i = 0; i < n; i++) {
    const next = line.indexOf(' ', idx)
    if (next < 0) return ''
    idx = next + 1
  }
  return line.slice(idx)
}

/**
 * Changed files (staged, unstaged, untracked, unmerged) in a working tree,
 * parsed from `git status --porcelain=v2`. Paths are repo-root-relative and
 * unquoted in v2, so names with spaces survive. [] for a non-repo folder.
 */
export async function gitChangedFiles(folder: string): Promise<GitFileChange[]> {
  try {
    const res = await git(folder, ['status', '--porcelain=v2'])
    if (res.code !== 0) return []
    const files: GitFileChange[] = []
    for (const line of res.stdout.split(/\r?\n/)) {
      if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // "1 XY sub mH mI mW hH hI <path>" / "2 ... X<score> <path>\t<origPath>"
        const xy = line.slice(2, 4)
        const status = (xy[0] === '.' ? '' : xy[0]) + (xy[1] === '.' ? '' : xy[1])
        const staged = xy[0] !== '.'
        const rest = skipFields(line, line.startsWith('1 ') ? 8 : 9)
        if (!rest) continue
        const tab = rest.indexOf('\t')
        files.push({
          path: tab >= 0 ? rest.slice(0, tab) : rest,
          status: status || 'M',
          staged,
          origPath: tab >= 0 ? rest.slice(tab + 1) : undefined
        })
      } else if (line.startsWith('u ')) {
        // "u XY sub m1 m2 m3 mW h1 h2 h3 <path>" — unmerged (conflicted)
        const path = skipFields(line, 10)
        if (path) files.push({ path, status: 'U', staged: false })
      } else if (line.startsWith('? ')) {
        files.push({ path: line.slice(2), status: '?', staged: false })
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    return files
  } catch {
    return []
  }
}

/** Cap on the diff text sent to the renderer; beyond it the diff is truncated. */
const MAX_DIFF_CHARS = 500_000

/**
 * Unified diff of one file's working-tree state against HEAD (staged plus
 * unstaged combined). Untracked files — which HEAD knows nothing about — are
 * rendered whole as added lines via a no-index diff against the null device.
 * `path` is repo-root-relative (as produced by gitChangedFiles), so the diff
 * runs from the repo root even when `folder` is a subdirectory.
 */
export async function gitFileDiff(folder: string, path: string): Promise<GitFileDiff> {
  const empty: GitFileDiff = { diff: '', binary: false, truncated: false }
  try {
    const top = await git(folder, ['rev-parse', '--show-toplevel'])
    const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : folder
    const tracked = await git(root, ['ls-files', '--error-unmatch', '--', path])
    let res: GitResult
    if (tracked.code === 0) {
      res = await git(root, ['diff', 'HEAD', '--', path])
      // Unborn HEAD (repo without commits, exit 128): fall back to index vs
      // worktree. Other non-zero codes (e.g. maxBuffer cut) keep their output.
      if (res.code === 128) res = await git(root, ['diff', '--', path])
    } else {
      // git special-cases /dev/null on every platform, Windows included.
      // --no-index exits 1 when the files differ — that's the expected case.
      res = await git(root, ['diff', '--no-index', '--', '/dev/null', path])
    }
    const text = res.stdout
    const binary = /^Binary files .* differ$/m.test(text)
    if (text.length <= MAX_DIFF_CHARS) return { diff: text, binary, truncated: false }
    // Cut on a line boundary so the viewer never colors a half line.
    const cut = text.lastIndexOf('\n', MAX_DIFF_CHARS)
    return { diff: text.slice(0, cut > 0 ? cut : MAX_DIFF_CHARS), binary, truncated: true }
  } catch {
    return empty
  }
}

/**
 * Most recent commits on the current branch, newest first. Returns [] for a
 * non-repo or an empty repo (no commits yet). Fields are split on a unit
 * separator so subjects/refs can contain any other character safely.
 */
export async function gitLog(folder: string, limit = 30): Promise<GitCommit[]> {
  const SEP = '\x1f'
  const fmt = ['%H', '%h', '%s', '%an', '%ar', '%D'].join(SEP)
  const res = await git(folder, ['log', '-n', String(limit), `--pretty=format:${fmt}`])
  if (res.code !== 0) return []
  const commits: GitCommit[] = []
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue
    const [hash, shortHash, subject, author, relDate, refs] = line.split(SEP)
    commits.push({ hash, shortHash, subject, author, relDate, refs: refs ?? '' })
  }
  return commits
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

/**
 * Start a merge of `branch` into `baseBranch` and — unlike mergeBranch — LEAVE
 * the conflict markers in the base working tree, so a human or Claude can
 * resolve them and commit. Still refuses on a dirty base tree. Returns
 * conflict:true when the merge stopped on conflicts (the expected case).
 */
export async function startMergeLeaveConflicts(
  baseFolder: string,
  branch: string,
  baseBranch: string
): Promise<MergeResult> {
  const dirty = await dirtyCount(baseFolder)
  if (dirty && dirty > 0) {
    return {
      ok: false,
      conflict: false,
      output:
        `The base repo (${baseFolder}) has ${dirty} uncommitted file(s). ` +
        `Commit or stash them there before merging.`
    }
  }
  const head = await git(baseFolder, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.code === 0 && head.stdout.trim() !== baseBranch) {
    const co = await git(baseFolder, ['checkout', baseBranch])
    if (co.code !== 0) return { ok: false, conflict: false, output: co.output }
  }
  const res = await git(baseFolder, ['merge', '--no-ff', branch])
  if (res.code === 0) return { ok: true, conflict: false, output: res.output }
  const merging = await git(baseFolder, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  return { ok: false, conflict: merging.code === 0, output: res.output }
}

/**
 * Push `branch` to its upstream remote, best-effort. Only pushes when the
 * branch already has an upstream — Maestro never publishes branches the user
 * hasn't pushed themselves. Returns null when there is no upstream to push to.
 */
export async function pushBranch(
  folder: string,
  branch: string
): Promise<{ ok: boolean; output: string } | null> {
  const up = await git(folder, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${branch}@{upstream}`
  ])
  if (up.code !== 0) return null
  const remote = up.stdout.trim().split('/')[0]
  if (!remote) return null
  const res = await git(folder, ['push', remote, branch])
  return { ok: res.code === 0, output: res.output }
}

/**
 * Run a `gh` (GitHub CLI) command in `cwd`. Never rejects on a non-zero exit —
 * callers inspect `code`/`output`. Rejects only if `gh` itself isn't installed,
 * with a message the UI can surface verbatim.
 */
function gh(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              'The GitHub CLI (`gh`) was not found on PATH. Install it from https://cli.github.com ' +
                'and run `gh auth login` to open pull requests from Maestro.'
            )
          )
          return
        }
        const code = err ? ((err as { code?: number }).code ?? 1) : 0
        resolve({ code, stdout, stderr, output: `${stdout}${stderr}`.trim() })
      }
    )
  })
}

/** The last non-empty line of text — `gh pr create`/`view` print the PR URL there. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

/** Pull a github.com PR URL out of arbitrary gh output, or '' when absent. */
function extractPrUrl(text: string): string {
  const m = text.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)
  return m ? m[0] : ''
}

/**
 * Open a pull request for `branch` against `baseBranch` using the `gh` CLI.
 * Pushes the branch to its remote first (so the head exists on the host), then
 * `gh pr create`. If a PR for the branch already exists, returns its URL with
 * `alreadyExists:true` instead of failing. Rejects only when `gh` isn't
 * installed; every other failure comes back as `ok:false` with git/gh output.
 */
export async function createPullRequest(
  folder: string,
  branch: string,
  baseBranch: string,
  title: string,
  body: string
): Promise<PullRequestResult> {
  const remote = await defaultRemote(folder)
  if (!remote) {
    return {
      ok: false,
      output:
        'This repository has no git remote, so there is nowhere to open a pull request. ' +
        'Add a GitHub remote (e.g. `git remote add origin <url>`) first.'
    }
  }

  // Publish the head branch (push -u). A PR needs the branch on the remote; this
  // also works for a branch that has never been pushed.
  const push = await git(folder, ['push', '-u', remote, branch])
  if (push.code !== 0) {
    return { ok: false, output: `Pushing "${branch}" to ${remote} failed:\n${push.output}` }
  }

  const res = await gh(folder, [
    'pr',
    'create',
    '--base',
    baseBranch,
    '--head',
    branch,
    '--title',
    title,
    '--body',
    body
  ])
  if (res.code === 0) {
    return { ok: true, url: extractPrUrl(res.stdout) || lastLine(res.stdout), output: res.output }
  }

  // gh fails when a PR for this head already exists — fetch and report its URL.
  if (/already exists/i.test(res.output)) {
    const view = await gh(folder, ['pr', 'view', branch, '--json', 'url', '--jq', '.url'])
    const url = view.code === 0 ? extractPrUrl(view.stdout) || lastLine(view.stdout) : ''
    return {
      ok: true,
      alreadyExists: true,
      url: url || undefined,
      output: url ? `A pull request already exists for "${branch}":\n${url}` : res.output
    }
  }
  return { ok: false, output: `gh pr create failed:\n${res.output}` }
}

/** The remote to publish to: 'origin' if present, else the first remote, else null. */
export async function defaultRemote(folder: string): Promise<string | null> {
  const res = await git(folder, ['remote'])
  if (res.code !== 0) return null
  const remotes = res.stdout.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)
  if (remotes.length === 0) return null
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/**
 * Push `branch` to the default remote and set its upstream (`push -u`). Unlike
 * pushBranch this works for a freshly created branch that has no upstream yet,
 * so the branch becomes visible on the host (e.g. GitHub). Returns null when the
 * repo has no remote; otherwise {ok, output}. Callers should treat it as
 * best-effort (offline, auth, protected branch can all make ok:false).
 */
export async function publishBranch(
  folder: string,
  branch: string
): Promise<{ ok: boolean; output: string } | null> {
  const remote = await defaultRemote(folder)
  if (!remote) return null
  const res = await git(folder, ['push', '-u', remote, branch])
  return { ok: res.code === 0, output: res.output }
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

/**
 * Create a local branch at `from` (default HEAD) WITHOUT checking it out, so
 * the user's working tree is untouched. No-op when the branch already exists.
 * Throws with git's message on failure (e.g. invalid name, unborn HEAD).
 */
export async function ensureBranch(repoRoot: string, branch: string, from = 'HEAD'): Promise<void> {
  if (await branchExists(repoRoot, branch)) return
  const res = await git(repoRoot, ['branch', branch, from])
  if (res.code !== 0) throw new Error(res.output || `git branch ${branch} failed`)
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

// ---------- repo checkpoints (working-tree safety net) ----------

/** Ref namespace under which checkpoint snapshot commits are stored. */
const CHECKPOINT_REF_PREFIX = 'refs/maestro-checkpoints/'

/** Monotonic suffix so two checkpoints taken in the same millisecond get distinct ids. */
let checkpointSeq = 0

/** A checkpoint id is one we minted: `<unixMs>-<seq>`. Reject anything else. */
function isValidCheckpointId(id: string): boolean {
  return /^[0-9]+-[0-9]+$/.test(id)
}

/** Resolve a folder to its repo root (falls back to the folder itself). */
async function repoRootOf(folder: string): Promise<string> {
  const top = await git(folder, ['rev-parse', '--show-toplevel'])
  return top.code === 0 && top.stdout.trim() ? top.stdout.trim() : folder
}

/**
 * Snapshot the ENTIRE working tree (tracked changes + untracked files, minus
 * .gitignored ones) into a commit stored under `refs/maestro-checkpoints/<id>`,
 * WITHOUT moving HEAD or disturbing the user's index/working tree. Done with a
 * throwaway index via GIT_INDEX_FILE so staged state is untouched, and a fixed
 * "Maestro" identity so it works even when the user has no git identity set.
 * Throws git's message on failure.
 */
export async function createCheckpoint(folder: string, label: string): Promise<RepoCheckpoint> {
  const root = await repoRootOf(folder)
  const createdAt = Date.now()
  const id = `${createdAt}-${checkpointSeq++}`
  const cleanLabel = label.trim() || 'Checkpoint'
  const indexFile = join(tmpdir(), `maestro-ckpt-${id}.index`)
  try {
    // Build the snapshot tree in a throwaway index: `add -A` from an empty index
    // stages every non-ignored file as it currently sits on disk (so modified,
    // new, and deleted-tracked states are all captured faithfully).
    const indexEnv = { GIT_INDEX_FILE: indexFile }
    const add = await git(root, ['add', '-A'], indexEnv)
    if (add.code !== 0) throw new Error(add.output || 'git add failed')
    const writeTree = await git(root, ['write-tree'], indexEnv)
    if (writeTree.code !== 0) throw new Error(writeTree.output || 'git write-tree failed')
    const tree = writeTree.stdout.trim()

    // Anchor the snapshot to HEAD when there is one, so `git log <ref>` reads
    // naturally; on an unborn HEAD the snapshot commit simply has no parent.
    const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const parentArgs = head.code === 0 && head.stdout.trim() ? ['-p', head.stdout.trim()] : []
    const commit = await git(
      root,
      ['commit-tree', tree, ...parentArgs, '-m', cleanLabel],
      {
        GIT_AUTHOR_NAME: 'Maestro',
        GIT_AUTHOR_EMAIL: 'maestro@localhost',
        GIT_COMMITTER_NAME: 'Maestro',
        GIT_COMMITTER_EMAIL: 'maestro@localhost'
      }
    )
    if (commit.code !== 0) throw new Error(commit.output || 'git commit-tree failed')
    const hash = commit.stdout.trim()

    const ref = CHECKPOINT_REF_PREFIX + id
    const update = await git(root, ['update-ref', ref, hash])
    if (update.code !== 0) throw new Error(update.output || 'git update-ref failed')

    return { id, ref, hash, label: cleanLabel, createdAt }
  } finally {
    try {
      rmSync(indexFile, { force: true })
    } catch {
      // best-effort temp cleanup
    }
  }
}

/** Recent checkpoints for a repo, newest first. [] for a non-repo folder. */
export async function listCheckpoints(folder: string): Promise<RepoCheckpoint[]> {
  const root = await repoRootOf(folder)
  const SEP = '\x1f'
  const fmt = ['%(refname)', '%(objectname)', '%(creatordate:unix)', '%(contents:subject)'].join(SEP)
  const res = await git(root, [
    'for-each-ref',
    '--sort=-creatordate',
    `--format=${fmt}`,
    CHECKPOINT_REF_PREFIX
  ])
  if (res.code !== 0) return []
  const out: RepoCheckpoint[] = []
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue
    const [ref, hash, unix, subject] = line.split(SEP)
    if (!ref || !hash) continue
    out.push({
      id: ref.slice(CHECKPOINT_REF_PREFIX.length),
      ref,
      hash,
      label: subject ?? 'Checkpoint',
      createdAt: (Number.parseInt(unix, 10) || 0) * 1000
    })
  }
  return out
}

/**
 * Restore the working tree back to a checkpoint. GUARDED: a fresh safety
 * checkpoint of the current state is taken first (so a restore is itself
 * reversible — nothing is lost), then `git read-tree -u --reset` resets the
 * index and working tree to the snapshot, discarding conflicting local edits to
 * tracked files. HEAD is never moved. Returns ok:false (without restoring) if
 * the id is unknown or the safety snapshot can't be taken.
 */
export async function restoreCheckpoint(
  folder: string,
  id: string
): Promise<RestoreCheckpointResult> {
  if (!isValidCheckpointId(id)) {
    return { ok: false, output: `Invalid checkpoint id: ${id}`, safety: null }
  }
  const root = await repoRootOf(folder)
  const ref = CHECKPOINT_REF_PREFIX + id
  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (exists.code !== 0 || !exists.stdout.trim()) {
    return { ok: false, output: 'That checkpoint no longer exists.', safety: null }
  }

  // Save the current working tree first, so this restore can be undone.
  let safety: RepoCheckpoint
  try {
    safety = await createCheckpoint(root, 'Auto-saved before restore')
  } catch (err) {
    return {
      ok: false,
      output: `Couldn't safeguard the current state before restoring:\n${(err as Error).message}`,
      safety: null
    }
  }

  const res = await git(root, ['read-tree', '-u', '--reset', exists.stdout.trim()])
  if (res.code !== 0) {
    return { ok: false, output: res.output || 'git read-tree failed', safety }
  }
  return { ok: true, output: res.output, safety }
}

/** Delete one checkpoint ref. Best-effort; throws git's message on failure. */
export async function deleteCheckpoint(folder: string, id: string): Promise<void> {
  if (!isValidCheckpointId(id)) throw new Error(`Invalid checkpoint id: ${id}`)
  const root = await repoRootOf(folder)
  const res = await git(root, ['update-ref', '-d', CHECKPOINT_REF_PREFIX + id])
  if (res.code !== 0) throw new Error(res.output || 'git update-ref -d failed')
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
