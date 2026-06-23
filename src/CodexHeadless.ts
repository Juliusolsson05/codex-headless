import { EventEmitter } from 'events'
import type { IPty } from 'node-pty'
import { mkdir, readdir, readFile, stat } from 'fs/promises'
import { realpathSync } from 'fs'
import { join, resolve } from 'path'
import { watch } from 'chokidar'

import {
  HeadlessTerminal,
  type ScreenSnapshot,
} from './terminal/HeadlessTerminal.js'
import { tailSessionFile } from './transcript/JsonlTailer.js'
import {
  decideFreshRolloutClaim,
  extractSubmittedPromptFromWrite,
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
  type FreshRolloutCandidate,
  type SubmittedPrompt,
} from './transcript/FreshRolloutClaim.js'
import {
  collectRolloutLineageIds,
  decideResumeForkCandidate,
} from './transcript/ResumeForkCandidate.js'
import {
  detectCodexActivity,
  extractCodexAssistantInProgress,
} from './parsers/ScreenParser.js'
import {
  detectCodexApproval,
  type ScreenApproval,
} from './parsers/ApprovalParser.js'
import {
  detectCodexTrustDialog,
  type CodexTrustDialogState,
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
} from './parsers/TrustDialogParser.js'
import {
  makeEvaluator,
  CODEX_MODULES,
  type CodexApprovalMetadata,
  type CodexConditionInputs,
  type CodexConditionSnapshot,
  type ConditionEvaluator,
} from './conditions/index.js'
import {
  type CodexRolloutLine,
  type CodexSessionMeta,
  type CodexResponseItem,
  type CodexEventMsg,
  type CodexTurnStartedEvent,
  type CodexTurnCompleteEvent,
  type CodexTurnAbortedEvent,
  type CodexAgentMessageEvent,
  type CodexAgentMessageDeltaEvent,
  type CodexExecCommandBeginEvent,
  type CodexExecCommandEndEvent,
  type CodexExecCommandOutputDeltaEvent,
  type CodexExecApprovalRequestEvent,
  type CodexMcpToolCallBeginEvent,
  type CodexMcpToolCallEndEvent,
  type CodexMessageItem,
  isCodexSessionMeta,
  isCodexResponseItem,
  isCodexEventMsg,
  isCodexMessageItem,
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
import type {
  LiveOwnerDecision,
  LiveOwnerKind,
  LiveOwnerState,
} from './channels/types.js'

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
export type CodexConditionsEvent = {
  type: 'conditions'
  ts: number
  snapshot: CodexConditionSnapshot
}
export type CodexExitEvent = { type: 'exit'; ts: number; exitCode: number; signal?: number }
export type CodexRolloutDiagnostic = {
  type: 'resume-fork-ignored'
  ts: number
  message: string
  candidatePath: string
  initialPath: string
  reason: 'missing-lineage' | 'insufficient-lineage-overlap'
  lineageOverlap: number
  requiredOverlap: number
}

export type CodexHeadlessEvent =
  | CodexActivityEvent
  | CodexIdleEvent
  | CodexScreenEvent
  | CodexRolloutEntryEvent
  | CodexTrustDialogEvent
  | CodexConditionsEvent
  | CodexExitEvent

export type CodexHeadlessEvents = {
  event: [CodexHeadlessEvent]
  activity: [string]
  idle: []
  screen: [ScreenSnapshot]
  'rollout-entry': [CodexRolloutLine, string]
  'rollout-error': [Error]
  'rollout-diagnostic': [CodexRolloutDiagnostic]
  'trust-dialog': [CodexTrustDialogState]
  approval: [ScreenApproval | null]
  conditions: [CodexConditionSnapshot]
  exit: [{ exitCode: number; signal?: number }]

  // Live-owner decision stream. Fires on every claim/clear/promote
  // decision so debug tooling can watch live-turn authority change
  // hands. Intentionally NOT part of the typed `event` union because
  // consumers that don't care can ignore it without type churn. See
  // the corresponding Claude-side comment for rationale.
  'live-owner-change': [LiveOwnerDecision]
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

// Canonicalise a cwd for comparison. The rollout fork detector
// compares the cwd we were launched with against the cwd Codex
// recorded into a candidate rollout's session_meta. A raw `===` is
// wrong: on macOS the path may differ by symlink (`/var` vs
// `/private/var`, `/tmp` vs `/private/tmp`), by case (HFS+/APFS are
// case-insensitive by default), or by a trailing slash / `..`
// segment from a non-canonical caller. realpathSync.native resolves
// all three; it throws if the path no longer exists, in which case
// we fall back to `resolve` (handles `..`/trailing-slash only).
function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd)
  } catch {
    return resolve(cwd)
  }
}

