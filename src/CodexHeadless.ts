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
  type CodexTurnStartedEvent,
  type CodexTurnCompleteEvent,
  type CodexAgentMessageEvent,
  type CodexAgentMessageDeltaEvent,
  type CodexExecCommandBeginEvent,
  type CodexExecCommandEndEvent,
  type CodexExecCommandOutputDeltaEvent,
  type CodexMcpToolCallBeginEvent,
  type CodexMcpToolCallEndEvent,
  type CodexMessageItem,
  isCodexSessionMeta,
  isCodexResponseItem,
  isCodexEventMsg,
  extractCodexMessageText,
} from './transcript/TranscriptTypes.js'
import { getCodexSessionsDir } from './transcript/ProjectDir.js'

// Three-channel truth surface. The semantic channel consumes the
// rollout delta stream (agent_message_delta / turn lifecycle / tool
// begin+end) directly and is the preferred source for JIT markdown
// rendering. The screen channel carries TUI visibility state (trust
// dialog, approval overlay, activity). The committed channel reflects
// durable rollout entries. See src/channels/types.ts for the full
// rationale; the split fixes the historical problem of semantic and
// visual truth being braided together in one event stream.
import { CommittedChannel } from './channels/CommittedChannel.js'
import { ScreenChannel } from './channels/ScreenChannel.js'
import { SemanticChannel } from './channels/SemanticChannel.js'

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
  private static readonly RESUME_BOOTSTRAP_TAIL_LINES = 200
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

  // --- Three-channel truth surface ---------------------------------------
  //
  // These run IN ADDITION TO the legacy flat event surface so existing
  // cc-shell consumers keep working. See src/channels/types.ts for the
  // rationale behind splitting semantic / screen / committed into three
  // separate streams.
  readonly semantic = new SemanticChannel()
  readonly screen = new ScreenChannel()
  readonly committed = new CommittedChannel()

  /** Active semantic turn id. For Codex this is usually the rollout's
   *  `turn_id` once we've seen a `task_started` / `turn_started`
   *  event. If the TUI reports activity before the rollout file has
   *  any event for this turn (rare — file creation race), we fall
   *  back to a synthetic `live-<ts>` id and promote to the real id
   *  when the first rollout event arrives. */
  private liveSemanticTurnId: string | null = null
  /** Whether the live semantic turn is currently screen-sourced. Used
   *  to decide whether a screen snapshot should publish a fallback
   *  delta (only when no higher-trust source is driving the turn). */
  private semanticSource: 'rollout' | 'screen' | null = null
  /** Last text we emitted from the screen fallback extractor. Used to
   *  suppress duplicate screen-sourced deltas. */
  private lastScreenSemanticText = ''
  /** Accumulated text for the in-flight assistant turn when rollout
   *  deltas are the source. Rebuilt by appending `agent_message_delta`
   *  payloads; used as `fullText` on the semantic delta events so late
   *  subscribers can skip to the current state. */
  private rolloutAssistantText = ''
  /** Screen-fallback baseline — the assistant block visible on the
   *  TUI at the moment a screen-sourced turn starts. Suppresses the
   *  first fallback delta until the extracted text actually differs
   *  from this. Without it, the previous turn's assistant text still
   *  sitting on screen gets published as the first delta of the new
   *  turn and leaks into the rendered feed. Cleared by
   *  `resetLiveTurn` on any turn end / takeover. */
  private screenBaselineText = ''
  private screenBaselineSatisfied = false

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

      // Screen channel — mirror-of-terminal cadence. Semantic deltas
      // derived from screen are gated on "no higher-trust source
      // active", so we still want to publish every snapshot here for
      // consumers that mirror the PTY.
      this.screen.publishSnapshot({ plain: snap.plain, markdown: snap.markdown })

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
          this.screen.publishActivity({ active: true, status: activity })

          // Semantic fallback: open a screen-sourced turn ONLY if the
          // rollout stream hasn't already opened one. The moment
          // rollout deltas arrive they'll take over via
          // `source_changed`, which is the whole point of the tag.
          if (!this.liveSemanticTurnId) {
            this.liveSemanticTurnId = `live-${Date.now()}`
            this.semanticSource = 'screen'
            this.lastScreenSemanticText = ''
            // Capture current assistant block as the baseline — until
            // the next screen extract differs, we're looking at the
            // PREVIOUS turn's text still on-screen. See
            // screenBaselineText field docs.
            this.screenBaselineText =
              extractCodexAssistantInProgress(snap.recent) || ''
            this.screenBaselineSatisfied = false
            this.semantic.startTurn({
              turnId: this.liveSemanticTurnId,
              role: 'assistant',
              source: 'screen',
              confidence: 'fallback',
            })
          }
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
            this.screen.publishActivity({ active: false, status: null })

            // If the live semantic turn was screen-sourced, seal it
            // now. Rollout-sourced turns are sealed by
            // `task_complete` / `turn_complete`, not by the idle
            // debounce — we don't want the TUI missing a frame to
            // accidentally close a turn the rollout still has deltas
            // for.
            if (this.liveSemanticTurnId && this.semanticSource === 'screen') {
              this.semantic.finishTurn({
                turnId: this.liveSemanticTurnId,
                fullText: this.lastScreenSemanticText || undefined,
                source: 'screen',
                confidence: 'fallback',
              })
              this.resetLiveTurn()
            }
          }, 2500)
        }
      }

      // Screen-sourced semantic fallback. Run the extractor only when
      // no higher-trust source is driving the live turn. This is
      // belt-and-braces for the narrow window between "TUI started
      // drawing assistant text" and "rollout emitted the first
      // agent_message_delta for this turn".
      if (this.liveSemanticTurnId && this.semanticSource === 'screen') {
        // Use the wider `recent` window so the extractor still finds
        // the assistant block after it scrolls past the viewport.
        const text = extractCodexAssistantInProgress(snap.recent)

        // Baseline gate — until the text differs from the block that
        // was on-screen when the turn started, the buffer is still
        // showing the PREVIOUS turn's answer. Publishing it would
        // leak that answer into the new turn's first delta.
        if (!this.screenBaselineSatisfied) {
          if (!text || text === this.screenBaselineText) {
            return
          }
          this.screenBaselineSatisfied = true
        }

        if (text && text !== this.lastScreenSemanticText) {
          const delta = text.startsWith(this.lastScreenSemanticText)
            ? text.slice(this.lastScreenSemanticText.length)
            : undefined
          this.lastScreenSemanticText = text
          this.semantic.applyDelta({
            turnId: this.liveSemanticTurnId,
            fullText: text,
            textDelta: delta,
            markdownText: extractCodexAssistantInProgress(snap.recentMarkdown) || undefined,
            source: 'screen',
            confidence: 'fallback',
          })
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
        this.screen.publishTrustDialog(trust)
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

        // Committed channel — everything written to the rollout file
        // is durable by construction. The channel decides which
        // entries also emit a `turn_committed` / `session_meta` etc.
        this.committed.publishLine(line, filePath)

        // Semantic channel — feed rollout deltas + lifecycle events
        // as the authoritative live source.
        this.ingestRolloutIntoSemantic(line)
      },
      (err) => {
        this.emit('rollout-error', err)
        this.committed.publishError(err)
      },
      this.resumeThreadId
        ? { bootstrapTailLines: CodexHeadless.RESUME_BOOTSTRAP_TAIL_LINES }
        : undefined,
    )
  }

  // --- Rollout → semantic translation -----------------------------------
  //
  // Codex's rollout stream is the primary live semantic source. This
  // helper maps rollout `event_msg` deltas and tool lifecycle events
  // onto the SemanticChannel's normalized shape. It also consumes
  // `response_item` messages as a belt-and-braces fallback: if a
  // session somehow produces a committed assistant message without a
  // preceding `agent_message_delta` (some server variants collapse
  // short replies), the message text still lands on the semantic
  // channel with `confidence: 'medium'` so consumers see it.
  private ingestRolloutIntoSemantic(line: CodexRolloutLine): void {
    if (isCodexEventMsg(line)) {
      // The event union includes a CodexGenericEvent catch-all, which
      // makes TS narrow to `{ type: string; [k: string]: unknown }`
      // inside the switch and loses the specific payload fields. We
      // re-cast in each branch via `evt as <SpecificEvent>` to get the
      // typed fields back. Using a single `as any` at the top would
      // hide bugs; per-branch casts keep each branch auditable.
      const evt = line.payload as CodexEventMsg

      switch (evt.type) {
        case 'task_started':
        case 'turn_started': {
          const e = evt as CodexTurnStartedEvent
          // Promote or open the live turn with the real rollout id.
          // If a screen-sourced turn was already open, replace it —
          // we seal the screen turn explicitly so its consumer sees
          // a clean `turn_completed` event before the rollout one
          // starts, which is simpler than mutating turnId in place.
          if (
            this.liveSemanticTurnId &&
            this.semanticSource === 'screen'
          ) {
            this.semantic.finishTurn({
              turnId: this.liveSemanticTurnId,
              fullText: this.lastScreenSemanticText || undefined,
              source: 'screen',
              confidence: 'fallback',
            })
          }
          this.liveSemanticTurnId = e.turn_id
          this.semanticSource = 'rollout'
          this.rolloutAssistantText = ''
          this.lastScreenSemanticText = ''
          // Rollout has taken over; the screen baseline is
          // obsolete.
          this.screenBaselineText = ''
          this.screenBaselineSatisfied = false
          this.semantic.startTurn({
            turnId: e.turn_id,
            role: 'assistant',
            source: 'rollout',
            confidence: 'high',
          })
          return
        }

        case 'agent_message_delta': {
          const e = evt as CodexAgentMessageDeltaEvent
          if (!e.delta) return
          // Codex does not embed the turn_id on delta events (only on
          // task_started / task_complete), so we infer it from the
          // currently-open turn. If none is open we open a rollout-
          // sourced one on the fly — better than dropping the delta.
          const turnId = this.liveSemanticTurnId ?? `rollout-${Date.now()}`
          if (!this.liveSemanticTurnId) {
            this.liveSemanticTurnId = turnId
            this.semanticSource = 'rollout'
            this.rolloutAssistantText = ''
          }
          this.rolloutAssistantText += e.delta
          this.semanticSource = 'rollout'
          this.semantic.applyDelta({
            turnId,
            textDelta: e.delta,
            fullText: this.rolloutAssistantText,
            source: 'rollout',
            confidence: 'high',
          })
          return
        }

        case 'agent_message': {
          const e = evt as CodexAgentMessageEvent
          // Final snapshot of assistant text for the turn. Some Codex
          // variants emit this INSTEAD OF a trailing delta, so we use
          // it to ensure the fullText matches the committed form.
          if (!this.liveSemanticTurnId) return
          const fullText = e.message ?? this.rolloutAssistantText
          this.rolloutAssistantText = fullText
          this.semantic.applyDelta({
            turnId: this.liveSemanticTurnId,
            fullText,
            source: 'rollout',
            confidence: 'high',
          })
          return
        }

        case 'task_complete':
        case 'turn_complete': {
          if (!this.liveSemanticTurnId) return
          this.semantic.finishTurn({
            turnId: this.liveSemanticTurnId,
            fullText: this.rolloutAssistantText || undefined,
            source: 'rollout',
            confidence: 'high',
          })
          this.resetLiveTurn()
          return
        }

        case 'exec_command_begin': {
          const e = evt as CodexExecCommandBeginEvent
          const label = e.command?.join(' ')
          this.semantic.toolStarted({
            callId: e.call_id ?? `exec-${Date.now()}`,
            tool: 'exec',
            label,
            source: 'rollout',
          })
          return
        }

        case 'exec_command_output_delta': {
          const e = evt as CodexExecCommandOutputDeltaEvent
          if (!e.delta || !e.call_id) return
          this.semantic.toolOutputDelta({
            callId: e.call_id,
            textDelta: e.delta,
            source: 'rollout',
          })
          return
        }

        case 'exec_command_end': {
          const e = evt as CodexExecCommandEndEvent
          this.semantic.toolCompleted({
            callId: e.call_id ?? `exec-${Date.now()}`,
            exitCode: e.exit_code,
            source: 'rollout',
          })
          return
        }

        case 'mcp_tool_call_begin': {
          const e = evt as CodexMcpToolCallBeginEvent
          const label =
            e.server_name && e.tool_name
              ? `${e.server_name}.${e.tool_name}`
              : e.tool_name
          this.semantic.toolStarted({
            callId: e.call_id ?? `mcp-${Date.now()}`,
            tool: 'mcp',
            label,
            source: 'rollout',
          })
          return
        }

        case 'mcp_tool_call_end': {
          const e = evt as CodexMcpToolCallEndEvent
          this.semantic.toolCompleted({
            callId: e.call_id ?? `mcp-${Date.now()}`,
            source: 'rollout',
          })
          return
        }

        default:
          // Unknown / unhandled event types (token_count, error, user
          // message echoes, approval requests, …) are not relevant to
          // the semantic channel. Approval requests surface on the
          // screen channel instead because they are UI overlays, not
          // model output.
          return
      }
    }

    if (isCodexResponseItem(line)) {
      const item = line.payload as CodexResponseItem
      // Fallback: a committed assistant message arrived, possibly
      // without a preceding `agent_message_delta` / `agent_message`.
      //
      // WHY we no longer gate this on `this.liveSemanticTurnId`:
      //   The earlier guard made the fallback unreachable in the
      //   exact shape it was supposed to cover. Short replies that
      //   skip deltas usually also skip `task_started`, so no live
      //   turn is ever opened — the guard filtered out every case
      //   the block existed for. Instead we synthesise a rollout
      //   turn id on the fly (same pattern as `agent_message_delta`)
      //   and seal it immediately after the snapshot so downstream
      //   consumers see a complete turn boundary.
      if (
        item.type === 'message' &&
        (item as CodexMessageItem).role === 'assistant'
      ) {
        const text = extractCodexMessageText(item as CodexMessageItem)
        if (!text) return
        if (this.liveSemanticTurnId) {
          if (text === this.rolloutAssistantText) return
          this.rolloutAssistantText = text
          this.semantic.applyDelta({
            turnId: this.liveSemanticTurnId,
            fullText: text,
            source: 'rollout',
            confidence: 'medium',
          })
          return
        }

        // No live turn — open, publish, seal.
        const turnId = `rollout-${Date.now()}`
        this.liveSemanticTurnId = turnId
        this.semanticSource = 'rollout'
        this.rolloutAssistantText = text
        this.semantic.startTurn({
          turnId,
          role: 'assistant',
          source: 'rollout',
          confidence: 'medium',
        })
        this.semantic.applyDelta({
          turnId,
          fullText: text,
          source: 'rollout',
          confidence: 'medium',
        })
        this.semantic.finishTurn({
          turnId,
          fullText: text,
          source: 'rollout',
          confidence: 'medium',
        })
        this.resetLiveTurn()
      }
    }
  }

  // WHY a helper:
  //   Live-turn tracking spans four fields (liveSemanticTurnId,
  //   semanticSource, rolloutAssistantText, lastScreenSemanticText)
  //   and they all have to clear together when a turn seals.
  //   Inline resets were starting to drift — one seal site cleared
  //   three fields, another cleared two — which made subtle bugs
  //   where a later turn inherited a prior turn's screen text.
  //   Funnelling every "turn is over" path through this method
  //   prevents the next branch from silently diverging.
  private resetLiveTurn(): void {
    this.liveSemanticTurnId = null
    this.semanticSource = null
    this.rolloutAssistantText = ''
    this.lastScreenSemanticText = ''
    this.screenBaselineText = ''
    this.screenBaselineSatisfied = false
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
