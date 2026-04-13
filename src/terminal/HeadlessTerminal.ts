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
//
// --- Lifecycle ---------------------------------------------------------------
//
// The constructor is INERT. It builds the headless xterm but does NOT
// subscribe to PTY events. The consumer is expected to call attach()
// after any other state that depends on PTY events (transcript tailers,
// log captures, recorders) has been wired up. Without this split, the
// PTY started emitting bytes as soon as `new HeadlessTerminal(...)`
// returned, which made the "tailer attached before terminal starts
// processing PTY data" invariant a polite fiction. Now it's enforceable:
// the terminal mirror does nothing until you call attach().
//
// --- write() race fix --------------------------------------------------------
//
// xterm's term.write() is async — the documented contract says the
// optional callback fires once the data has been fully parsed into the
// buffer. A naive implementation that calls term.write(data) and then
// schedules a snapshot on a setTimeout will race: the snapshot can fire
// before the buffer reflects the bytes we just wrote. Our previous
// implementation had this bug, and the testing/replay.ts script papered
// over it with a 50ms sleep. Now we explicitly use the callback as the
// signal to schedule a flush, so each snapshot is guaranteed to reflect
// every PTY byte that was already written.
//
// --- Viewport vs. full buffer ------------------------------------------------
//
// "Current screen" parsers (slash picker, trust dialog, activity,
// streaming text, in-progress assistant) all want the visible viewport
// only — what the user is looking at right now. Iterating buf.length
// includes 10k rows of scrollback, which means stale prompts, stale
// pickers, and stale assistant text from earlier turns leak into the
// "current state" parsers. snapshotPlain / snapshotMarkdown now scan
// the viewport region only (viewportY .. viewportY + term.rows). The
// scrollback is still kept in the xterm buffer for users who want to
// scroll back in the consumer UI; it just isn't fed to the parsers.

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
  /** Visible viewport as plain text. Source of truth for "current
   *  screen" parsers (trust dialog, slash picker, activity spinner,
   *  compaction banner, resume prompt). Anything that asks "what is
   *  CC showing right now?" reads this. */
  plain: string
  /** Viewport with bold/italic reconstructed as markdown syntax.
   *  Same row range as `plain`. */
  markdown: string
  /** A wider window (default last ~200 rows including scrollback)
   *  intended for content extractors that must walk past the visible
   *  area — most importantly extractAssistantInProgress, which
   *  scans bottom-up for the `⏺` marker. CC's streaming responses
   *  often grow taller than the viewport, scrolling the opening
   *  marker into scrollback; without this wider snapshot the
   *  streaming card stayed blank for long replies. Parsers should
   *  prefer `plain` unless they specifically need history. */
  recent: string
  /** Same wider window with markdown emphasis reconstructed. Mirror
   *  of `recent` for renderers that want the bold/italic preserved. */
  recentMarkdown: string
}

