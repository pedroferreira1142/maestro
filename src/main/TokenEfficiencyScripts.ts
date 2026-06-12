import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * The hook scripts the Token Efficiency toolkit registers with Claude Code.
 * They are written verbatim to `userData/token-efficiency/scripts/` on app
 * start (overwriting, so upgrades ship fixes) and referenced by absolute path
 * from each repo's `.claude/settings.local.json` hooks. All scripts are plain
 * Node ESM with zero dependencies and never throw to stderr on bad input —
 * a broken hook must never block claude's tools (exit 0 = no-op).
 *
 * Embedded with String.raw so regex escapes survive; the script bodies avoid
 * backticks and `${` (string concatenation instead) for the same reason.
 */

/**
 * stdin→stdout compressor noisy Bash commands are piped through (when rtk
 * isn't handling them): strips ANSI, keeps only the final state of \r-redrawn
 * progress lines, collapses consecutive duplicates, and reduces very long
 * output to head + errors/warnings + tail. Logs original/compressed sizes to
 * the stats file for the savings indicator.
 */
const OUTPUT_FILTER = String.raw`#!/usr/bin/env node
// Maestro Token Efficiency — built-in output filter (auto-generated, do not edit).
import { appendFileSync } from 'node:fs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const statsFile = arg('--stats')

const HEAD_LINES = 120
const TAIL_LINES = 80
const KEEP_MAX = 60
const KEEP_ERR = /\b(error|fail|failed|failure|exception|fatal|panic|traceback)\b/i
const KEEP_WARN = /\b(warn|warning)\b/i

function compress(raw) {
  // Strip ANSI CSI/OSC sequences; keep only the final state of \r-redrawn lines.
  const text = raw
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  const lines = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.includes('\r') ? rawLine.slice(rawLine.lastIndexOf('\r') + 1) : rawLine
    lines.push(line.replace(/\s+$/, ''))
  }
  // Collapse runs of identical lines and squeeze blank-line runs.
  const collapsed = []
  let i = 0
  while (i < lines.length) {
    let j = i + 1
    while (j < lines.length && lines[j] === lines[i]) j++
    const n = j - i
    if (lines[i].trim() === '') {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] !== '') collapsed.push('')
    } else if (n > 2) {
      collapsed.push(lines[i] + '   [repeated ' + n + 'x]')
    } else {
      for (let k = 0; k < n; k++) collapsed.push(lines[i])
    }
    i = j
  }
  if (collapsed.length <= HEAD_LINES + TAIL_LINES + 20) return collapsed.join('\n')
  const head = collapsed.slice(0, HEAD_LINES)
  const tail = collapsed.slice(collapsed.length - TAIL_LINES)
  const middle = collapsed.slice(HEAD_LINES, collapsed.length - TAIL_LINES)
  // Errors outrank warnings for the keep budget — a wall of deprecation
  // warnings must never crowd out the one failure line.
  const errs = []
  const warns = []
  for (const line of middle) {
    if (KEEP_ERR.test(line)) {
      if (errs.length < KEEP_MAX) errs.push(line)
    } else if (KEEP_WARN.test(line)) {
      if (warns.length < KEEP_MAX) warns.push(line)
    }
  }
  const kept = errs.concat(warns.slice(0, Math.max(0, KEEP_MAX - errs.length)))
  const omitted = middle.length - kept.length
  return head
    .concat(
      '',
      '... ' + omitted + ' lines omitted by Maestro token filter' +
        (kept.length ? ' (errors/warnings kept below)' : '') + ' ...',
      ''
    )
    .concat(kept.length ? kept.concat('') : [])
    .concat(tail)
    .join('\n')
}

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8')
  let out
  try {
    out = compress(raw)
  } catch {
    out = raw // never lose output to a filter bug
  }
  process.stdout.write(out)
  if (statsFile) {
    try {
      appendFileSync(
        statsFile,
        JSON.stringify({ at: Date.now(), cwd: process.cwd(), kind: 'filter', orig: raw.length, out: out.length }) + '\n'
      )
    } catch {}
  }
})
`

/**
 * PreToolUse(Bash) hook: rewrites known-noisy, side-effect-light commands so
 * their output is compressed before it reaches the model — `rtk` for git when
 * the rtk CLI is installed, otherwise a pipe through the built-in filter
 * (pipefail preserves the real exit code). Anything already piped/redirected,
 * using heredocs, or already rtk/filtered is left untouched, and unmatched
 * commands exit 0 with no output (Claude Code proceeds normally).
 */
