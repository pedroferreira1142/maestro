import * as pty from 'node-pty'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { SessionStatus, StartMode, TerminalConfig, TerminalKind } from '../shared/types'
import { StatusDetector } from './StatusDetector'

const RING_BUFFER_BYTES = 2 * 1024 * 1024
const IS_WIN = process.platform === 'win32'

export interface PtyCallbacks {
  onData(id: string, data: string): void
  onStatus(id: string, status: SessionStatus): void
  onExit(id: string, exitCode: number): void
  /**
   * Fires for every output chunk, attached or not (onData only fires once the
   * renderer attached). Used to keep the persisted scrollback dirty-marked.
   */
  onOutput?(id: string): void
}

interface ResolvedCommand {
  file: string
  argsPrefix: string[]
}

/** All PATH matches for a name (`where.exe` / `which -a`), best first. */
function which(name: string): string[] {
  const out = IS_WIN
    ? spawnSync('where.exe', [name], { encoding: 'utf8' })
    : spawnSync('which', ['-a', name], { encoding: 'utf8' })
  if (out.status !== 0 || !out.stdout) return []
  return out.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

const cache = new Map<TerminalKind, ResolvedCommand | null>()

/**
 * Locate the claude CLI. On Windows, npm installs put a `claude.cmd` shim on
 * PATH which ConPTY can't spawn directly, so .cmd/.bat resolve through
 * cmd.exe /c. On macOS/Linux any PATH match is directly spawnable.
 */
export function resolveClaude(): ResolvedCommand | null {
  const candidates = which('claude')
  const home = IS_WIN ? process.env.USERPROFILE : process.env.HOME
  if (home) {
    // claude's native installer target (`claude install`) lives here.
    const localBin = join(home, '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude')
    if (existsSync(localBin)) candidates.push(localBin)
  }
  if (!IS_WIN) {
    return candidates[0] ? { file: candidates[0], argsPrefix: [] } : null
  }
  const exe = candidates.find((c) => c.toLowerCase().endsWith('.exe'))
  const cmd = candidates.find((c) => /\.(cmd|bat)$/i.test(c))
  if (exe) return { file: exe, argsPrefix: [] }
  if (cmd) return { file: process.env.ComSpec ?? 'cmd.exe', argsPrefix: ['/c', cmd] }
  return null
}

function resolvePowershell(): ResolvedCommand | null {
  const pwsh = which(IS_WIN ? 'pwsh.exe' : 'pwsh')[0] ?? which('pwsh')[0]
  if (pwsh) return { file: pwsh, argsPrefix: ['-NoLogo'] }
  return IS_WIN ? { file: 'powershell.exe', argsPrefix: ['-NoLogo'] } : null
}

function resolveCmd(): ResolvedCommand | null {
  return IS_WIN ? { file: process.env.ComSpec ?? 'cmd.exe', argsPrefix: [] } : null
}

function resolveBash(): ResolvedCommand | null {
  if (!IS_WIN) {
    const p = which('bash')[0] ?? (existsSync('/bin/bash') ? '/bin/bash' : null)
    return p ? { file: p, argsPrefix: ['-i', '-l'] } : null
  }
  const onPath = which('bash.exe')[0] ?? which('bash')[0]
  if (onPath) return { file: onPath, argsPrefix: ['-i', '-l'] }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
  for (const root of roots) {
    for (const sub of ['Git\\bin\\bash.exe', 'Git\\usr\\bin\\bash.exe']) {
      const p = `${root}\\${sub}`
      if (existsSync(p)) return { file: p, argsPrefix: ['-i', '-l'] }
    }
  }
  return null
}

function resolveZsh(): ResolvedCommand | null {
  if (IS_WIN) return null
  const p = which('zsh')[0] ?? (existsSync('/bin/zsh') ? '/bin/zsh' : null)
  return p ? { file: p, argsPrefix: ['-i', '-l'] } : null
}

/** Resolve (and cache) the executable for a terminal kind. */
export function resolveKind(kind: TerminalKind): ResolvedCommand | null {
  if (cache.has(kind)) return cache.get(kind)!
  let resolved: ResolvedCommand | null
  switch (kind) {
    case 'claude':
      resolved = resolveClaude()
      break
    case 'powershell':
      resolved = resolvePowershell()
      break
    case 'cmd':
      resolved = resolveCmd()
      break
    case 'bash':
      resolved = resolveBash()
      break
    case 'zsh':
      resolved = resolveZsh()
      break
  }
  cache.set(kind, resolved)
  return resolved
}

const KIND_MISSING: Partial<Record<TerminalKind, string>> = {
  claude:
    'claude CLI not found on PATH.\r\nInstall it with: npm install -g @anthropic-ai/claude-code',
  bash: IS_WIN
    ? 'bash not found.\r\nInstall Git for Windows to get Git Bash.'
    : 'bash not found on PATH.',
  zsh: 'zsh not found on PATH.',
  powershell: 'PowerShell (pwsh) not found on PATH.',
  cmd: 'cmd.exe is only available on Windows.'
}

/**
 * One running program (claude CLI or a shell) in a pseudo-terminal. The PTY
 * byte stream is never modified: it is ring-buffered (for renderer re-attach),
 * copied to the status detector, and forwarded verbatim once attached.
 */
export class PtySession {
  private proc: pty.IPty | null = null
  private chunks: string[] = []
  private bufferedBytes = 0
  private attached = false
  readonly detector: StatusDetector
  exitCode: number | null = null
  /** Total chars of live process output this run (token-estimate feed). */
  outputChars = 0

  constructor(
    readonly config: TerminalConfig,
    private folder: string,
    private cb: PtyCallbacks,
    /** Per-session env overrides, overlaid on process.env at spawn time. */
    private sessionEnv: Record<string, string> = {},
    /** Inherited variables removed from the spawn env (after overlays). */
    private dropEnv: string[] = []
  ) {
    this.detector = new StatusDetector(
      (s) => cb.onStatus(config.id, s),
      config.kind !== 'claude'
    )
  }

  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  get alive(): boolean {
    return this.proc !== null && this.exitCode === null
  }

  spawn(mode: StartMode): void {
    if (!existsSync(this.folder)) {
      this.systemMessage(`Folder not found: ${this.folder}`)
      this.detector.setExternal('error')
      return
    }
    const cmd = resolveKind(this.config.kind)
    if (!cmd) {
      this.systemMessage(KIND_MISSING[this.config.kind] ?? `${this.config.kind} not found`)
      this.detector.setExternal('error')
      return
    }

    const args = [...cmd.argsPrefix]
    if (this.config.kind === 'claude') {
      args.push(...(this.config.claudeArgs ?? []))
      if (mode === 'continue') args.push('--continue')
    }

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    // Overlay the session's own variables on top of the inherited environment:
    // a per-session entry overrides an inherited one of the same name, while
    // everything the session doesn't define (PATH, …) is preserved. Empty or
    // whitespace-only keys are ignored so they never reach the spawned process.
    for (const [k, v] of Object.entries(this.sessionEnv)) {
      if (k.trim()) env[k] = v
    }
    // Variables explicitly dropped (e.g. an inherited DISABLE_PROMPT_CACHING
    // the token-efficiency toolkit strips) — unless the session set them itself.
    for (const k of this.dropEnv) {
      if (!(k in this.sessionEnv)) delete env[k]
    }

    try {
      this.proc = pty.spawn(cmd.file, args, {
        cols: 120,
        rows: 30,
        cwd: this.folder,
        env
      })
    } catch (err) {
      this.systemMessage(`Failed to start ${this.config.kind}: ${String(err)}`)
      this.detector.setExternal('error')
      return
    }

    this.exitCode = null
    this.detector.start()
    this.proc.onData((data) => this.handleData(data))
    this.proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode
      this.detector.stop()
      this.detector.setExternal('exited')
      this.cb.onExit(this.config.id, exitCode)
    })
  }

  write(data: string): void {
    if (!this.alive) return
    this.detector.onUserInput()
    this.proc!.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.alive || cols < 2 || rows < 2) return
    try {
      this.proc!.resize(cols, rows)
    } catch {
      // PTY may have just exited; ignore
    }
  }

  /**
   * Pre-loads output saved from a previous run into the ring buffer, so
   * attach() replays it ahead of the live process output. Call before
   * spawn(); seeded text bypasses the status detector and live forwarding.
   */
  seedHistory(text: string): void {
    if (!text) return
    this.chunks.push(text)
    this.bufferedBytes += text.length
  }

  /** The most recent `maxBytes` of buffered output (for scrollback persistence). */
  tail(maxBytes: number): string {
    const parts: string[] = []
    let total = 0
    for (let i = this.chunks.length - 1; i >= 0 && total < maxBytes; i--) {
      parts.push(this.chunks[i])
      total += this.chunks[i].length
    }
    const text = parts.reverse().join('')
    return text.length > maxBytes ? text.slice(-maxBytes) : text
  }

  /**
   * Marks the renderer as attached and returns the ring buffer for replay.
   * Live forwarding starts only after this snapshot, so the renderer sees a
   * gapless, duplicate-free stream as long as it registers its data listener
   * before invoking attach.
   */
  attach(): string {
    const replay = this.chunks.join('')
    this.attached = true
    return replay
  }

  kill(): void {
    this.detector.stop()
    if (this.proc && this.exitCode === null) {
      try {
        this.proc.kill()
      } catch {
        // already gone
      }
    }
    this.proc = null
  }

  private handleData(data: string): void {
    this.chunks.push(data)
    this.bufferedBytes += data.length
    this.outputChars += data.length
    while (this.bufferedBytes > RING_BUFFER_BYTES && this.chunks.length > 1) {
      this.bufferedBytes -= this.chunks[0].length
      this.chunks.shift()
    }
    this.detector.feed(data)
    this.cb.onOutput?.(this.config.id)
    if (this.attached) this.cb.onData(this.config.id, data)
  }

  private systemMessage(msg: string): void {
    const text = `\r\n\x1b[1;31m${msg.replace(/\n/g, '\r\n')}\x1b[0m\r\n`
    this.handleData(text)
  }
}