export type HeadlessTerminalEvents = {
  /** Raw PTY bytes received. Use for recording/fidelity. */
  'pty-data': [string]
  /** Throttled dual-snapshot of the terminal viewport. */
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
 *
 * Iterates the viewport only by default (the visible rows). Pass
 * `{ fullBuffer: true }` to walk the entire scrollback — useful for
 * recording / replay tooling that wants the complete history, but
 * NOT for "current screen" parsers which would otherwise pick up
 * stale formatting from earlier turns.
 */
export function terminalToMarkdown(
  term: TerminalInstance,
  opts: { fullBuffer?: boolean; recentRows?: number } = {},
): string {
  const buf = term.buffer.active
  const out: string[] = []

  const cell = (buf as { getNullCell?: () => unknown }).getNullCell?.() as
    | { isBold(): number; isItalic(): number; getChars(): string }
    | undefined

  // Three windowing modes:
  //   - fullBuffer: walk every row including all scrollback.
  //   - recentRows: walk the last N rows from the bottom of the
  //     buffer. Used for streaming extraction where we need history
  //     past the visible viewport but not all the way back.
  //   - default: viewport-only (current visible rows).
  const start = opts.fullBuffer
    ? 0
    : opts.recentRows !== undefined
      ? Math.max(0, buf.length - opts.recentRows)
      : buf.viewportY
  const end = opts.fullBuffer || opts.recentRows !== undefined
    ? buf.length
    : Math.min(buf.length, buf.viewportY + term.rows)

  for (let y = start; y < end; y++) {
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
  // Accumulates PTY bytes whose write callback hasn't fired yet. We
  // could have multiple parses in flight after rapid PTY chunks; we
  // only schedule a flush once the *latest* write completes, so we
  // don't snapshot a half-parsed buffer. See attach() for the use.
  private pendingWrites = 0
  private exited = false
  private attached = false
  private readonly snapshotIntervalMs: number
  // Stored disposables for the PTY listeners we wire in attach(). node-pty's
  // onData / onExit return objects with .dispose() — if we drop them on the
  // floor (as the previous implementation did) the listeners survive every
  // dispose() call and accumulate over the process lifetime.
  private ptyDataDisposable: { dispose: () => void } | null = null
  private ptyExitDisposable: { dispose: () => void } | null = null

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
    // NOTE: no PTY subscription here. Consumers must call attach()
    // after they've wired up everything that depends on PTY data
    // (transcript tailers, recorders). See file header.
  }

  /**
   * Subscribe to PTY events and start mirroring data into the headless
   * terminal. Idempotent — calling attach() twice is a no-op.
   *
   * Why this isn't done in the constructor: PTY data starts flowing
   * immediately once we subscribe. If a consumer needs to attach a
   * transcript tailer first (so it sees the very first JSONL entries
   * an agent emits), they need the freedom to wire that up before
   * the mirror activates.
   */
  attach(): void {
    if (this.attached) return
    this.attached = true

    this.ptyDataDisposable = this.pty.onData((data: string) => {
      this.emit('pty-data', data)
      // term.write is async — the callback fires once the bytes have
      // been parsed into the buffer. Schedule the flush from inside
      // the callback so snapshots always reflect already-parsed bytes.
      this.pendingWrites++
      this.term.write(data, () => {
        this.pendingWrites--
        // Only schedule when there are no more pending parses.
        // Otherwise rapid PTY chunks would each schedule a flush
        // and we'd snapshot mid-parse. The throttle inside
        // scheduleFlush() coalesces multiple completions into one
        // snapshot per snapshotIntervalMs window.
        if (this.pendingWrites === 0) this.scheduleFlush()
      })
    })

    this.ptyExitDisposable = this.pty.onExit(({ exitCode, signal }) => {
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

  /**
   * Capture the current visible viewport as plain text. Iterates only
   * `term.rows` lines starting at `buffer.viewportY` — scrollback is
   * intentionally excluded, see file header for the why.
   */
  snapshotPlain(): string {
    const buf = this.term.buffer.active
    const start = buf.viewportY
    const end = Math.min(buf.length, buf.viewportY + this.term.rows)
    const lines: string[] = []
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  }

  /** Capture the viewport with bold/italic reconstructed as markdown. */
  snapshotMarkdown(): string {
    return terminalToMarkdown(this.term)
  }

  /**
   * Capture the last `rows` lines of the buffer (viewport + recent
   * scrollback). Default 200 — enough to cover Claude responses that
   * scroll the opening `⏺` marker out of the visible viewport, while
   * staying small enough to keep parser walks cheap. Streaming
   * extractors call this; "current screen" parsers stick with
   * snapshotPlain().
   */
  snapshotRecent(rows = 200): string {
    const buf = this.term.buffer.active
    const start = Math.max(0, buf.length - rows)
    const lines: string[] = []
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  }

  /** Markdown-reconstructed counterpart of snapshotRecent. */
  snapshotRecentMarkdown(rows = 200): string {
    return terminalToMarkdown(this.term, { recentRows: rows })
  }

  /** Capture the entire xterm buffer (scrollback + viewport) as plain
   *  text. Use for recording / archival; not for "current screen"
   *  parsers — they should call snapshotPlain() instead. */
  snapshotFullBuffer(): string {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
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
        recent: this.snapshotRecent(),
        recentMarkdown: this.snapshotRecentMarkdown(),
      })
    }, this.snapshotIntervalMs)
  }

  private cleanup(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPending = false
    // Tear down PTY listeners. node-pty disposables are idempotent —
    // calling dispose() after the PTY has already exited is safe.
    if (this.ptyDataDisposable) {
      try { this.ptyDataDisposable.dispose() } catch { /* idempotent */ }
      this.ptyDataDisposable = null
    }
    if (this.ptyExitDisposable) {
      try { this.ptyExitDisposable.dispose() } catch { /* idempotent */ }
      this.ptyExitDisposable = null
    }
    this.attached = false
  }
}
