import { SessionStatus } from '../shared/types'

const BEL = '\x07'
const CSI_RE = new RegExp(
  '[\\x1b\\x9b][\\[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
  'g'
)
const OSC_RE = new RegExp('\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', 'g')

function stripAnsi(s: string): string {
  return s.replace(OSC_RE, '').replace(CSI_RE, '')
}

/** Output that looks like Claude Code asking the user something. */
const ATTENTION_RE =
  /(Do you want|Would you like|do you wish|\(y\/n\)|❯\s*1\.|1\.\s*Yes|Esc to cancel|press Enter to|waiting for (your )?input|needs your)/i

/**
 * Best-effort classification of a session from its PTY output stream.
 *
 * Signals, by reliability:
 *  1. BEL (\x07) → needs-attention, sticky until the user types.
 *     (Claude Code emits this on prompts when preferredNotifChannel=terminal_bell.)
 *  2. Output flowing within the last 2.5 s → working.
 *  3. Output stopped + tail of screen matches prompt heuristics → needs-attention.
 *  4. Otherwise → idle.
 */
export class StatusDetector {
  private status: SessionStatus = 'starting'
  private statusSince = Date.now()
  private lastOutputAt = 0
  private stickyAttention = false
  private tail = ''
  private timer: NodeJS.Timeout | null = null

  /**
   * @param emit  status change callback
   * @param plain when true (non-claude shells), the Claude-specific
   *   "needs-attention" heuristics (BEL + prompt phrases) are disabled — a
   *   shell prompt should never ping the user. Only working/idle/exited/error.
   */
  constructor(
    private emit: (status: SessionStatus) => void,
    private plain = false
  ) {}

  get current(): SessionStatus {
    return this.status
  }

  get lastOutput(): number {
    return this.lastOutputAt
  }

  /** ms epoch when the current status was continuously entered (watchdog clock). */
  get since(): number {
    return this.statusSince
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => this.evaluate(), 1000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  feed(chunk: string): void {
    this.lastOutputAt = Date.now()
    this.tail = (this.tail + chunk).slice(-4000)
    if (!this.plain && chunk.includes(BEL)) {
      this.stickyAttention = true
      this.set('needs-attention')
      return
    }
    if (!this.stickyAttention) this.set('working')
  }

  /** User typed into the terminal — they've seen whatever was asking. */
  onUserInput(): void {
    this.stickyAttention = false
    if (this.status === 'needs-attention') this.set('idle')
  }

  /** Terminal process state changes override heuristics. */
  setExternal(status: SessionStatus): void {
    this.stickyAttention = false
    this.set(status)
  }

  private evaluate(): void {
    if (this.status === 'exited' || this.status === 'error' || this.status === 'starting') return
    if (this.stickyAttention) return
    const sinceOutput = Date.now() - this.lastOutputAt
    if (sinceOutput < 2500) return // feed() already set 'working'
    if (this.plain) {
      this.set('idle')
      return
    }
    const lastLines = stripAnsi(this.tail).split('\n').slice(-15).join('\n')
    this.set(ATTENTION_RE.test(lastLines) ? 'needs-attention' : 'idle')
  }

  private set(status: SessionStatus): void {
    if (this.status === status) return
    this.status = status
    this.statusSince = Date.now()
    this.emit(status)
  }
}
