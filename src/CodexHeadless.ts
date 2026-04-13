import { EventEmitter } from 'events'
import type { IPty } from 'node-pty'
import { mkdir, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { watch } from 'chokidar'

import {
  HeadlessTerminal,
  type ScreenSnapshot,
} from './terminal/HeadlessTerminal.js'
import { tailSessionFile } from './transcript/JsonlTailer.js'
import {
  detectCodexActivity,
  extractCodexAssistantInProgress,
} from './parsers/ScreenParser.js'
import {
  detectCodexTrustDialog,
  type CodexTrustDialogState,
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
} from './parsers/TrustDialogParser.js'
import {
  type CodexRolloutLine,
  type CodexSessionMeta,
  type CodexResponseItem,
  type CodexEventMsg,
  isCodexSessionMeta,
} from './transcript/TranscriptTypes.js'
import { getCodexSessionsDir } from './transcript/ProjectDir.js'

// CodexHeadless — programmatic control of OpenAI Codex.
//
// Mirrors the ClaudeCodeHeadless API where possible. Key differences:
//
//   Binary:     `codex` not `claude`
//   Resume:     `codex resume <id>` (subcommand, not --resume flag)
//   Transcript: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//               (date-bucketed globally, not per-cwd)
//   Markers:    • for assistant, › for user (not ⏺ and ❯)
//   Trust:      "Do you trust the contents" (not "Accessing workspace")
//
// The consumer owns the PTY. This class never spawns or kills processes.

export type CodexHeadlessOptions = {
  /** Consumer-owned PTY running the `codex` binary. */
  pty: IPty
  /** Working directory the Codex session is running in. */
  cwd: string
  /** Terminal columns. Default 120. */
  cols?: number
  /** Terminal rows. Default 40. */
  rows?: number
  /** Throttle interval for screen snapshots in ms. Default 16. */
  snapshotIntervalMs?: number
  /** If set, tail the existing rollout file by thread ID instead of
   *  waiting for a new one. Used for resume flows. */
  resumeThreadId?: string
}

// --- Event types ---

export type CodexActivityEvent = { type: 'activity'; ts: number; status: string }
export type CodexIdleEvent = { type: 'idle'; ts: number }
export type CodexScreenEvent = { type: 'screen'; ts: number; plain: string; markdown: string }
export type CodexRolloutEntryEvent = {
  type: 'rollout_entry'; ts: number
  line: CodexRolloutLine; file: string
}
export type CodexTrustDialogEvent = {
  type: 'trust_dialog'; ts: number; workspace: string | undefined
  accept: () => void; reject: () => void
}
export type CodexExitEvent = { type: 'exit'; ts: number; exitCode: number; signal?: number }

export type CodexHeadlessEvent =
  | CodexActivityEvent
  | CodexIdleEvent
  | CodexScreenEvent
  | CodexRolloutEntryEvent
  | CodexTrustDialogEvent
  | CodexExitEvent

export type CodexHeadlessEvents = {
  event: [CodexHeadlessEvent]
  activity: [string]
  idle: []
  screen: [ScreenSnapshot]
  'rollout-entry': [CodexRolloutLine, string]
  'rollout-error': [Error]
  'trust-dialog': [CodexTrustDialogState]
  exit: [{ exitCode: number; signal?: number }]
}

export interface CodexHeadless {
  on<K extends keyof CodexHeadlessEvents>(
    event: K,
    listener: (...args: CodexHeadlessEvents[K]) => void,
  ): this
  off<K extends keyof CodexHeadlessEvents>(
    event: K,
    listener: (...args: CodexHeadlessEvents[K]) => void,
  ): this
  emit<K extends keyof CodexHeadlessEvents>(
    event: K,
    ...args: CodexHeadlessEvents[K]
  ): boolean
}

// Rollout filename pattern: rollout-<date>-<uuid>.jsonl
const CODEX_ROLLOUT_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export class CodexHeadless extends EventEmitter {
  private readonly terminal: HeadlessTerminal
  private readonly cwd: string
  private readonly resumeThreadId: string | null
  private stopRolloutTail: (() => Promise<void>) | null = null
  private lastActivity: string | null = null
  // See ClaudeCodeHeadless.idleDebounceTimer for the rationale —
  // briefly empty bottom-working-row snapshots between TUI redraws
  // would otherwise make the activity pip flicker green/dark every
  // turn. Codex's Working row is more stable than CC's rotating
  // spinner, but the same gap exists during tool-call animations, so
  // we apply the same 2500ms idle debounce for consistency.
  private idleDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastTrustVisible = false
  private sessionMeta: CodexSessionMeta | null = null

  constructor(options: CodexHeadlessOptions) {
    super()
    this.cwd = options.cwd
    this.resumeThreadId = options.resumeThreadId ?? null

    this.terminal = new HeadlessTerminal({
      pty: options.pty,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      snapshotIntervalMs: options.snapshotIntervalMs ?? 16,
    })

    // --- Wire terminal events ---

    this.terminal.on('screen', (snap) => {
      this.emit('screen', snap)
      this.emit('event', { type: 'screen', ts: Date.now(), ...snap })

      // Activity detection — active fires immediately, idle is
      // debounced to absorb transient frames where the bottom Working
      // row is missing from the snapshot (tool-output animation
      // cycles, header swaps, etc.).
      const activity = detectCodexActivity(snap.plain)
      if (activity !== this.lastActivity) {
        if (activity) {
          if (this.idleDebounceTimer) {
            clearTimeout(this.idleDebounceTimer)
            this.idleDebounceTimer = null
          }
          this.lastActivity = activity
          this.emit('activity', activity)
          this.emit('event', { type: 'activity', ts: Date.now(), status: activity })
        } else {
          if (this.idleDebounceTimer) clearTimeout(this.idleDebounceTimer)
          this.idleDebounceTimer = setTimeout(() => {
            this.idleDebounceTimer = null
            // Re-check from current screen — if Codex restarted working
            // during the debounce, do not flip to idle.
            if (detectCodexActivity(this.terminal.snapshotPlain())) return
            this.lastActivity = null
            this.emit('idle')
            this.emit('event', { type: 'idle', ts: Date.now() })
          }, 2500)
        }
      }

      // Trust dialog detection — emit on EVERY transition so consumers
      // can track open + dismiss. The previous implementation only fired
      // on hidden→visible, which meant the renderer's modal had no way
      // to learn the dialog had closed (after the user accepted/rejected,
      // or after Codex auto-dismissed) and would stick on screen.
      const trust = detectCodexTrustDialog(snap.plain)
      if (trust.visible !== this.lastTrustVisible) {
        this.lastTrustVisible = trust.visible
        this.emit('trust-dialog', trust)
        if (trust.visible) {
          // Only the rich event variant (with accept/reject callbacks)
          // makes sense when the dialog is actually visible. The simple
          // 'trust-dialog' event above carries the full state either way.
          this.emit('event', {
            type: 'trust_dialog',
            ts: Date.now(),
            workspace: trust.workspace,
            accept: () => this.write(CODEX_TRUST_DIALOG_ACCEPT_KEYS),
            reject: () => this.write('2\r'),
          })
        }
      }
    })

    this.terminal.on('exit', ({ exitCode, signal }) => {
      this.emit('exit', { exitCode, signal })
      this.emit('event', { type: 'exit', ts: Date.now(), exitCode, signal })
      void this.cleanup()
    })
  }

  /**
   * Start processing: find or wait for the rollout JSONL file and
   * begin tailing it. Call after the PTY is spawned.
   *
   * Codex stores rollouts in ~/.codex/sessions/YYYY/MM/DD/ — a
   * global date tree, not per-cwd like Claude. For fresh sessions
   * we watch the tree recursively for the first new rollout-*.jsonl;
   * for resume we find the existing file by thread ID.
   */
  async start(): Promise<{ sessionsDir: string }> {
    const sessionsDir = getCodexSessionsDir()

    if (this.resumeThreadId) {
      // First try: locate the existing rollout file by thread id. The
      // common case for `codex resume <id>` — file already exists from
      // the original session and Codex appends to it on reopen.
      const rolloutPath = await this.findRolloutByThreadId(
        sessionsDir,
        this.resumeThreadId,
      )
      if (rolloutPath) {
        this.stopRolloutTail = this.tailFile(rolloutPath)
      } else {
        // Fallback: lookup missed (rare — usually a date-tree race or a
        // resume where Codex actually forks a NEW rollout file). The
        // previous behavior was to silently attach the terminal with no
        // tail at all, so the resumed pane received zero transcript
        // events. Now we surface the lookup miss as a non-fatal error
        // and fall back to the new-file watcher — if Codex creates a
        // new rollout (fork case) we'll catch it; if not, the consumer
        // at least knows lookup failed and can retry / surface a
        // diagnostic instead of staring at an inert pane.
        this.emit(
          'rollout-error',
          new Error(
            `Codex resume: rollout file for thread ${this.resumeThreadId} not found under ${sessionsDir}; falling back to new-file watcher`,
          ),
        )
        this.stopRolloutTail = await this.tailNewRolloutFile(sessionsDir)
      }
    } else {
      this.stopRolloutTail = await this.tailNewRolloutFile(sessionsDir)
    }

    // Tailer is wired — let PTY data flow into the headless terminal
    // mirror. See HeadlessTerminal file header for why this is split
    // out of the constructor.
    this.terminal.attach()

    return { sessionsDir }
  }

  // --- Input ---

  write(data: string): void {
    this.terminal.write(data)
  }

  sendPrompt(text: string): void {
    if (text.includes('\n')) {
      this.write(`\x1b[200~${text}\x1b[201~\r`)
    } else {
      this.write(text + '\r')
    }
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
  }

  // --- State queries ---

  isIdle(): boolean {
    return this.lastActivity === null
  }

  isWorking(): boolean {
    return this.lastActivity !== null
  }

  getActivity(): string | null {
    return this.lastActivity
  }

  getScreen(): string {
    return this.terminal.snapshotPlain()
  }

  getScreenMarkdown(): string {
    return this.terminal.snapshotMarkdown()
  }

  getAssistantInProgress(): string {
    return extractCodexAssistantInProgress(this.terminal.snapshotPlain())
  }

  /** The session metadata from the first rollout entry, if received. */
  getSessionMeta(): CodexSessionMeta | null {
    return this.sessionMeta
  }

  isExited(): boolean {
    return this.terminal.isExited()
  }

  // --- Cleanup ---

  async stop(): Promise<void> {
    this.terminal.dispose()
    await this.cleanup()
  }

  private async cleanup(): Promise<void> {
    if (this.stopRolloutTail) {
      try { await this.stopRolloutTail() } catch { /* best-effort */ }
      this.stopRolloutTail = null
    }
  }

  // --- Rollout file tailing ---

  /**
   * Tail a single rollout JSONL file using the proven poll-based
   * JsonlTailer (same implementation Claude uses). Each line is
   * parsed and emitted as 'rollout-entry'. The first session_meta
   * entry is captured for getSessionMeta().
   */
  private tailFile(filePath: string): () => Promise<void> {
    return tailSessionFile(
      filePath,
      (entry) => {
        const line = entry as unknown as CodexRolloutLine
        // Capture session meta from the first entry that has it.
        if (isCodexSessionMeta(line) && !this.sessionMeta) {
          this.sessionMeta = line.payload as CodexSessionMeta
        }
        this.emit('rollout-entry', line, filePath)
        this.emit('event', {
          type: 'rollout_entry', ts: Date.now(), line, file: filePath,
        })
      },
      (err) => {
        this.emit('rollout-error', err)
      },
    )
  }

  /**
   * Watch the Codex sessions directory for a new rollout file.
   * Snapshots existing files first, then watches for adds.
   */
  private async tailNewRolloutFile(
    sessionsDir: string,
  ): Promise<() => Promise<void>> {
    await mkdir(sessionsDir, { recursive: true })

    // Snapshot existing files so we only tail NEW ones.
    const existing = new Set<string>()
    const primingWatcher = watch(sessionsDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 4,
    })
    await new Promise<void>(resolve => {
      primingWatcher.on('add', (filePath: string) => existing.add(filePath))
      primingWatcher.on('ready', resolve)
    })
    await primingWatcher.close()

    let stopTail: (() => Promise<void>) | null = null
    const watcher = watch(sessionsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 4,
    })
    watcher.on('add', (filePath: string) => {
      if (stopTail) return
      const name = filePath.split('/').pop() ?? ''
      if (!CODEX_ROLLOUT_RE.test(name)) return
      if (existing.has(filePath)) return
      stopTail = this.tailFile(filePath)
    })
    watcher.on('error', (err: unknown) => this.emit('rollout-error', err instanceof Error ? err : new Error(String(err))))

    return async () => {
      await watcher.close()
      if (stopTail) await stopTail()
    }
  }

  /**
   * Find a rollout file by thread ID. Walks the date tree backwards
   * (most recent dates first) looking for a filename containing the ID.
   */
  private async findRolloutByThreadId(
    sessionsDir: string,
    threadId: string,
  ): Promise<string | null> {
    try {
      const years = await readdir(sessionsDir)
      // Walk backwards: most recent first
      for (const year of years.sort().reverse()) {
        const yearDir = join(sessionsDir, year)
        const yStat = await stat(yearDir).catch(() => null)
        if (!yStat?.isDirectory()) continue
        const months = await readdir(yearDir)
        for (const month of months.sort().reverse()) {
          const monthDir = join(yearDir, month)
          const mStat = await stat(monthDir).catch(() => null)
          if (!mStat?.isDirectory()) continue
          const days = await readdir(monthDir)
          for (const day of days.sort().reverse()) {
            const dayDir = join(monthDir, day)
            const dStat = await stat(dayDir).catch(() => null)
            if (!dStat?.isDirectory()) continue
            const files = await readdir(dayDir)
            const match = files.find(f => f.includes(threadId) && f.endsWith('.jsonl'))
            if (match) return join(dayDir, match)
          }
        }
      }
    } catch {
      // sessions dir might not exist yet
    }
    return null
  }
}