export class CodexHeadless extends EventEmitter {
  private static readonly RESUME_BOOTSTRAP_TAIL_LINES = 200
  private static readonly RESUME_FORK_WATCH_MS = 120000
  // How much of a candidate rollout to read when checking it for the
  // fork lineage. Generous on purpose: Codex prepends large synthetic
  // bootstrap entries (AGENTS.md preamble, environment_context) to a
  // reconstructed history, and the copied item ids we match against
  // sit after them — a small prefix could miss every shared id and
  // false-negative a real fork. Reads only happen on fresh-file
  // events inside the bounded resume window, so 4 MiB is cheap.
  private static readonly ROLLOUT_CANDIDATE_READ_BYTES = 4 * 1024 * 1024
  // A candidate same-cwd rollout must share at least this many item
  // ids with the resumed file before we accept it as a fork of the
  // resumed session (rather than an unrelated sibling agent). See
  // isResumeForkCandidate.
  private static readonly RESUME_LINEAGE_MIN_OVERLAP = 3
  private readonly terminal: HeadlessTerminal
  private readonly cwd: string
  private readonly resumeThreadId: string | null
  private stopRolloutTail: (() => Promise<void>) | null = null
  private activeRolloutPath: string | null = null
  private tailedRolloutPaths = new Set<string>()
  // WHY fresh sessions keep their own prompt ledger:
  //
  // A fresh Codex PTY does not expose its provider `ThreadId` to Agent
  // Code until a rollout file eventually writes `session_meta`. The
  // old fallback guessed that the first new global rollout file after
  // spawn belonged to this PTY. That guess is exactly what breaks
  // orchestration: four sibling PTYs in the same cwd can all see the
  // same first JSONL and then permanently capture the sibling's
  // provider id. The prompt bytes are one of the few signals that are
  // private to THIS headless instance, so the fresh tailer requires a
  // candidate rollout's first real user message to match a prompt that
  // passed through this instance before it starts tailing committed
  // transcript lines.
  private submittedPrompts: SubmittedPrompt[] = []
  private freshRolloutCandidates = new Map<string, FreshRolloutCandidate>()
  private freshRolloutClaimTask: Promise<void> = Promise.resolve()
  private freshRolloutStopTail: (() => Promise<void>) | null = null
  private lastActivity: string | null = null
  // See ClaudeCodeHeadless.idleDebounceTimer for the rationale —
  // briefly empty bottom-working-row snapshots between TUI redraws
  // would otherwise make the activity pip flicker green/dark every
  // turn. Codex's Working row is more stable than CC's rotating
  // spinner, but the same gap exists during tool-call animations, so
  // we apply the same 2500ms idle debounce for consistency.
  private idleDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastTrustVisible = false
  private trustDialogState: CodexTrustDialogState = { visible: false }
  private approvalState: ScreenApproval | null = null
  private approvalMetadata: CodexApprovalMetadata | null = null
  private lastApprovalKey: string | null = null
  private conditionSnapshot: CodexConditionSnapshot = {
    provider: 'codex',
    conditions: {},
    ts: Date.now(),
  }
  // The long-lived generic evaluator that drives this session's condition
  // snapshots. It OWNS the dedupe latch (seeded to '{}' internally, matching the
  // old `lastConditionKey = '{}'` so the first empty snapshot is correctly a
  // no-change). Built once per CodexHeadless instance with the ordered
  // CODEX_MODULES registry and the real wall clock. Replaces the old hand-rolled
  // `evaluateCodexConditions` + `codexConditionSnapshotKey` + `lastConditionKey`
  // trio — see publishConditionSnapshot. The emitted snapshot shape and the two
  // events are byte-identical to before (verified out-of-band by a throwaway
  // byte-for-byte comparison of the OLD and NEW serialized snapshots — not
  // committed, per the repo's no-committed-tests policy).
  private readonly conditionEvaluator: ConditionEvaluator<
    'codex',
    CodexConditionInputs
  > = makeEvaluator('codex', CODEX_MODULES, () => Date.now())
  private sessionMeta: CodexSessionMeta | null = null

  // --- Three-channel truth surface ---------------------------------------
  //
  // These run IN ADDITION TO the legacy flat event surface so existing
  // Agent Code consumers keep working. See src/channels/types.ts for the
  // rationale behind splitting semantic / screen / committed into three
  // separate streams.
  readonly semantic = new SemanticChannel()
  readonly screen = new ScreenChannel()
  readonly committed = new CommittedChannel()

  /** Shadow SemanticChannel — dedicated sink for screen-fallback
   *  publishing. Nobody in Agent Code's renderer subscribes to this.
   *
   *  WHY this exists:
   *
   *  Pre-2026-04-18 Codex had three independent producers that could
   *  race for the same live-turn slot on `semantic`: proxy,
   *  rollout, and screen fallback. The visible block flicker (see
   *  2026-04-17-codex-semantic-flicker-fix.md) is a direct symptom.
   *  The 2026-04-18 redesign plan draws a hard line: screen is an
   *  overlay/bootstrap source, not a live content source. We route
   *  every screen-sourced startTurn/applyDelta/finishTurn call to
   *  this shadow channel so the production path keeps working and
   *  subscribers that care can still observe it, but Agent Code's
   *  main rendering consumes only `semantic` and will never see
   *  screen-derived assistant content again.
   *
   *  Screen parsing for OVERLAYS (trust dialog, approval overlay,
   *  working-row activity) continues to fire on the `screen`
   *  channel — that surface was never the problem. */
  readonly semanticShadow = new SemanticChannel()

  /** Active semantic turn id. For Codex this is usually the rollout's
   *  `turn_id` once we've seen a `task_started` / `turn_started`
   *  event. If the TUI reports activity before the rollout file has
   *  any event for this turn (rare — file creation race), we fall
   *  back to a synthetic `live-<ts>` id and promote to the real id
   *  when the first rollout event arrives. */
  // Protected rather than private because regression harnesses need to assert
  // lifecycle state through a subclass. That keeps the test breach explicit and
  // typed, instead of forcing `as unknown as` casts at every private access.
  protected liveSemanticTurnId: string | null = null
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

