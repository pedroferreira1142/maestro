import { ChildProcess, spawn } from 'child_process'
import { resolveClaude } from './PtySession'

/** Options for one headless `claude -p` run. */
export interface HeadlessClaudeOpts {
  /** Working directory the agent runs in (its Glob/Grep/Bash are scoped here). */
  cwd: string
  /** The prompt, written to claude's stdin. */
  prompt: string
  /** Tools the agent may use, e.g. ['Read', 'Glob', 'Bash(git log:*)']. */
  allowedTools: string[]
  /** Hard cap; the child is killed and the call rejects if it overruns. */
  timeoutMs: number
  /** Receives the spawned child so the caller can track/kill it for cancellation. */
  onSpawn?(child: ChildProcess): void
}

/**
 * Run one headless, non-interactive `claude -p --output-format json` and
 * resolve with the agent's result text. This is the shared core behind every
 * "ask claude to think about something off-screen" feature (auto-expand,
 * sentinels, the conductor): writes are never enabled here — callers pass only
 * read-only `allowedTools`. Rejects on a missing CLI, spawn failure, timeout,
 * an error envelope, or empty output.
 */
export function runHeadlessClaude(opts: HeadlessClaudeOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const claude = resolveClaude()
    if (!claude) {
      reject(new Error('claude CLI not found on PATH.'))
      return
    }
    const args = [
      ...claude.argsPrefix,
      '-p',
      '--output-format',
      'json',
      '--allowedTools',
      opts.allowedTools.join(',')
    ]
    let child: ChildProcess
    try {
      child = spawn(claude.file, args, {
        cwd: opts.cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(new Error(`Failed to start claude: ${String(err)}`))
      return
    }
    opts.onSpawn?.(child)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdin?.write(opts.prompt)
    child.stdin?.end()

    const timeout = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // already gone
      }
    }, opts.timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Failed to run claude: ${String(err)}`))
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut) {
        reject(new Error(`The agent timed out after ${Math.round(opts.timeoutMs / 1000)}s.`))
        return
      }
      if (code !== 0 && !stdout.trim()) {
        reject(new Error((stderr.trim() || `claude exited with code ${code}`).slice(0, 500)))
        return
      }
      const text = unwrapResult(stdout)
      if (text instanceof Error) reject(text)
      else resolve(text)
    })
  })
}

/**
 * Unwrap `claude -p --output-format json` stdout (an envelope with a `result`
 * string). Returns the agent's text, or an Error for an error envelope / empty
 * output.
 */
export function unwrapResult(stdout: string): string | Error {
  let text = stdout.trim()
  try {
    const envelope = JSON.parse(text) as { result?: string; is_error?: boolean }
    if (typeof envelope.result === 'string') {
      if (envelope.is_error) return new Error(envelope.result.slice(0, 500))
      text = envelope.result.trim()
    }
  } catch {
    // Not the JSON envelope (older CLI?) — treat stdout as the agent's text.
  }
  if (!text) return new Error('The agent produced no output.')
  return text
}

/** Extract the outermost JSON object from agent text, tolerating fences/prose. */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}
