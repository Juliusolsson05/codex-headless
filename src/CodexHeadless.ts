import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { IPty } from 'node-pty'
import { mkdir } from 'fs/promises'

import {
  HeadlessTerminal,
  type ScreenSnapshot,
} from './terminal/HeadlessTerminal.js'
import { tailSessionFile } from './transcript/JsonlTailer.js'
import {
  assertIssuedCodexPromptInputProfile,
  type CodexPromptInputProfile,
} from './transcript/prompt-input/CodexPromptInputProfile.js'
import { PromptInputEvidence } from './transcript/prompt-input/PromptInputEvidence.js'
import type {
  FreshRolloutLease,
  FreshRolloutParticipantDecision,
  FreshRolloutParticipantHandle,
  ResumeRolloutParticipantDecision,
  ResumeRolloutParticipantHandle,
} from './transcript/FreshRolloutOwnershipCoordinator.js'
import {
  acquireFreshRolloutCoordinator,
  beginFreshRolloutCoordinatorAcquisition,
  type FreshRolloutCoordinatorAcquisition,
} from './transcript/FreshRolloutOwnershipCoordinatorRegistry.js'
import type {
  CodexResumeRolloutPreparation,
} from './transcript/CodexResumeRolloutPreparation.js'
import { normalizeRolloutOwnershipPath } from './transcript/OwnershipNormalization.js'
import { collectRolloutLineageIds } from './transcript/ResumeForkCandidate.js'
import {
  findCodexRolloutByThreadId,
  readCodexRolloutGeneration,
} from './transcript/RolloutLocator.js'
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

const RESUME_LINEAGE_MIN_OVERLAP = 3
const RESUME_LINEAGE_ID_CAP = 8000
const issuedResumeRolloutPreparations = new WeakSet<object>()
const internalResumeRolloutPreparations = new WeakMap<
  object,
  CodexResumeRolloutPreparationState
>()

type ResumePreparationHandlers = {
  onLease: (lease: FreshRolloutLease) => void
  onDecision: (decision: ResumeRolloutParticipantDecision) => void
}

/**
 * Runtime-private ownership controller shared only by the public preparation
 * factory and its sole CodexHeadless consumer in this module closure.
 *
 * WHY this lives beside CodexHeadless instead of in the public preparation
 * module: TypeScript visibility and a package root export map do not protect an
 * emitted deep file. The tenth exact-head gate imported the former unwrapper
 * directly, recovered raw path/root/owner state, and invoked lease retirement.
 * Co-locating issuance and consumption leaves no exported bridge from the
 * dispose-only handle to this controller while preserving pre-spawn rollback.
 */
class CodexResumeRolloutPreparationState {
  #ownerId: string | null = randomUUID()
  #sessionsDir: string | null
  #initialPath: string | null
  #initialGenerationId: string | null
  #resumeThreadId: string | null
  #cwd: string | null
  #acquisition: FreshRolloutCoordinatorAcquisition | null
  #resumeParticipant: ResumeRolloutParticipantHandle | null = null
  #handlers: ResumePreparationHandlers | null = null
  #pendingLeases: FreshRolloutLease[] = []
  #pendingDecisions: ResumeRolloutParticipantDecision[] = []
  #watcherReleasePromise: Promise<void> | null = null
  #consumed = false
  #disposed = false

  constructor(options: {
    sessionsDir: string
    initialPath: string | null
    initialGenerationId: string | null
    resumeThreadId: string
    cwd: string
    acquisition: FreshRolloutCoordinatorAcquisition | null
  }) {
    this.#sessionsDir = options.sessionsDir
    this.#initialPath = options.initialPath
    this.#initialGenerationId = options.initialGenerationId
    this.#resumeThreadId = options.resumeThreadId
    this.#cwd = options.cwd
    this.#acquisition = options.acquisition
    // WHY native fields and a frozen controller are defense in depth even
    // though no export can return this instance. Future internal diagnostics
    // must not accidentally make raw ownership state enumerable.
    Object.freeze(this)
  }

  get ownerId(): string {
    this.#assertUsable()
    return this.#ownerId!
  }

  get sessionsDir(): string {
    this.#assertUsable()
    return this.#sessionsDir!
  }

  get initialPath(): string | null {
    this.#assertUsable()
    return this.#initialPath
  }

  get initialGenerationId(): string | null {
    this.#assertUsable()
    return this.#initialGenerationId
  }

  registerLineage(lineageIds: ReadonlySet<string>): void {
    this.#assertUsable()
    if (!this.#acquisition || !this.#initialPath || !this.#ownerId || !this.#cwd) {
      return
    }
    this.#resumeParticipant = this.#acquisition.coordinator.registerResumeParticipant({
      participantId: this.#ownerId,
      cwd: this.#cwd,
      lineageIds,
      requiredOverlapLimit: RESUME_LINEAGE_MIN_OVERLAP,
      // WHY a valid new Y may arrive after provider spawn but before start()
      // opens exact X. Buffering preserves that callback without allowing the
      // parent to observe or mutate the lease.
      onLease: lease => {
        if (this.#handlers) this.#handlers.onLease(lease)
        else this.#pendingLeases.push(lease)
      },
      onDecision: decision => {
        if (this.#handlers) this.#handlers.onDecision(decision)
        else this.#pendingDecisions.push(decision)
      },
    })
  }