  /** Live-turn ownership.
   *
   *  Records which producer currently owns the authoritative
   *  `this.semantic` channel. Only one owner at a time. Screen is
   *  a legitimate kind here even though screen publishes to
   *  `semanticShadow` — tracking screen ownership explicitly lets
   *  the orchestrator express "proxy/rollout has preempted screen"
   *  as a single `transitionLiveOwner` call instead of scattering
   *  reset side effects across the code.
   *
   *  Owner lifecycle for Codex (all set via the helpers below):
   *
   *  - `screen` claims when TUI activity is detected AND no other
   *    owner exists. Yields to rollout/proxy on `task_started` /
   *    proxy `turn_started`. Released on the idle debounce when
   *    screen is still the owner.
   *  - `rollout` claims on `task_started` / `turn_started` in the
   *    rollout stream. Yields on `task_complete` / `turn_complete`.
   *    Takes priority over screen via `transitionLiveOwner`.
   *  - `proxy` claims when the CodexResponsesAdapter fires a
   *    proxy-sourced `turn_started` on `this.semantic`. Yields on
   *    proxy `turn_completed`. Takes priority over screen; in the
   *    current adapter design, proxy and rollout do not race in
   *    practice (proxy preempts rollout via owner tracking — see
   *    the turn_started listener wired in the constructor). */
  private liveOwner: LiveOwnerState = {
    kind: null,
    turnId: null,
    startedAt: null,
    status: 'idle',
  }

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