const BASH_COMPRESS = String.raw`#!/usr/bin/env node
// Maestro Token Efficiency — Bash command compression hook (auto-generated, do not edit).
import { appendFileSync, readFileSync } from 'node:fs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const statsFile = arg('--stats')
const filter = arg('--filter')
const rtk = arg('--rtk') === '1'

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
if (!input || input.tool_name !== 'Bash' || !input.tool_input) process.exit(0)
const command = String(input.tool_input.command || '').trim()
if (!command) process.exit(0)

// Already shaped/structured output — don't double-process.
if (/[|<>]/.test(command)) process.exit(0)
if (/\brtk\b/.test(command) || command.includes('output-filter.mjs')) process.exit(0)

const NOISY = [
  /^git (status|log|diff|show|fetch|pull|blame)\b/,
  /^(npm|pnpm|yarn|bun) (install|ci|i)\b/,
  /^(npm|pnpm|yarn|bun) (run )?(build|test|lint|typecheck|tsc)\b/,
  /^npx (tsc|jest|vitest|eslint|playwright|mocha)\b/,
  /^(cargo|go) (build|test|check|vet)\b/,
  /^(mvn|gradle|gradlew|\.\/gradlew)\b/,
  /^(pytest|tox|tsc|make)\b/,
  /^dotnet (build|test|restore)\b/,
  /^pip3? install\b/
]
if (!NOISY.some((re) => re.test(command))) process.exit(0)

let updated = null
let kind = null
if (rtk && /^git /.test(command)) {
  updated = 'rtk ' + command
  kind = 'rtk'
} else if (filter) {
  updated =
    'set -o pipefail; { ' + command + '; } 2>&1 | node "' + filter + '"' +
    (statsFile ? ' --stats "' + statsFile + '"' : '')
  kind = 'wrap'
}
if (!updated) process.exit(0)

if (statsFile && kind === 'rtk') {
  try {
    appendFileSync(
      statsFile,
      JSON.stringify({ at: Date.now(), cwd: process.cwd(), kind: 'rtk' }) + '\n'
    )
  } catch {}
}
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Maestro token efficiency: noisy command output is compressed (' + kind + ')',
      updatedInput: Object.assign({}, input.tool_input, { command: updated })
    }
  })
)
`

/**
 * PreToolUse(Read) hook: denies whole-file reads of well-known token sinks
 * (lockfiles, node_modules/dist/build paths, minified bundles, sourcemaps,
 * logs) above a size threshold, with a reason steering claude to Grep or an
 * offset/limit read. Deliberate targeted reads (offset/limit set) pass.
 */
const READ_GUARD = String.raw`#!/usr/bin/env node
// Maestro Token Efficiency — large-read guard hook (auto-generated, do not edit).
import { appendFileSync, readFileSync, statSync } from 'node:fs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const statsFile = arg('--stats')
const maxKB = Math.max(8, parseInt(arg('--max-kb') || '256', 10) || 256)

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
if (!input || input.tool_name !== 'Read' || !input.tool_input) process.exit(0)
const file = String(input.tool_input.file_path || '')
if (!file) process.exit(0)
// A targeted slice is deliberate — allow it.
if (input.tool_input.offset || input.tool_input.limit) process.exit(0)

const base = (file.split(/[\\/]/).pop() || '').toLowerCase()
const norm = file.replace(/\\/g, '/').toLowerCase()
const LOCKFILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lock',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'composer.lock', 'gemfile.lock',
  'go.sum', 'flake.lock'
]
const sink =
  LOCKFILES.indexOf(base) >= 0 ||
  /\/(node_modules|dist|build|out|target|\.venv|__pycache__|coverage)\//.test(norm) ||
  /\.(log|jsonl|map)$/.test(base) ||
  base.includes('.min.')
if (!sink) process.exit(0)

let size = 0
try {
  size = statSync(file).size
} catch {
  process.exit(0)
}
if (size <= maxKB * 1024) process.exit(0)

if (statsFile) {
  try {
    appendFileSync(
      statsFile,
      JSON.stringify({ at: Date.now(), cwd: process.cwd(), kind: 'blocked-read', bytes: size }) + '\n'
    )
  } catch {}
}
const sizeKB = Math.round(size / 1024)
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Maestro token guard: "' + file + '" is ' + sizeKB + ' KB of low-signal content ' +
        '(lockfile/log/build artifact). Reading it whole would waste a large amount of context. ' +
        'Use Grep to find the specific entry you need, or Read with offset/limit for a targeted slice.'
    }
  })
)
`

/**
 * SessionStart hook: prints the repo's generated symbol map (if present) so
 * it lands in claude's context at startup/resume/compact, with a nudge to
 * navigate by symbols instead of exploratory full-file reads.
 */
const SESSION_CONTEXT = String.raw`#!/usr/bin/env node
// Maestro Token Efficiency — repo-map session context hook (auto-generated, do not edit).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

try {
  const map = join(process.cwd(), '.claude', 'maestro-repo-map.md')
  if (existsSync(map)) {
    const text = readFileSync(map, 'utf8').trim()
    if (text) {
      process.stdout.write(
        'Repo symbol map (generated by Maestro). Use it to jump straight to the right file/symbol ' +
          'with Grep or a targeted Read instead of reading whole files:\n\n' + text + '\n'
      )
    }
  }
} catch {}
`

export const SCRIPT_FILES = {
  outputFilter: 'output-filter.mjs',
  bashCompress: 'bash-compress.mjs',
  readGuard: 'read-guard.mjs',
  sessionContext: 'session-context.mjs'
} as const

/**
 * Write (overwrite) all hook scripts into `scriptsDir`. Returns the absolute
 * path of each script keyed as in SCRIPT_FILES. Throws on I/O failure — the
 * caller treats that as "hook-based tools unavailable".
 */
export function ensureScripts(scriptsDir: string): Record<keyof typeof SCRIPT_FILES, string> {
  mkdirSync(scriptsDir, { recursive: true })
  const sources: Record<keyof typeof SCRIPT_FILES, string> = {
    outputFilter: OUTPUT_FILTER,
    bashCompress: BASH_COMPRESS,
    readGuard: READ_GUARD,
    sessionContext: SESSION_CONTEXT
  }
  const out = {} as Record<keyof typeof SCRIPT_FILES, string>
  for (const key of Object.keys(SCRIPT_FILES) as (keyof typeof SCRIPT_FILES)[]) {
    const path = join(scriptsDir, SCRIPT_FILES[key])
    writeFileSync(path, sources[key], 'utf8')
    out[key] = path
  }
  return out
}