  consume(options: {
    resumeThreadId: string
    cwd: string
    handlers: ResumePreparationHandlers
  }): void {
    if (this.#consumed) {
      throw new Error('Codex resume rollout preparation was already consumed')
    }
    if (this.#disposed) {
      throw new Error('Codex resume rollout preparation was disposed')
    }
    if (options.resumeThreadId !== this.#resumeThreadId ||
      normalizeRolloutOwnershipPath(options.cwd) !==
        normalizeRolloutOwnershipPath(this.#cwd ?? '')) {
      throw new Error('Codex resume rollout preparation does not match this session')
    }
    this.#consumed = true
    this.#handlers = options.handlers
    for (const decision of this.#pendingDecisions.splice(0)) {
      try {
        options.handlers.onDecision(decision)
      } catch {
        // WHY diagnostics are observational. A destroyed renderer listener
        // cannot be allowed to revoke a valid exact reservation during replay.
      }
    }
    for (const lease of this.#pendingLeases.splice(0)) {
      options.handlers.onLease(lease)
    }
  }

  unregisterResumeParticipant(): void {
    this.#resumeParticipant?.unregister()
    this.#resumeParticipant = null
  }

  retirePathLease(filePath: string, clean: boolean): void {
    if (!this.#ownerId) return
    this.#acquisition?.coordinator.retirePathLease(
      this.#ownerId,
      filePath,
      clean,
    )
  }

  retireOwnerLeases(clean: boolean): void {
    if (!this.#ownerId) return
    this.#acquisition?.coordinator.retireOwnerLeases(this.#ownerId, clean)
  }

  releaseWatcher(): Promise<void> {
    if (!this.#watcherReleasePromise) {
      const acquisition = this.#acquisition
      this.#watcherReleasePromise = acquisition?.release() ?? Promise.resolve()
    }
    return this.#watcherReleasePromise
  }

  async dispose(clean = true): Promise<void> {
    if (this.#disposed) {
      await this.#watcherReleasePromise
      return
    }
    this.#disposed = true
    this.unregisterResumeParticipant()
    this.retireOwnerLeases(clean)
    try {
      await this.releaseWatcher()
    } finally {
      // WHY disposal is the privacy boundary as well as rollback. The public
      // handle can remain reachable, but no raw path, root, owner, generation,
      // callbacks, or acquisition graph may survive its authority.
      this.#ownerId = null
      this.#sessionsDir = null
      this.#initialPath = null
      this.#initialGenerationId = null
      this.#resumeThreadId = null
      this.#cwd = null
      this.#handlers = null
      this.#pendingLeases = []
      this.#pendingDecisions = []
      this.#resumeParticipant = null
      this.#acquisition = null
      this.#watcherReleasePromise = null
    }
  }

  async disposeBeforeConsumption(clean = true): Promise<void> {
    // WHY the public capability is rollback authority for the parent, not a
    // permanent second stop handle. `consume()` transfers exact-path custody to
    // the active tail synchronously after that tail opens. A retained parent
    // handle may still be cleaned by a late finally block, but after transfer
    // that cleanup must be harmless; only the tail controller knows whether the
    // physical close was clean enough to retire or tombstone the lease.
    if (this.#consumed) return
    await this.dispose(clean)
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error('Codex resume rollout preparation was disposed')
    }
  }
}

const RESUME_ROLLOUT_PREPARATION_HANDLE_PROTOTYPE = Object.create(null) as {
  dispose?: (clean?: boolean) => Promise<void>
}
Object.defineProperty(RESUME_ROLLOUT_PREPARATION_HANDLE_PROTOTYPE, 'dispose', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: function disposeResumeRolloutPreparation(
    this: CodexResumeRolloutPreparation,
    clean = true,
  ): Promise<void> {
    const internal = internalResumeRolloutPreparations.get(this)
    if (!internal || !issuedResumeRolloutPreparations.has(this)) {
      return Promise.reject(new TypeError(
        'Codex resume rollout capability was not created by ' +
          'prepareCodexResumeRollout()',
      ))
    }
    return internal.disposeBeforeConsumption(clean)
  },
})
Object.freeze(RESUME_ROLLOUT_PREPARATION_HANDLE_PROTOTYPE)

function issueCodexResumeRolloutPreparation(
  internal: CodexResumeRolloutPreparationState,
): CodexResumeRolloutPreparation {
  const handle = Object.create(
    RESUME_ROLLOUT_PREPARATION_HANDLE_PROTOTYPE,
  ) as CodexResumeRolloutPreparation
  issuedResumeRolloutPreparations.add(handle)
  internalResumeRolloutPreparations.set(handle, internal)
  return Object.freeze(handle)
}

type CodexResumeRolloutPreparationInternal =
  CodexResumeRolloutPreparationState

function unwrapCodexResumeRolloutPreparation(
  value: CodexResumeRolloutPreparation,
): CodexResumeRolloutPreparationInternal {
  if (typeof value !== 'object' || value === null ||
    !issuedResumeRolloutPreparations.has(value)) {
    throw new TypeError(
      'Codex resume rollout capability was not created by ' +
        'prepareCodexResumeRollout()',
    )
  }
  const internal = internalResumeRolloutPreparations.get(value)
  if (!internal) {
    throw new TypeError('Codex resume rollout capability has no internal state')
  }
  return internal
}

/**
 * Prepare exact and lineage ownership before the consumer spawns Codex.
 *
 * WHY the public factory is exported from this module: its returned handle is
 * intentionally dispose-only, while CodexHeadless needs the hidden controller
 * later. A single module closure is the runtime equivalent of a friend
 * boundary; placing an exported unwrapper in another deep file defeated it.
 */
export async function prepareCodexResumeRollout(options: {
  cwd: string
  resumeThreadId: string
  sessionsDir?: string
  onError?: (error: Error) => void
}): Promise<CodexResumeRolloutPreparation> {
  const sessionsDir = options.sessionsDir ?? getCodexSessionsDir()
  const initialLocation = await findCodexRolloutByThreadId(
    sessionsDir,
    options.resumeThreadId,
  )
  if (!initialLocation) {
    return issueCodexResumeRolloutPreparation(
      new CodexResumeRolloutPreparationState({
        sessionsDir,
        initialPath: null,
        initialGenerationId: null,
        resumeThreadId: options.resumeThreadId,
        cwd: options.cwd,
        acquisition: null,
      }),
    )
  }

  const acquisition = await acquireFreshRolloutCoordinator({
    sessionsRoot: sessionsDir,
    normalizeCwd: normalizeRolloutOwnershipPath,
    normalizePath: normalizeRolloutOwnershipPath,
    onError: options.onError ?? (() => undefined),
  })
  const internal = new CodexResumeRolloutPreparationState({
    sessionsDir,
    initialPath: initialLocation.filePath,
    initialGenerationId: initialLocation.generationId,
    resumeThreadId: options.resumeThreadId,
    cwd: options.cwd,
    acquisition,
  })
  const reserved = acquisition.coordinator.reservePath({
    ownerId: internal.ownerId,
    filePath: initialLocation.filePath,
    kind: 'exact-id',
    proofIdentity: options.resumeThreadId,
  })
  if (!reserved) {
    await internal.dispose(true)
    throw new Error('Codex exact rollout path is already leased by another live session')
  }

  try {
    const text = await readCodexRolloutGeneration(initialLocation)
    const lineageIds = new Set<string>()
    collectRolloutLineageIds(text, lineageIds, RESUME_LINEAGE_ID_CAP)
    internal.registerLineage(lineageIds)
    return issueCodexResumeRolloutPreparation(internal)
  } catch (error) {
    await internal.dispose(true)
    throw error
  }
}

type CodexHeadlessBaseOptions = {
  /** Consumer-owned PTY running the `codex` binary. */
  pty: IPty
  /** Working directory the Codex session is running in. */
  cwd: string
  /** Terminal columns. Default 120. */
  cols?: number
  /** Terminal rows. Default 40. */
  rows?: number
  /** Throttle interval for screen snapshots in ms. Defaults to
   *  HeadlessTerminal's default (100ms — see the WHY on
   *  HeadlessTerminalOptions.snapshotIntervalMs; agent-code#390). */
  snapshotIntervalMs?: number
  /**
   * Package-issued launch/profile capability for prompt ownership evidence.
   * Omission keeps screen/transcript parsing available but disables fresh
   * rollout prompt registration; caller-authored lookalikes are rejected.
   */
  promptInputProfile?: CodexPromptInputProfile
}

export type CodexHeadlessOptions = CodexHeadlessBaseOptions & (
  | {
      resumeThreadId?: undefined
      resumeRolloutPreparation?: never
    }
  | {
      /** Provider thread whose exact rollout must be tailed before any fork. */
      resumeThreadId: string
      /**
       * Ownership capability created before the consumer spawned the resume
       * PTY. Keeping this required closes the otherwise-unavoidable interval
       * in which Codex can reconstruct Y before this process registers X's
       * lineage.
       */
      resumeRolloutPreparation: CodexResumeRolloutPreparation
    }
)

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
export type CodexRolloutDiagnostic =
  | {
      type: 'resume-fork-ignored'
      ts: number
      reason: 'missing-lineage' | 'insufficient-lineage-overlap'
      lineageOverlap: number
      requiredOverlap: number
      candidateFingerprint: string
    }
  | {
      type: 'fresh-rollout-ownership-decision'
      ts: number
      decision: FreshRolloutParticipantDecision['decision']
      reason: FreshRolloutParticipantDecision['reason']
      tailStarted: boolean
      evidence: Omit<
        FreshRolloutParticipantDecision,
        'decision' | 'reason' | 'tailAuthorized'
      >
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

// Preserve the local name at the many comparison sites while keeping the
// normalization rule shared with the pre-spawn resume preparation. Two copies
// that normalize differently would create different process-global registry
// roots and silently restore split-brain ownership.
const normalizeCwd = normalizeRolloutOwnershipPath

export class CodexHeadless extends EventEmitter {
  private static readonly RESUME_BOOTSTRAP_TAIL_LINES = 200
  private static readonly RESUME_FORK_WATCH_MS = 120000
  private readonly terminal: HeadlessTerminal
  private readonly cwd: string
  private readonly resumeThreadId: string | null
  private readonly resumeRolloutPreparation:
    CodexResumeRolloutPreparationInternal | null
  private readonly promptInputEvidence: PromptInputEvidence
  private stopRolloutTail: (() => Promise<void>) | null = null
  private stopPromise: Promise<void> | null = null
  private cleanupPromise: Promise<void> | null = null
  private stopRequested = false
  private startRequested = false
  private activeRolloutPath: string | null = null
  private tailedRolloutPaths = new Set<string>()
  // WHY fresh sessions register with the shared ownership coordinator:
  //
  // A fresh Codex PTY does not expose its provider `ThreadId` to Agent
  // Code until a rollout file eventually writes `session_meta`. The
  // old fallback guessed that the first new global rollout file after
  // spawn belonged to this PTY. That guess is exactly what breaks
  // orchestration: four sibling PTYs in the same cwd can all see the
  // same first JSONL and then permanently capture the sibling's provider id.
  // Prompt bytes remain private to THIS participant, but candidate visibility
  // and path leases must be process-wide so identical sibling prompts are seen
  // as contention before either instance can tail. We deliberately do not
  // assume the first role-user item is real input: Codex 0.147+ writes injected
  // startup context first.
  private freshRolloutParticipant: FreshRolloutParticipantHandle | null = null
  private freshRolloutAcquisition: FreshRolloutCoordinatorAcquisition | null = null
  private freshRolloutStopTail: (() => Promise<void>) | null = null
  private readonly freshRolloutParticipantId: string
  // The proxy repeats the same metadata on every request. Pending ids keep
  // those repetitions from launching overlapping recursive filesystem scans;
  // the proved id is pinned only after locator + lease + generation-bound open
  // all succeed, so a malformed early request cannot poison later real proof.
  private readonly pendingProviderThreadIdentities = new Set<string>()
  private provenProviderThreadIdentity: string | null = null
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
    // WHY validate before allocating HeadlessTerminal for the same reason as
    // resume issuance below: a structural lookalike does not prove the caller
    // launched Codex with the package's frozen highest-precedence input args.
    // Missing proof is allowed only as an explicitly fail-closed observer mode.
    const promptInputProfile = options.promptInputProfile === undefined
      ? null
      : assertIssuedCodexPromptInputProfile(options.promptInputProfile)
    this.promptInputEvidence = new PromptInputEvidence(promptInputProfile)
    // WHY issuer validation is synchronous and precedes HeadlessTerminal: a
    // forged preparation must not allocate terminal listeners/timers and then
    // fail later in start(). Shape checks accept a duck object; instanceof can
    // be forged with Object.create. The preparation module's WeakSet is the
    // runtime authority that the factory performed exact reservation/lineage.
    this.resumeRolloutPreparation = options.resumeThreadId
      ? unwrapCodexResumeRolloutPreparation(options.resumeRolloutPreparation)
      : null
    // WHY resume and fresh ownership share one owner id: exact X, lineage Y,
    // and the missing-X fresh fallback are mutually exclusive claims made by
    // one logical pane. A second id would let the fallback contend with its own
    // pre-spawn reservation when startup changes route.
    this.freshRolloutParticipantId =
      this.resumeRolloutPreparation?.ownerId ?? randomUUID()

    this.terminal = new HeadlessTerminal({
      pty: options.pty,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      // Pass through undefined so HeadlessTerminal owns the default.
      // Keeping a second `?? <n>` here would mean two places must
      // agree for a default change to take effect — exactly the kind
      // of silent shadowing that would undo the 60Hz→10Hz fix
      // (agent-code#390) the next time someone edits only one of them.
      snapshotIntervalMs: options.snapshotIntervalMs,
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
      // WHY exit can race start() while its rollout acquisition is awaiting
      // filesystem readiness. Mark the lifecycle terminal before cleanup so a
      // tail returned afterwards is closed locally instead of being published
      // onto an already-dead headless instance.
      this.stopRequested = true
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
   * Start processing the rollout JSONL file selected by ownership policy.
   *
   * Codex stores rollouts in ~/.codex/sessions/YYYY/MM/DD/ — a
   * global date tree, not per-cwd like Claude. For fresh sessions
   * we watch the tree recursively for a proved rollout. Resume ownership is
   * deliberately prepared before the PTY spawn; start only opens the already
   * reserved exact file and consumes callbacks buffered during that boundary.
   */
  async start(): Promise<{ sessionsDir: string }> {
    this.startRequested = true
    if (this.stopRequested) {
      // WHY a caller may cancel after constructing the headless wrapper but
      // before start() is ever admitted. stop() already disposed the opaque
      // pre-spawn capability in that ordering; this idempotent join prevents a
      // later queued start from trying to consume the released exact lease.
      try { await this.resumeRolloutPreparation?.dispose(true) } catch { /* best-effort */ }
      return { sessionsDir: getCodexSessionsDir() }
    }
    const sessionsDir =
      this.resumeRolloutPreparation?.sessionsDir ?? getCodexSessionsDir()
    let acquiringStop: Promise<() => Promise<void>>

    if (this.resumeThreadId) {
      const preparation = this.resumeRolloutPreparation
      // The options union makes this unreachable for typed callers. Retaining
      // the runtime guard makes JavaScript and `as any` consumers fail closed
      // instead of silently recreating the post-spawn registration race.
      if (!preparation) {
        throw new Error(
          'Codex resume requires prepareCodexResumeRollout() before PTY spawn',
        )
      }
      if (preparation.initialPath) {
        acquiringStop = this.tailPreparedResumeRolloutFile(preparation)
      } else {
        // A pre-spawn lookup miss cannot contribute exact or lineage evidence.
        // Dispose the empty capability before entering fresh evidence policy so
        // there is exactly one lifecycle owner for the fallback participant.
        await preparation.dispose(true)
        this.emit(
          'rollout-error',
          new Error(
            `Codex resume: rollout file for thread ${this.resumeThreadId} not found under ${sessionsDir}; falling back to new-file watcher`,
          ),
        )
        acquiringStop = this.tailNewRolloutFile(sessionsDir)
      }
    } else {
      acquiringStop = this.tailNewRolloutFile(sessionsDir)
    }

    // WHY both ownership helpers deliberately perform their causal setup before
    // their first await: fresh startup installs its participant, while exact
    // resume opens X and consumes the prepared lineage capability. Only after
    // that synchronous prefix is it safe to subscribe the terminal mirror. We
    // must nevertheless subscribe *before* watcher readiness settles because
    // Agent Code publishes the already-spawned PTY while start() is pending;
    // otherwise provider composer frames emitted during priming disappear and
    // the later Enter has no provider-rendered prompt evidence.
    this.terminal.attach()
    const acquiredStop = await acquiringStop

    if (this.stopRequested) {
      // WHY SessionManager deliberately stops once before start settles and
      // once afterwards. The first call cannot close a resource that the
      // awaited acquisition has not returned yet, and the second call joins
      // the same idempotent stop promise. Close the late acquisition here,
      // before publishing it on the instance, so that cancellation cannot
      // leak a coordinator participant or path lease between those calls.
      try { await acquiredStop() } catch { /* best-effort */ }
      return { sessionsDir }
    }
    this.stopRolloutTail = acquiredStop

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
    // WHY registration stays immediately before terminal.write in write(): the
    // coordinator's causal proof depends on knowing that an earlier rollout
    // observation cannot have been authored by bytes this PTY has not received
    // yet. Moving this into sendPrompt or making it asynchronous would silently
    // invalidate the late-identical-prompt safety argument. The accumulator is
    // equally important: the provider-rendered stable frame, rather than a raw
    // byte-level editor replica, decides whether Enter/Tab belongs to the
    // current composer and what draft it will submit.
    const frame = this.terminal.snapshotStableFrame()
    for (const prompt of this.promptInputEvidence.consume(data, { frame })) {
      this.freshRolloutParticipant?.registerPrompt(prompt)
    }
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

  /**
   * Submit an identity candidate observed on this session's private Responses
   * proxy. The method is deliberately fire-and-forget because proxy request
   * forwarding must not wait on a recursive sessions-tree lookup.
   *
   * This is not a second ownership policy. The candidate can open a tail only
   * after RolloutLocator proves request id == filename UUID == session_meta.id,
   * then the existing process-wide coordinator installs an `exact-id` lease.
   */
  observeProviderThreadIdentity(threadId: string): void {
    if (
      this.resumeThreadId || this.stopRequested ||
      threadId.length === 0 ||
      this.pendingProviderThreadIdentities.has(threadId)
    ) return
    if (this.provenProviderThreadIdentity !== null) {
      // The first fully proved identity owns this pane. A later conflicting
      // request may be a subagent/new protocol shape; it cannot switch a live
      // committed stream after the fact.
      return
    }

    this.pendingProviderThreadIdentities.add(threadId)
    void this.claimExactFreshRollout(threadId)
      .catch(error => {
        if (this.stopRequested) return
        this.emit(
          'rollout-error',
          error instanceof Error ? error : new Error(String(error)),
        )
      })
      .finally(() => {
        this.pendingProviderThreadIdentities.delete(threadId)
      })
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
    this.stopRequested = true
    if (!this.stopPromise) {
      // WHY SessionManager intentionally issues a pre-start and post-start
      // stop during cancellation. Those calls may overlap. Sharing one promise
      // prevents the second call from interpreting an already-taken tail as a
      // clean close and retiring its lease while the first close is still live.
      this.stopPromise = (async () => {
        this.terminal.dispose()
        await this.cleanup()
      })()
    }
    await this.stopPromise
  }

  private async cleanup(): Promise<void> {
    if (this.cleanupPromise) {
      await this.cleanupPromise
      return
    }
    const stopRolloutTail = this.stopRolloutTail
    this.stopRolloutTail = null
    if (!stopRolloutTail) {
      if (!this.startRequested && this.resumeRolloutPreparation) {
        // WHY construction transfers ownership of the prepared exact lease to
        // this instance. If start never runs, there is no tail cleanup closure
        // that could release it later; stop() must dispose the capability itself
        // or every sequential resume in this process remains blocked forever.
        this.cleanupPromise = (async () => {
          try { await this.resumeRolloutPreparation?.dispose(true) } catch { /* best-effort */ }
        })()
        await this.cleanupPromise
      }
      return
    }

    // WHY terminal exit and explicit stop are independent callers. Publishing
    // this promise before awaiting makes them join the same physical close;
    // otherwise stop() can observe a null tail and return while the exit path
    // is still draining the watcher and retiring its lease.
    this.cleanupPromise = (async () => {
      try { await stopRolloutTail() } catch { /* best-effort */ }
    })()
    await this.cleanupPromise
  }

  // --- Rollout file tailing ---

  /**
   * Tail a single rollout JSONL file using the proven poll-based
   * JsonlTailer (same implementation Claude uses). Each line is
   * parsed and emitted as 'rollout-entry'. The first session_meta
   * entry is captured for getSessionMeta().
   */
  private tailFile(
    filePath: string,
    expectedGenerationId?: string | null,
  ): () => Promise<void> {
    const stop = tailSessionFile<CodexRolloutLine>(
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
      {
        ...(this.resumeThreadId
          ? { bootstrapTailLines: CodexHeadless.RESUME_BOOTSTRAP_TAIL_LINES }
          : {}),
        ...(expectedGenerationId ? { expectedGenerationId } : {}),
      },
    )
    // WHY publish only after FileTailer has synchronously opened and fstat'd
    // the authorized generation. Setting these fields first made a failed
    // generation handoff look like a live switch and blocked the still-valid
    // original resume tail.
    this.activeRolloutPath = filePath
    this.tailedRolloutPaths.add(filePath)
    return stop
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
   * We therefore keep the existing tail and, for a bounded window, register
   * its copied item IDs in the same coordinator that owns fresh prompts. When
   * a new candidate shares enough lineage, that stronger edge is leased before
   * copied user history can be mistaken for a fresh prompt. One common watcher
   * transports both evidence kinds; callback order is no longer policy.
   *
   * This is still not a perfect identity proof. Codex does not expose
   * a parent/resume id in every forked file, and Agent Code can spawn
   * multiple Codex sessions in the same cwd. The stronger long-term
   * fix is for Codex to write a stable resume lineage id into
   * `session_meta` or for Agent Code to get the provider session id
   * over an explicit API. Until then, "new after resume + same cwd + copied
   * item lineage + bounded watch + switch once" is the narrowest practical
   * repair for the permanent committed-channel outage.
   */
  private async tailPreparedResumeRolloutFile(
    preparation: CodexResumeRolloutPreparationInternal,
  ): Promise<() => Promise<void>> {
    const initialPath = preparation.initialPath
    const initialGenerationId = preparation.initialGenerationId
    if (!initialPath || !initialGenerationId || !this.resumeThreadId) {
      throw new Error('Codex resume rollout preparation has no exact rollout')
    }

    let stopped = false
    let currentStop: (() => Promise<void>) | null = null
    let currentPath = initialPath
    let switchQueue = Promise.resolve()
    let cleanupPromise: Promise<void> | null = null

    try {
      currentStop = this.tailFile(initialPath, initialGenerationId)
    } catch (error) {
      // WHY preparation owns cleanup here: exact reservation and lineage
      // registration happened before this object existed. Splitting rollback
      // between two owners is how failed constructors leave phantom leases.
      // A synchronous throw means tailFile never returned its stop authority.
      // FileTailer validates open+fstat before constructing its poll timer, so
      // there is no physical tail to overlap and exact X is cleanly retryable.
      // Asynchronous close failures still flow through the returned stop closure
      // below and remain conservatively tombstoned.
      await preparation.dispose(true)
      throw error
    }

    const switchTo = async (
      filePath: string,
      generationId: string | null,
    ): Promise<void> => {
      if (stopped) return
      if (this.activeRolloutPath === filePath) return
      if (this.tailedRolloutPaths.has(filePath)) return
      // The coordinator installs the resume-lineage lease before invoking this
      // callback. Reserving again here would recreate two policy owners and
      // allow a fresh callback to win between lineage proof and tail startup.
      // Open the new tail BEFORE closing the stale one: a gap would
      // drop any entry written in between. The brief overlap is safe
      // — a forked rollout begins with this session's copied history,
      // so the new tail's bootstrap re-emits entries the stale tail
      // already emitted, and downstream ingest dedupes by the
      // deterministic per-entry uuid (`<timestamp>:<id>`). Closing
      // first to avoid the overlap would trade a harmless duplicate
      // (deduped) for a real lost-entry window.
      const previous = currentStop
      const previousPath = currentPath
      let nextStop: () => Promise<void>
      try {
        if (!generationId) {
          throw new Error('Codex lineage lease has no verified rollout generation')
        }
        nextStop = this.tailFile(filePath, generationId)
      } catch (error) {
        // The new path was reserved before opening to preserve at-most-one
        // tail. Retire only that failed switch: the original tail remains live
        // and must keep its own active lease.
        // WHY this is a clean retirement: tailFile did not return a stop closure,
        // and its generation-bound constructor validates the descriptor before
        // publishing any timer or instance field. X may have a live tail, but Y
        // has none; conflating their resources permanently bricks a safe Y retry.
        preparation.retirePathLease(filePath, true)
        this.emit(
          'rollout-error',
          error instanceof Error ? error : new Error(String(error)),
        )
        return
      }
      currentStop = nextStop
      currentPath = filePath
      // A successful tail switch is NOT an error. It used to emit
      // `rollout-error`, which the Agent Code parent surfaces as a
      // transcript failure ("transcript unavailable: …") even though
      // the resume recovered correctly. Switching the committed tail
      // to the forked rollout is the intended behaviour of this
      // watcher, so it must not poison the error channel. A dedicated
      // non-error diagnostic event is tracked separately in #11; until
      // then this switch is observable through the `rollout-entry`
      // stream that immediately resumes from the new file.
      let previousClosedCleanly = true
      if (previous) {
        try { await previous() } catch { previousClosedCleanly = false }
      }
      preparation.retirePathLease(previousPath, previousClosedCleanly)
      preparation.unregisterResumeParticipant()
      // Once lineage Y is physically open, continued root polling cannot add
      // correctness. Release the shared watcher reference immediately while
      // retaining the capability long enough to retire Y on final stop.
      await preparation.releaseWatcher()
    }

    try {
      preparation.consume({
        resumeThreadId: this.resumeThreadId,
        cwd: this.cwd,
        handlers: {
          onDecision: decision => {
            // Missing/weak lineage is expected to fail closed, but it must stay
            // observable. Without this diagnostic, a held candidate is
            // indistinguishable from a dead filesystem watcher in field logs.
            this.emitRolloutDiagnostic({
              type: 'resume-fork-ignored',
              ts: Date.now(),
              reason: decision.reason,
              lineageOverlap: decision.lineageOverlap,
              requiredOverlap: decision.requiredOverlap,
              candidateFingerprint: decision.candidateFingerprint,
            })
          },
          onLease: lease => {
            // WHY switches serialize even though the graph emits one mutual
            // singleton: stop can race callback delivery. The queue lets cleanup
            // revoke admission, then wait for any already-admitted switch before
            // deciding whether the current physical tail closed cleanly.
            switchQueue = switchQueue
              .then(() => switchTo(lease.filePath, lease.generationId))
              .catch(error => {
                this.emit(
                  'rollout-error',
                  error instanceof Error ? error : new Error(String(error)),
                )
              })
          },
        },
      })
    } catch (error) {
      let clean = true
      try { await currentStop?.() } catch { clean = false }
      await preparation.dispose(clean)
      throw error
    }

    const timeout = setTimeout(() => {
      // Unregister synchronously so no callback can be admitted after the
      // bounded lineage window. Already-admitted switches remain serialized in
      // switchQueue; watcher release joins behind them and is idempotent with a
      // successful switch's own early release.
      preparation.unregisterResumeParticipant()
      switchQueue = switchQueue
        .then(() => preparation.releaseWatcher())
        .catch(error => {
          this.emit(
            'rollout-error',
            error instanceof Error ? error : new Error(String(error)),
          )
        })
    }, CodexHeadless.RESUME_FORK_WATCH_MS)

    return () => {
      if (!cleanupPromise) {
        cleanupPromise = (async () => {
          stopped = true
          clearTimeout(timeout)
          preparation.unregisterResumeParticipant()
          await switchQueue
          const stopTail = currentStop
          currentStop = null
          let cleanTailClose = true
          if (stopTail) {
            try { await stopTail() } catch { cleanTailClose = false }
          }
          preparation.retirePathLease(currentPath, cleanTailClose)
          await preparation.dispose(cleanTailClose)
        })()
      }
      return cleanupPromise
    }
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
    let stopped = false
    let latestDecision: FreshRolloutParticipantDecision | null = null
    const acquisition = beginFreshRolloutCoordinatorAcquisition({
      sessionsRoot: sessionsDir,
      normalizeCwd,
      normalizePath: normalizeCwd,
      onError: error => this.emit('rollout-error', error),
    })
    // Publish the method-only coordinator capability before watcher readiness:
    // the parent attaches the proxy adapter before awaiting headless.start(),
    // so an immediate provider request can legitimately deliver exact identity
    // while initial candidate observations are still being committed.
    this.freshRolloutAcquisition = acquisition

    let participant: FreshRolloutParticipantHandle
    try {
      participant = acquisition.coordinator.registerParticipant({
        participantId: this.freshRolloutParticipantId,
        cwd: this.cwd,
        onDecision: state => {
          latestDecision = state
          if (state.decision === 'accept') return
          const { decision, reason, tailAuthorized: _tailAuthorized, ...evidence } = state
          this.emitRolloutDiagnostic({
            type: 'fresh-rollout-ownership-decision',
            ts: Date.now(),
            decision,
            reason,
            tailStarted: false,
            evidence,
          })
        },
        onLease: lease => {
          if (stopped || this.activeRolloutPath) return

          // WHY this remains the only physical fresh tail call: the shared
          // coordinator has already installed an irreversible path lease before
          // invoking us. CodexHeadless owns I/O, while the transcript layer owns
          // identity; neither renderer nor parent adapter gets a second policy.
          try {
            if (!lease.generationId) {
              throw new Error('Codex fresh lease has no verified rollout generation')
            }
            this.freshRolloutStopTail = this.tailFile(
              lease.filePath,
              lease.generationId,
            )
          } catch (error) {
            // WHY the coordinator cannot infer this from an arbitrary throwing
            // onLease callback: another consumer could open a resource and then
            // throw. Here CodexHeadless owns the exact transaction. A synchronous
            // throw before tailFile returns means no stop closure, poller, or
            // published activeRolloutPath exists, so this one path is cleanly
            // retryable. Rethrowing still withdraws the failed participant; the
            // coordinator's generic uncertain rollback sees an already-retired
            // lease and cannot downgrade it to a tombstone.
            acquisition.coordinator.retirePathLease(
              this.freshRolloutParticipantId,
              lease.filePath,
              true,
            )
            throw error
          }
          const state = latestDecision
          if (!state) return
          const {
            decision,
            reason,
            tailAuthorized: _tailAuthorized,
            ...evidence
          } = state
          this.emitRolloutDiagnostic({
            type: 'fresh-rollout-ownership-decision',
            ts: Date.now(),
            decision,
            reason,
            tailStarted: true,
            evidence,
          })
        },
      })
    } catch (error) {
      if (this.freshRolloutAcquisition === acquisition) {
        this.freshRolloutAcquisition = null
      }
      await acquisition.release()
      throw error
    }
    // WHY this assignment precedes watcher readiness: write() is intentionally
    // available while start() is pending. Prompt registration must take its
    // coordinator sequence now, before any primed candidate observations are
    // committed, rather than being replayed with a later causal order.
    this.freshRolloutParticipant = participant
    try {
      await acquisition.ready
    } catch (error) {
      participant.unregister()
      if (this.freshRolloutParticipant === participant) {
        this.freshRolloutParticipant = null
      }
      if (this.freshRolloutAcquisition === acquisition) {
        this.freshRolloutAcquisition = null
      }
      await acquisition.release()
      throw error
    }

    return async () => {
      if (stopped) return
      stopped = true
      participant.unregister()
      if (this.freshRolloutParticipant === participant) {
        this.freshRolloutParticipant = null
      }
      const stopTail = this.freshRolloutStopTail
      this.freshRolloutStopTail = null
      let cleanTailClose = true
      if (stopTail) {
        try { await stopTail() } catch { cleanTailClose = false }
      }
      acquisition.coordinator.retireOwnerLeases(
        this.freshRolloutParticipantId,
        cleanTailClose,
      )
      await acquisition.release()
      if (this.freshRolloutAcquisition === acquisition) {
        this.freshRolloutAcquisition = null
      }
    }
  }

  private async claimExactFreshRollout(threadId: string): Promise<void> {
    const acquisition = this.freshRolloutAcquisition
    if (!acquisition || this.stopRequested || this.resumeThreadId) return

    // RolloutLocator is the proof boundary shared with resume: it accepts only
    // UUID ids and returns a generation after verifying both the filename UUID
    // and the first session_meta.id. Cwd/mtime are selection aids nowhere in
    // this path, which is what keeps same-cwd orchestration siblings isolated.
    const location = await findCodexRolloutByThreadId(
      getCodexSessionsDir(),
      threadId,
    )
    if (
      !location || this.stopRequested ||
      this.freshRolloutAcquisition !== acquisition ||
      this.provenProviderThreadIdentity !== null
    ) return

    if (this.activeRolloutPath !== null) {
      // A prompt-proved tail can legitimately win before the proxy request is
      // parsed. Exact agreement confirms that existing path; disagreement
      // fails closed instead of opening two files or switching committed truth.
      if (this.activeRolloutPath === location.filePath) {
        this.provenProviderThreadIdentity = threadId
      }
      return
    }

    const reserved = acquisition.coordinator.reservePath({
      ownerId: this.freshRolloutParticipantId,
      filePath: location.filePath,
      kind: 'exact-id',
      proofIdentity: threadId,
    })
    if (!reserved) return

    try {
      this.freshRolloutStopTail = this.tailFile(
        location.filePath,
        location.generationId,
      )
      this.provenProviderThreadIdentity = threadId
      // Exact identity is strictly stronger than prompt matching. Withdraw the
      // participant after the generation-bound tail opens so later candidate
      // observations cannot manufacture a second claim for this pane.
      this.freshRolloutParticipant?.unregister()
    } catch (error) {
      // tailFile publishes no state before its synchronous open+fstat succeeds;
      // this exact reservation is therefore cleanly retryable on open failure.
      acquisition.coordinator.retirePathLease(
        this.freshRolloutParticipantId,
        location.filePath,
        true,
      )
      throw error
    }
  }

  private emitRolloutDiagnostic(diagnostic: CodexRolloutDiagnostic): void {
    try {
      this.emit('rollout-diagnostic', diagnostic)
    } catch {
      // WHY ownership diagnostics are explicitly non-authoritative. Electron
      // teardown can leave a destroyed-window listener that throws; allowing
      // that observer failure to escape an onLease callback tells the
      // coordinator that a successfully opened physical tail failed, which
      // tombstones the path and blocks every later exact resume in this process.
    }
  }
}