    // Proxy / rollout ownership claims on the authoritative channel.
    //
    // Both the CodexResponsesAdapter and `ingestRolloutIntoSemantic`
    // publish directly onto `this.semantic`. We mirror their turn
    // lifecycle into `liveOwner` via a `turn_started` / `turn_completed`
    // listener so the rest of the orchestrator can answer "who owns
    // the live turn right now?" without peering into either producer.
    //
    // WHY a single listener covers both producers:
    //
    //   The listener branches on `ev.source`. Rollout's ingest path
    //   calls `semantic.startTurn({ source: 'rollout', ... })`; the
    //   proxy adapter calls `semantic.startTurn({ source: 'proxy',
    //   ... })`. One listener plus a source switch is simpler than
    //   two wrappers around each producer.
    //
    //   `transitionLiveOwner` is the right call regardless of which
    //   kind we're entering because it handles the "screen was
    //   already live, seal its shadow turn" case uniformly.
    this.semantic.on('turn_started', ev => {
      if (ev.source === 'proxy') {
        this.transitionLiveOwner('proxy', ev.turnId, 'proxy turn_started')
      } else if (ev.source === 'rollout') {
        this.transitionLiveOwner('rollout', ev.turnId, 'rollout turn_started')
      }
    })
    this.semantic.on('turn_completed', ev => {
      if (ev.source !== 'proxy' && ev.source !== 'rollout') return
      if (
        this.liveOwner.kind === ev.source &&
        this.liveOwner.turnId === ev.turnId
      ) {
        this.clearLiveOwner(`${ev.source} turn_completed`)
      }
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

          // Screen-fallback `stream_phase` → `thinking`. Proxy-sourced
          // phase is strictly higher-confidence (it can distinguish
          // `responding` / `tool-input` / `thinking` per item kind);
          // the Codex TUI Working row is the same regardless of
          // sub-phase, so `thinking` is the conservative bucket. Gate
          // on `liveOwner.kind !== 'proxy'`: if the proxy owns the
          // live turn it has already set a finer-grained phase via
          // CodexResponsesAdapter and we must not clobber it. The
          // shadow channel always gets the event so debug tooling
          // can see screen-derived phase regardless.
          if (this.liveOwner.kind !== 'proxy') {
            this.semantic.publishStreamPhase({
              turnId: this.liveSemanticTurnId,
              phase: 'thinking',
              source: 'screen',
              confidence: 'fallback',
            })
          }
          this.semanticShadow.publishStreamPhase({
            turnId: this.liveSemanticTurnId,
            phase: 'thinking',
            source: 'screen',
            confidence: 'fallback',
          })

          // Screen-fallback live turn — opens on the SHADOW channel
          // and claims `screen` ownership so rollout/proxy see the
          // slot as occupied until they explicitly preempt via
          // `transitionLiveOwner`.
          //
          // Why we also check `liveOwner.kind === null` on top of
          // `!this.liveSemanticTurnId`: owner state is the real
          // source of truth for live-turn authority. If rollout or
          // proxy claimed ownership first via their own listener,
          // the owner will be non-null even before we got a chance
          // to touch `liveSemanticTurnId` — and screen must yield.
          //
          // The pre-2026-04-18 check against `semantic.getActiveTurnId()`
          // is no longer the right gate because screen now publishes
          // on `semanticShadow`, so the real channel's active-turn
          // state only reflects proxy/rollout. Using `liveOwner`
          // instead generalises the check correctly across all three
          // producers.
          if (!this.liveSemanticTurnId && this.liveOwner.kind === null) {
            const candidateTurnId = `live-${Date.now()}`
            const decision = this.claimLiveOwner(
              'screen',
              candidateTurnId,
              'screen activity detected',
            )
            if (decision.accept) {
              this.liveSemanticTurnId = candidateTurnId
              this.semanticSource = 'screen'
              this.lastScreenSemanticText = ''
              this.screenBaselineText =
                extractCodexAssistantInProgress(snap.recent) || ''
              this.screenBaselineSatisfied = false
              this.semanticShadow.startTurn({
                turnId: candidateTurnId,
                role: 'assistant',
                source: 'screen',
                confidence: 'fallback',
              })
            }
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

            // Screen-fallback `stream_phase` → `idle`. Same gate as
            // the active→true branch above: only hit the authoritative
            // channel when we aren't the proxy-owned turn (proxy's
            // response.completed already drove the phase terminal).
            if (this.liveOwner.kind !== 'proxy') {
              this.semantic.publishStreamPhase({
                turnId: null,
                phase: 'idle',
                source: 'screen',
                confidence: 'fallback',
              })
            }
            this.semanticShadow.publishStreamPhase({
              turnId: null,
              phase: 'idle',
              source: 'screen',
              confidence: 'fallback',
            })

            // Close any screen-fallback turn on the shadow channel
            // and release screen ownership. Rollout- / proxy-sourced
            // turns are finalized by their own lifecycle on the real
            // channel (and their listener above clears ownership for
            // us); the idle debounce must not race those paths.
            if (this.liveOwner.kind === 'screen') {
              this.finalizeScreenFallbackTurn('screen idle debounce')
              this.clearLiveOwner('screen idle debounce')
            }
          }, 2500)
        }
      }

      // Screen-sourced semantic fallback — SHADOW channel only.
      //
      // Screen publishes to `semanticShadow` so it cannot race proxy
      // or rollout for the renderer-facing `semantic` channel. The
      // pre-2026-04-18 defensive hand-off logic (releasing our own
      // live turn when `semantic.getActiveTurnId()` diverged) is no
      // longer needed because the preemption is now explicit: the
      // rollout/proxy listeners in the constructor call
      // `transitionLiveOwner` which finalises the screen fallback
      // on the shadow channel for us.
      //
      // The only guard we still need is "am I still the screen
      // owner?" If ownership has moved to rollout or proxy since
      // the last snapshot, the screen path stops publishing even
      // before the transition's finalizer runs this tick.
      if (
        this.liveSemanticTurnId &&
        this.liveOwner.kind === 'screen' &&
        this.semanticSource === 'screen'
      ) {
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
          this.semanticShadow.applyDelta({
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
      this.trustDialogState = trust
      const approval = detectCodexApproval(snap.plain)
      const approvalKey = approval ? JSON.stringify(approval) : null
      this.approvalState = approval

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

      if (approvalKey !== this.lastApprovalKey) {
        this.lastApprovalKey = approvalKey
        this.emit('approval', approval)
        this.screen.publishApproval({
          visible: approval !== null,
          state: approval,
        })
      }

      this.publishConditionSnapshot()
    })

    this.terminal.on('exit', ({ exitCode, signal }) => {
      this.emit('exit', { exitCode, signal })
      this.emit('event', { type: 'exit', ts: Date.now(), exitCode, signal })
      void this.cleanup()
    })
  }

  // --- Live-turn ownership helpers --------------------------------------
  //
  // Mirror of the Claude-side helpers. See ClaudeCodeHeadless for the
  // full rationale — same design, same rules. Codex's key difference
  // is that `rollout` is a first-class live owner alongside `proxy`,
  // so transitions happen both ways: screen→rollout, screen→proxy,
  // and (rarely, when proxy takes over mid-stream) rollout→proxy.

  private canSourceMutateLiveTurn(
    kind: LiveOwnerKind,
    turnId: string | null,
  ): boolean {
    if (this.liveOwner.kind === null) return true
    if (this.liveOwner.kind !== kind) return false
    if (turnId && this.liveOwner.turnId && turnId !== this.liveOwner.turnId) {
      return false
    }
    return true
  }

  private claimLiveOwner(
    kind: LiveOwnerKind,
    turnId: string,
    reason: string,
  ): LiveOwnerDecision {
    const prev = this.liveOwner
    const now = Date.now()
    if (prev.kind === kind && prev.turnId === turnId) {
      return {
        accept: true,
        action: 'start',
        kind,
        turnId,
        reason: `re-claim: ${reason}`,
        prev,
        next: prev,
        ts: now,
      }
    }
    if (prev.kind !== null && prev.kind !== kind) {
      const decision: LiveOwnerDecision = {
        accept: false,
        action: 'drop',
        kind,
        turnId,
        reason: `owner=${prev.kind} turnId=${prev.turnId} — ${reason}`,
        prev,
        next: prev,
        ts: now,
      }
      this.emit('live-owner-change', decision)
      return decision
    }
    const next: LiveOwnerState = {
      kind,
      turnId,
      startedAt: now,
      status: 'live',
    }
    this.liveOwner = next
    const decision: LiveOwnerDecision = {
      accept: true,
      action: 'start',
      kind,
      turnId,
      reason,
      prev,
      next,
      ts: now,
    }
    this.emit('live-owner-change', decision)
    return decision
  }

  private clearLiveOwner(reason: string): void {
    const prev = this.liveOwner
    if (prev.kind === null) return
    const next: LiveOwnerState = {
      kind: null,
      turnId: null,
      startedAt: null,
      status: 'idle',
    }
    this.liveOwner = next
    this.emit('live-owner-change', {
      accept: true,
      action: 'clear',
      kind: prev.kind,
      turnId: prev.turnId ?? '',
      reason,
      prev,
      next,
      ts: Date.now(),
    })
  }

  /** Promote from one owner to another. The outgoing owner's
   *  bookkeeping is closed out first — for screen we explicitly seal
   *  the shadow turn so shadow subscribers see a clean close. Rollout
   *  and proxy finalize their own lifecycle on the real channel
   *  through their normal publishers, so we don't force a finish
   *  here for those owners. */
  private transitionLiveOwner(
    nextKind: LiveOwnerKind,
    nextTurnId: string,
    reason: string,
  ): LiveOwnerDecision {
    const prev = this.liveOwner
    if (prev.kind === null) {
      return this.claimLiveOwner(nextKind, nextTurnId, reason)
    }
    if (prev.kind === nextKind && prev.turnId === nextTurnId) {
      return {
        accept: true,
        action: 'start',
        kind: nextKind,
        turnId: nextTurnId,
        reason: `no-op transition: ${reason}`,
        prev,
        next: prev,
        ts: Date.now(),
      }
    }
    if (prev.kind === 'screen') {
      this.finalizeScreenFallbackTurn('preempted by ' + nextKind)
    }
    const next: LiveOwnerState = {
      kind: nextKind,
      turnId: nextTurnId,
      startedAt: Date.now(),
      status: 'live',
    }
    this.liveOwner = next
    const decision: LiveOwnerDecision = {
      accept: true,
      action: 'promote',
      kind: nextKind,
      turnId: nextTurnId,
      reason: `${prev.kind} → ${nextKind}: ${reason}`,
      prev,
      next,
      ts: Date.now(),
    }
    this.emit('live-owner-change', decision)
    return decision
  }

  /** Close out the screen-fallback turn on the shadow channel and
   *  reset screen-specific state. Kept as a helper so every "screen
   *  turn is over" path (idle debounce, rollout preempt, proxy
   *  preempt) resets the same fields in the same order. Idempotent. */
  private finalizeScreenFallbackTurn(reason: string): void {
    if (this.liveSemanticTurnId && this.semanticSource === 'screen') {
      this.semanticShadow.finishTurn({
        turnId: this.liveSemanticTurnId,
        fullText: this.lastScreenSemanticText || undefined,
        source: 'screen',
        confidence: 'fallback',
      })
    }
    // Screen-specific fields only; rollout fields are reset by
    // `resetLiveTurn` on task_complete.
    if (this.semanticSource === 'screen') {
      this.liveSemanticTurnId = null
      this.semanticSource = null
      this.lastScreenSemanticText = ''
      this.screenBaselineText = ''
      this.screenBaselineSatisfied = false
    }
    void reason
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
        this.stopRolloutTail = await this.tailResumeRolloutFile(
          sessionsDir,
          rolloutPath,
        )
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
    this.recordSubmittedPromptFromWrite(data)
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

  private recordSubmittedPromptFromWrite(data: string): void {
    const prompt = extractSubmittedPromptFromWrite(data)
    if (prompt === null) return
    this.recordSubmittedPrompt(prompt)
  }

  private recordSubmittedPrompt(text: string): void {
    const normalized = normalizePromptForOwnership(text)
    if (!normalized) return
    this.submittedPrompts.push({ text, normalized, ts: Date.now() })
    if (this.submittedPrompts.length > 20) {
      this.submittedPrompts.splice(0, this.submittedPrompts.length - 20)
    }
    this.reconsiderFreshRolloutCandidates()
  }

  private reconsiderFreshRolloutCandidates(): void {
    if (this.activeRolloutPath) return
    this.freshRolloutClaimTask = this.freshRolloutClaimTask
      .then(() => this.evaluateFreshRolloutCandidates())
      .catch(err => {
        this.emit(
          'rollout-error',
          err instanceof Error ? err : new Error(String(err)),
        )
      })
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

  getApprovalState(): ScreenApproval | null {
    return this.approvalState
  }

  getConditionSnapshot(): CodexConditionSnapshot {
    return this.conditionSnapshot
  }

  private publishConditionSnapshot(): void {
    // Assemble the snapshot through the generic evaluator over the two live
    // condition sources (trust dialog) plus the two-source approval merge
    // (screen `approvalState` + rollout `approvalMetadata`). The cast narrows the
    // evaluator's generic snapshot to the Codex-typed one; the runtime value is
    // identical (only the `conditions` map's static type is narrowed).
    const snap = this.conditionEvaluator.evaluate({
      trustDialog: this.trustDialogState,
      approval: this.approvalState,
      approvalMetadata: this.approvalMetadata,
    }) as CodexConditionSnapshot
    // ALWAYS update the public snapshot, even when unchanged — `getConditionSnapshot`
    // must reflect the latest `ts`. This matches the old behavior (it assigned
    // `this.conditionSnapshot` before the dedupe early-return).
    this.conditionSnapshot = snap
    // Dedupe on the evaluator's latch (keyOf == the old codexConditionSnapshotKey:
    // JSON.stringify of the conditions map, ts excluded, insertion order
    // preserved). `changed` returns false and short-circuits when the conditions
    // are byte-identical to the last emission, exactly as the old
    // `conditionsKey === this.lastConditionKey` guard did.
    if (!this.conditionEvaluator.changed(this.conditionEvaluator.keyOf(snap)))
      return
    this.emit('conditions', snap)
    this.emit('event', {
      type: 'conditions',
      ts: snap.ts,
      snapshot: snap,
    })
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
    this.activeRolloutPath = filePath
    this.tailedRolloutPaths.add(filePath)
    return tailSessionFile<CodexRolloutLine>(
      filePath,
      (entry) => {
        const line = entry
        // Capture session meta from the first entry that has it.
        if (isCodexSessionMeta(line) && !this.sessionMeta) {
          this.sessionMeta = line.payload
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

  private async evaluateFreshRolloutCandidates(changedPath?: string): Promise<void> {
    if (this.activeRolloutPath) return
    const decision = decideFreshRolloutClaim({
      ownCwd: this.cwd,
      prompts: this.submittedPrompts,
      candidates: this.freshRolloutCandidates.values(),
      normalizeCwd,
    })

    if (decision.type === 'accept') {
      // This is the only fresh-session path that may call tailFile().
      // Cwd is only a gate; prompt ownership is the proof. Failing
      // closed here is intentional: a delayed committed transcript is
      // annoying but recoverable, while tailing the wrong rollout
      // poisons `providerSessionId` and makes the renderer believe a
      // sibling conversation belongs to this pane.
      this.freshRolloutStopTail = this.tailFile(decision.filePath)
      return
    }

    if (decision.type === 'ambiguous') {
      this.emit(
        'rollout-error',
        new Error(
          `Codex fresh rollout ownership ambiguous; refusing to attach by recency. ` +
            `Candidates: ${decision.filePaths.join(', ')}`,
        ),
      )
      return
    }

    if (decision.type === 'reject' && changedPath) {
      this.emit(
        'rollout-error',
        new Error(
          `Codex fresh rollout ${changedPath} rejected: ${decision.reason}`,
        ),
      )
    }
  }

  /**
   * Resume tailing is deliberately wider than "tail the file whose
   * filename contains the provider session id".
   *
   * WHY: Codex resume is not stable about file ownership. In the
   * healthy case it appends to the original rollout file, so the
   * `findRolloutByThreadId -> tailFile(existing)` path is correct.
   * In the failure captured by Agent Code issue #159, the lookup hit
   * an old rollout, bootstrap emitted the previous 53 entries, and
   * Codex then wrote the resumed conversation somewhere else. The
   * renderer still had live proxy semantics, but the committed
   * transcript channel was dead forever because this class was pinned
   * to the stale file.
   *
   * We therefore keep the existing tail and, for a bounded window,
   * watch for a NEW rollout whose early metadata says it belongs to
   * the same cwd. When such a fork appears we switch tails. We do not
   * watch forever: after the initial resume decision, long-lived
   * same-cwd rollouts are much more likely to be unrelated sibling
   * agents than late resume forks. The window is intentionally long
   * enough to cover Codex startup/auth/model latency, but finite so a
   * parent orchestration session does not keep stealing child files
   * later in the day.
   *
   * This is still not a perfect identity proof. Codex does not expose
   * a parent/resume id in every forked file, and Agent Code can spawn
   * multiple Codex sessions in the same cwd. The stronger long-term
   * fix is for Codex to write a stable resume lineage id into
   * `session_meta` or for Agent Code to get the provider session id
   * over an explicit API. Until then, "new after resume + same cwd +
   * bounded watch + switch once" is the narrowest practical repair
   * for the permanent committed-channel outage.
   */
  private async tailResumeRolloutFile(
    sessionsDir: string,
    initialPath: string,
  ): Promise<() => Promise<void>> {
    await mkdir(sessionsDir, { recursive: true })

    // Fingerprint the resumed file's existing conversation so the
    // fork watcher can tell a genuine reconstruction of THIS session
    // apart from an unrelated sibling agent that merely shares the
    // cwd. See isResumeForkCandidate / readRolloutLineageIds.
    const lineageIds = await this.readRolloutLineageIds(initialPath)

    let stopped = false
    let currentStop: (() => Promise<void>) | null = this.tailFile(initialPath)
    let watcherStop: (() => Promise<void>) | null = null
    const watchStartedAt = Date.now()

    const switchTo = async (filePath: string): Promise<void> => {
      if (stopped) return
      if (this.activeRolloutPath === filePath) return
      if (this.tailedRolloutPaths.has(filePath)) return
      // Open the new tail BEFORE closing the stale one: a gap would
      // drop any entry written in between. The brief overlap is safe
      // — a forked rollout begins with this session's copied history,
      // so the new tail's bootstrap re-emits entries the stale tail
      // already emitted, and downstream ingest dedupes by the
      // deterministic per-entry uuid (`<timestamp>:<id>`). Closing
      // first to avoid the overlap would trade a harmless duplicate
      // (deduped) for a real lost-entry window.
      const previous = currentStop
      currentStop = this.tailFile(filePath)
      // A successful tail switch is NOT an error. It used to emit
      // `rollout-error`, which the Agent Code parent surfaces as a
      // transcript failure ("transcript unavailable: …") even though
      // the resume recovered correctly. Switching the committed tail
      // to the forked rollout is the intended behaviour of this
      // watcher, so it must not poison the error channel. A dedicated
      // non-error diagnostic event is tracked separately in #11; until
      // then this switch is observable through the `rollout-entry`
      // stream that immediately resumes from the new file.
      if (previous) {
        try { await previous() } catch { /* best-effort stale tail close */ }
      }
      if (watcherStop) {
        try { await watcherStop() } catch { /* best-effort watcher close */ }
        watcherStop = null
      }
    }

    watcherStop = await this.watchResumeForkRollout(sessionsDir, {
      startedAt: watchStartedAt,
      initialPath,
      lineageIds,
      onCandidate: switchTo,
    })

    const timeout = setTimeout(() => {
      if (!watcherStop) return
      const stop = watcherStop
      watcherStop = null
      void stop()
    }, CodexHeadless.RESUME_FORK_WATCH_MS)

    return async () => {
      stopped = true
      clearTimeout(timeout)
      const stops = [watcherStop, currentStop]
      watcherStop = null
      currentStop = null
      for (const stop of stops) {
        if (!stop) continue
        try { await stop() } catch { /* best-effort */ }
      }
    }
  }

  private async watchResumeForkRollout(
    sessionsDir: string,
    options: {
      startedAt: number
      initialPath: string
      lineageIds: ReadonlySet<string>
      onCandidate: (filePath: string) => Promise<void>
    },
  ): Promise<() => Promise<void>> {
    let evaluating = false
    let closed = false
    const pending = new Set<string>()
    // A single watcher with ignoreInitial:false. Every rollout file —
    // those already on disk at attach time AND those created later —
    // is fed through isResumeForkCandidate, whose mtime guard rejects
    // anything older than the resume attach.
    //
    // The earlier two-phase design (prime an `existing` set, then
    // watch only for files NOT in it) had a real hole: a reconstructed
    // fork created during the priming scan was recorded as
    // pre-existing and then skipped forever — the exact committed-
    // channel outage this watcher exists to catch. Letting the mtime
    // guard, not watcher ordering, decide freshness closes that
    // window. ignoreInitial:false replays the on-disk tree once; old
    // files are rejected cheaply by the stat-only mtime guard before
    // any file read.
    const watcher = watch(sessionsDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 4,
    })

    const drain = async (): Promise<void> => {
      if (evaluating || closed) return
      evaluating = true
      try {
        for (;;) {
          const next = pending.values().next().value as string | undefined
          if (!next || closed) break
          pending.delete(next)
          if (await this.isResumeForkCandidate(next, options)) {
            await options.onCandidate(next)
            break
          }
        }
      } finally {
        evaluating = false
      }
    }

    watcher.on('add', (filePath: string) => {
      if (closed) return
      const name = filePath.split('/').pop() ?? ''
      if (!CODEX_ROLLOUT_RE.test(name)) return
      if (filePath === options.initialPath) return
      if (this.tailedRolloutPaths.has(filePath)) return
      pending.add(filePath)
      void drain()
    })
    watcher.on('error', (err: unknown) => this.emit('rollout-error', err instanceof Error ? err : new Error(String(err))))

    return async () => {
      closed = true
      pending.clear()
      await watcher.close()
    }
  }

  private async isResumeForkCandidate(
    filePath: string,
    options: {
      startedAt: number
      initialPath: string
      lineageIds: ReadonlySet<string>
    },
  ): Promise<boolean> {
    if (filePath === options.initialPath) return false
    if (this.tailedRolloutPaths.has(filePath)) return false
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(filePath)
    } catch {
      return false
    }
    if (!st.isFile()) return false
    // New-file events can be delivered a little late, but they
    // should not point at a rollout that predates the resume attach.
    // That guard is what keeps a resumed parent from adopting some
    // old same-cwd transcript just because chokidar replayed an add.
    if (st.mtimeMs < options.startedAt - 5000) return false

    let text: string
    try {
      const raw = await readFile(filePath)
      text = raw.subarray(0, CodexHeadless.ROLLOUT_CANDIDATE_READ_BYTES).toString('utf8')
    } catch {
      return false
    }

    // Two independent signals decide whether this new same-period rollout is
    // a fork of THE SESSION WE RESUMED, vs an unrelated Codex agent that
    // merely runs in the same directory. The helper deliberately classifies
    // rejected same-cwd siblings as diagnostics, not fatal rollout errors:
    // orchestration creates exactly those siblings, and poisoning the error
    // channel makes the renderer hide an otherwise healthy transcript.
    const decision = decideResumeForkCandidate({
      ownCwd: this.cwd,
      candidateText: text,
      initialPath: options.initialPath,
      candidatePath: filePath,
      lineageIds: options.lineageIds,
      requiredOverlapLimit: CodexHeadless.RESUME_LINEAGE_MIN_OVERLAP,
      normalizeCwd,
    })

    if (decision.type === 'accept') return true
    if (decision.message && decision.reason !== 'cwd-mismatch') {
      this.emit('rollout-diagnostic', {
        type: 'resume-fork-ignored',
        ts: Date.now(),
        message: decision.message,
        candidatePath: filePath,
        initialPath: options.initialPath,
        reason: decision.reason,
        lineageOverlap: decision.lineageOverlap,
        requiredOverlap: decision.requiredOverlap,
      })
    }
    return false
  }

  /**
   * Fingerprint a rollout file's existing conversation as the set of
   * opaque item ids it contains. Used by isResumeForkCandidate to
   * recognise a reconstructed fork of the resumed session — a fork
   * copies these ids, an unrelated session does not. Best-effort:
   * a read failure yields an empty set, which downgrades the fork
   * check to cwd-only rather than breaking resume.
   */
  private async readRolloutLineageIds(filePath: string): Promise<Set<string>> {
    const ids = new Set<string>()
    try {
      const text = await readFile(filePath, 'utf8')
      collectRolloutLineageIds(text, ids, 8000)
    } catch {
      /* best-effort — empty set falls back to cwd-only matching */
    }
    return ids
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
  // See `liveSemanticTurnId` above: tests drive this reducer directly through a
  // subclass so they can verify rollout edge cases without spawning Codex or
  // waiting on a filesystem tailer.
  protected ingestRolloutIntoSemantic(line: CodexRolloutLine): void {
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
          // Promote or open the live turn on the AUTHORITATIVE
          // channel with the real rollout id.
          //
          // Ordering matters here. `startTurn` fires `turn_started`
          // synchronously, which trips the `turn_started` listener
          // wired up in the constructor; that listener calls
          // `transitionLiveOwner('rollout', ...)`. The transition
          // helper finalises any open screen-fallback turn on the
          // SHADOW channel (so screen subscribers see a clean close)
          // and clears screen-specific local fields. Only after the
          // listener returns do we overwrite the local fields with
          // the rollout-side bookkeeping we actually want to keep
          // (`liveSemanticTurnId` / `semanticSource` / etc).
          //
          // The pre-2026-04-18 explicit `semantic.finishTurn({source:
          // 'screen'})` call was removed because screen no longer
          // publishes on `this.semantic` — it lives on
          // `semanticShadow`. Calling finishTurn on the real channel
          // with the screen turnId would now trip the strict
          // `lifecycle_violation` path and be dropped.
          this.semantic.startTurn({
            turnId: e.turn_id,
            role: 'assistant',
            source: 'rollout',
            confidence: 'high',
          })
          this.liveSemanticTurnId = e.turn_id
          this.semanticSource = 'rollout'
          this.rolloutAssistantText = ''
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

        case 'turn_aborted': {
          const e = evt as CodexTurnAbortedEvent
          if (!this.liveSemanticTurnId || e.turn_id !== this.liveSemanticTurnId) return
          // Codex can commit a final assistant message and then abort the
          // rollout turn without ever emitting task_complete/turn_complete.
          // If we leave the semantic turn open, Feed renders both the
          // committed assistant entry and the still-mounted semantic row.
          // Treat the abort as a terminal turn boundary.
          this.semantic.publishTurnStopped({
            turnId: e.turn_id,
            stopReason: typeof e.reason === 'string' ? e.reason : 'interrupted',
            source: 'rollout',
            confidence: 'high',
          })
          this.semantic.finishTurn({
            turnId: e.turn_id,
            fullText: this.rolloutAssistantText || undefined,
            source: 'rollout',
            confidence: 'high',
          })
          this.resetLiveTurn()
          return
        }

        case 'exec_approval_request': {
          const e = evt as CodexExecApprovalRequestEvent
          this.approvalMetadata = {
            callId: e.call_id ?? null,
            commandParts: e.command ?? [],
            workdir: e.workdir ?? null,
          }
          this.publishConditionSnapshot()
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
          if (
            !e.call_id ||
            this.approvalMetadata?.callId === null ||
            this.approvalMetadata?.callId === e.call_id
          ) {
            this.approvalMetadata = null
            this.publishConditionSnapshot()
          }
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
      const item = line.payload
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
        isCodexMessageItem(item) &&
        item.role === 'assistant'
      ) {
        const text = extractCodexMessageText(item)
        if (!text) return
        if (this.liveSemanticTurnId) {
          // Catch-up snapshot: if the streaming buffer disagrees with
          // the committed text, publish the committed form so any live
          // subscriber that skipped deltas sees the final content
          // before we clear. When they match (the normal live path)
          // the semantic channel itself no-ops on the repeat, so this
          // is cheap.
          if (text !== this.rolloutAssistantText) {
            this.semantic.applyDelta({
              turnId: this.liveSemanticTurnId,
              fullText: text,
              source: 'rollout',
              confidence: 'medium',
            })
          }
          // WHY we always clear the streaming buffer after a
          // response_item commits:
          //
          // `currentTurn.text` means "assistant text streamed into the
          // current turn that has NOT yet landed as a committed JSONL
          // entry." Once a `response_item` of role=assistant lands, the
          // feed's committed `:message` row owns display of that text.
          // Leaving the same text in `currentTurn.text` causes
          // SemanticStreamingTurn's no-blocks fallback (Codex has no
          // per-block events) to paint it a second time below the
          // committed row — the duplicate-response bug we kept seeing
          // in Codex agentic turns that emit many assistant messages
          // before the turn seals.
          //
          // Clearing via applyDelta(fullText='') flows through the
          // reducer's turn_delta branch and snaps
          // `currentTurn.text` back to ''. Feed's fallback checks
          // `turn.text` before painting, so the ghost collapses to
          // nothing until the next message's deltas start populating
          // the buffer again.
          //
          // The earlier `shouldSuppressSemanticTurnForCommittedTail`
          // guard in Feed.tsx tried to detect this in the renderer via
          // text equality. Fixing it here keeps provider-specific
          // commit semantics inside the provider adapter — the
          // renderer does not need to know about Codex's
          // many-messages-per-turn shape.
          this.rolloutAssistantText = ''
          this.semantic.applyDelta({
            turnId: this.liveSemanticTurnId,
            fullText: '',
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
   * Snapshots existing files first, then watches for adds/changes.
   *
   * WHY this does NOT tail the first new file anymore:
   *
   * Codex stores every rollout under one global date tree. There is no
   * per-PTY directory boundary like Claude has, and fresh sessions do
   * not yet have a provider id we can exact-match. The prior
   * "first new rollout wins" rule therefore encoded timing as
   * identity. That is tolerable only when launches are serialized; it
   * cross-wires orchestration children that start together in the same
   * cwd. We now hold candidates until their early JSONL proves the
   * file belongs to a prompt submitted through this headless instance.
   * If multiple files prove equally well, we keep holding rather than
   * choosing by recency.
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

    let stopped = false

    const tryClaim = async (filePath: string): Promise<void> => {
      if (stopped) return
      if (this.activeRolloutPath) return
      if (this.tailedRolloutPaths.has(filePath)) return
      const name = filePath.split('/').pop() ?? ''
      if (!CODEX_ROLLOUT_RE.test(name)) return
      if (existing.has(filePath)) return
      let text: string
      try {
        const raw = await readFile(filePath)
        text = raw
          .subarray(0, CodexHeadless.ROLLOUT_CANDIDATE_READ_BYTES)
          .toString('utf8')
      } catch {
        return
      }
      const candidate = parseFreshRolloutCandidate(filePath, text)
      if (!candidate) return
      this.freshRolloutCandidates.set(filePath, candidate)
      await this.evaluateFreshRolloutCandidates(candidate.filePath)
    }

    const enqueueClaim = (filePath: string): void => {
      this.freshRolloutClaimTask = this.freshRolloutClaimTask
        .then(() => tryClaim(filePath))
        .catch(err => {
          this.emit(
            'rollout-error',
            err instanceof Error ? err : new Error(String(err)),
          )
        })
    }

    const watcher = watch(sessionsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 4,
    })
    watcher.on('add', enqueueClaim)
    watcher.on('change', enqueueClaim)
    watcher.on('error', (err: unknown) => this.emit('rollout-error', err instanceof Error ? err : new Error(String(err))))

    return async () => {
      stopped = true
      await watcher.close()
      const stopTail = this.freshRolloutStopTail
      this.freshRolloutStopTail = null
      if (stopTail) await stopTail()
    }
  }

  /**
   * Find a rollout file by thread ID. Walks the date tree backwards
   * (most recent dates first) looking for an exact rollout UUID
   * suffix.
   *
   * WHY not `filename.includes(threadId)`: Codex's session tree is
   * global, so lookup helpers must never degrade into substring
   * matches. The rollout filename already has a structured
   * `rollout-<timestamp>-<uuid>.jsonl` shape; using the parsed UUID
   * keeps resume lookup on the same exact-provider-id rule as the
   * fresh claimant once it finally captures `session_meta.id`.
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
            const match = files.find(f => {
              const parsed = CODEX_ROLLOUT_RE.exec(f)
              return parsed?.[2] === threadId
            })
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
