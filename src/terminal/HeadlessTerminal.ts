import { EventEmitter } from 'events'
import type { IPty } from 'node-pty'
import xtermHeadless from '@xterm/headless'

const { Terminal } = xtermHeadless
type TerminalInstance = InstanceType<typeof Terminal>

// HeadlessTerminal — wraps @xterm/headless around a consumer-owned PTY.
//
// The consumer spawns the PTY (they own the binary, args, env, cwd)
// and passes the IPty instance here. We pipe its output into a
// headless Terminal, emit throttled screen snapshots, and accept
// write-through keystrokes. No process management — we never spawn
// or kill anything.
//
// This is the foundation primitive both claude-code-headless and
// codex-headless build on.

export type HeadlessTerminalOptions = {
  /** The PTY instance to attach to. Consumer owns its lifecycle. */
  pty: IPty
  /** Terminal columns. Default 120. */
  cols?: number
  /** Terminal rows. Default 40. */
  rows?: number
  /** Throttle interval in ms for screen snapshots. Default 16 (~60Hz). */
  snapshotIntervalMs?: number
}

export type ScreenSnapshot = {
  /** Plain text from translateToString. Source of truth for parsers. */
  plain: string
  /** Same screen with bold/italic reconstructed as markdown syntax. */
  markdown: string
}

export type HeadlessTerminalEvents = {
  /** Raw PTY bytes received. Use for recording/fidelity. */
  'pty-data': [string]
  /** Throttled dual-snapshot of the terminal buffer. */
  screen: [ScreenSnapshot]
  /** PTY child exited. */
  exit: [{ exitCode: number; signal?: number }]
}

export interface HeadlessTerminal {
  on<K extends keyof HeadlessTerminalEvents>(
    event: K,
    listener: (...args: HeadlessTerminalEvents[K]) => void,
  ): this
  off<K extends keyof HeadlessTerminalEvents>(
    event: K,
    listener: (...args: HeadlessTerminalEvents[K]) => void,
  ): this
  emit<K extends keyof HeadlessTerminalEvents>(
    event: K,
    ...args: HeadlessTerminalEvents[K]
  ): boolean
}

// --- Markdown reconstruction helpers ---

function emphasisMarker(bold: boolean, italic: boolean): string {
  if (bold && italic) return '***'
  if (bold) return '**'
  if (italic) return '*'
  return ''
}

/**
 * Pure function: walk a Terminal's active buffer and reconstruct
 * markdown from cell SGR attributes. Bold cells get **wrapped**,
 * italic cells get *wrapped*, both get ***wrapped***.
 *
 * Why: agents use chalk to render markdown as ANSI. By the time it
 * hits the terminal, `**bold**` is gone — replaced by SGR bold
 * attributes on each cell. translateToString drops those attributes.
 * This function reads them back and re-emits markdown markers.
 */
export function terminalToMarkdown(term: TerminalInstance): string {
  const buf = term.buffer.active
  const out: string[] = []

  const cell = (buf as { getNullCell?: () => unknown }).getNullCell?.() as
    | { isBold(): number; isItalic(): number; getChars(): string }
    | undefined

  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) {
      out.push('')
      continue
    }

    let row = ''
    let inBold = false
    let inItalic = false

    for (let x = 0; x < line.length; x++) {
      const c = (cell ? line.getCell(x, cell as never) : line.getCell(x)) ?? null
      if (!c) continue
      const chars = c.getChars() || ' '
      const nextBold = c.isBold() !== 0
      const nextItalic = c.isItalic() !== 0

      if (nextBold !== inBold || nextItalic !== inItalic) {
        row += emphasisMarker(inBold, inItalic)
        row += emphasisMarker(nextBold, nextItalic)
        inBold = nextBold
        inItalic = nextItalic
      }

      row += chars
    }

    row += emphasisMarker(inBold, inItalic)
    out.push(row.replace(/[ \t]+$/, ''))
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

// --- HeadlessTerminal class ---

export class HeadlessTerminal extends EventEmitter {
  private readonly pty: IPty
  private readonly term: TerminalInstance
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPending = false
  private exited = false
  private readonly snapshotIntervalMs: number

  constructor(options: HeadlessTerminalOptions) {
    super()
    this.pty = options.pty
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 16

    const cols = options.cols ?? 120
    const rows = options.rows ?? 40

    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 10000,
    })

    // Wire PTY output → headless terminal + events
    this.pty.onData((data: string) => {
      this.emit('pty-data', data)
      this.term.write(data)
      this.scheduleFlush()
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
      this.cleanup()
    })
  }

  /** Write raw bytes to the PTY. Used for keystroke synthesis. */
  write(data: string): void {
    this.pty.write(data)
  }

  /** Resize both the PTY and the headless terminal in lockstep. */
  resize(cols: number, rows: number): void {
    try {
      this.pty.resize(cols, rows)
      this.term.resize(cols, rows)
    } catch {
      // node-pty throws on 0/negative dims during transient layouts.
    }
  }

  /** Capture the current visible buffer as plain text. */
  snapshotPlain(): string {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  }

  /** Capture the buffer with bold/italic reconstructed as markdown. */
  snapshotMarkdown(): string {
    return terminalToMarkdown(this.term)
  }

  /**
   * Direct access to the headless Terminal instance for cell-level
   * attribute reads (e.g. slash picker fg color detection). Read-only.
   */
  getTerminal(): TerminalInstance {
    return this.term
  }

  /** True if the PTY has exited. */
  isExited(): boolean {
    return this.exited
  }

  /** Detach from the PTY and clean up timers. Does NOT kill the PTY
   *  — the consumer owns its lifecycle. */
  dispose(): void {
    this.cleanup()
  }

  // ---------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushPending) return
    this.flushPending = true
    this.flushTimer = setTimeout(() => {
      this.flushPending = false
      this.flushTimer = null
      this.emit('screen', {
        plain: this.snapshotPlain(),
        markdown: this.snapshotMarkdown(),
      })
    }, this.snapshotIntervalMs)
  }

  private cleanup(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPending = false
  }
}
