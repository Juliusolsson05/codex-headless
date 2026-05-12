import { EventEmitter } from 'events'

import type {
  SemanticApiErrorEvent,
  SemanticBlockCompletedEvent,
  SemanticBlockKind,
  SemanticBlockStartedEvent,
  SemanticEvent,
  SemanticFlowIgnoredEvent,
  SemanticFlowSelectedEvent,
  SemanticLifecycleViolationEvent,
  SemanticSource,
  SemanticSourceChangedEvent,
  SemanticStreamErrorEvent,
  SemanticStreamPhaseEvent,
  SemanticTextDeltaEvent,
  SemanticThinkingDeltaEvent,
  SemanticToolCompletedEvent,
  SemanticToolOutputDeltaEvent,
  SemanticToolStartedEvent,
  SemanticTurnCompletedEvent,
  SemanticTurnDeltaEvent,
  SemanticTurnStartedEvent,
  SemanticTurnStoppedEvent,
  SemanticUsageEvent,
  StreamPhase,
} from './types.js'

// Codex SemanticChannel — the "what Codex is producing right now"
// stream. Mirrors the Claude package's SemanticChannel in shape, but
// codex's primary source is the rollout delta stream (`event_msg` of
// kind `agent_message_delta`, plus tool begin/end/output events),
// which is genuinely authoritative. Screen fallback is used only when
// the rollout file is not yet available.
//
// Design rule: visual-only surfaces (trust modal, approval overlay,
// working row) NEVER land here. They are published on the screen
// channel. The whole point of the split is to keep semantic rendering
// from being polluted by TUI chrome events — we are not going to
// reintroduce that entanglement.
//
// -----------------------------------------------------------------------
// Lifecycle strictness (2026-04-18 redesign).
// -----------------------------------------------------------------------
//
// This channel is now a STRICT transport. It no longer auto-seals
// mismatched turns on startTurn, and it no longer auto-starts a turn
// when a delta arrives without one. Instead it DROPS the offending
// event and emits a `lifecycle_violation` diagnostic so debug tooling
// can see the miss.
//
// WHY: the prior auto-heal behaviour was defensible when rollout was
// the only live producer, but once the CodexResponsesAdapter landed
// we had two authoritative live producers. The auto-heal let them
// fight over `activeTurnId`, producing the 0/1/0/1 block flicker
// fixed by the 2026-04-17 flicker plan. Making the channel strict
// pushes the coherence requirement up to the orchestrator, which is
// where it belongs — only CodexHeadless sees rollout state, proxy
// state, and screen state at once, so only it can assign an owner.
//
// See docs/superpowers/plans/2026-04-18-headless-live-turn-redesign.md
// for the ownership model the orchestrator now uses.

export type SemanticChannelEvents = {
  event: [SemanticEvent]
  turn_started: [SemanticTurnStartedEvent]
  turn_delta: [SemanticTurnDeltaEvent]
  turn_completed: [SemanticTurnCompletedEvent]
  source_changed: [SemanticSourceChangedEvent]
  tool_started: [SemanticToolStartedEvent]
  tool_output_delta: [SemanticToolOutputDeltaEvent]
  tool_completed: [SemanticToolCompletedEvent]
  block_started: [SemanticBlockStartedEvent]
  text_delta: [SemanticTextDeltaEvent]
  thinking_delta: [SemanticThinkingDeltaEvent]
  block_completed: [SemanticBlockCompletedEvent]
  turn_stopped: [SemanticTurnStoppedEvent]
  stream_error: [SemanticStreamErrorEvent]
  api_error: [SemanticApiErrorEvent]
  flow_selected: [SemanticFlowSelectedEvent]
  flow_ignored: [SemanticFlowIgnoredEvent]
  usage_updated: [SemanticUsageEvent]

  // Upstream stream-phase derivation. Parallel to the Claude-side
  // SemanticStreamPhaseEvent — the proxy adapter derives a phase label
  // from response.output_item.added / .done transitions; the screen
  // fallback publishes a coarser `thinking` / `idle` when proxy is off.
  stream_phase: [SemanticStreamPhaseEvent]

  // Lifecycle-violation diagnostics. Fires when a publisher calls
  // startTurn/applyDelta/finishTurn with a turnId that does not match
  // the active turn. Deliberately NOT on the catch-all `'event'`
  // stream — see channels/types.ts for the rationale.
  lifecycle_violation: [SemanticLifecycleViolationEvent]
}

export interface SemanticChannel {
  on<K extends keyof SemanticChannelEvents>(
    event: K,
    listener: (...args: SemanticChannelEvents[K]) => void,
  ): this
  off<K extends keyof SemanticChannelEvents>(
    event: K,
    listener: (...args: SemanticChannelEvents[K]) => void,
  ): this
  emit<K extends keyof SemanticChannelEvents>(
    event: K,
    ...args: SemanticChannelEvents[K]
  ): boolean
}

export class SemanticChannel extends EventEmitter {
  private activeTurnId: string | null = null
  private activeRole: 'user' | 'assistant' | null = null
  private lastSource: SemanticSource | null = null
  private lastFullText = ''

  getActiveTurnId(): string | null {
    return this.activeTurnId
  }

  getLastSource(): SemanticSource | null {
    return this.lastSource
  }

  getLastFullText(): string {
    return this.lastFullText
  }

  /**
   * Begin a semantic turn.
   *
   * Strict lifecycle (see file header): same-turn re-entry is an
   * idempotent no-op; starting while a different turn is active is a
   * protocol violation that we DROP + emit `lifecycle_violation` for.
   * The orchestrator must explicitly `finishTurn` the previous turn
   * before opening a new one. This is a change from the previous
   * auto-seal behaviour, which let any racing producer take over the
   * active-turn slot.
   */
  startTurn(params: {
    turnId: string
    role: 'user' | 'assistant'
    source: SemanticSource
    confidence?: SemanticTurnStartedEvent['confidence']
  }): void {
    if (this.activeTurnId === params.turnId) return

    if (this.activeTurnId) {
      const violation: SemanticLifecycleViolationEvent = {
        type: 'lifecycle_violation',
        kind: 'start_while_active',
        attemptedTurnId: params.turnId,
        activeTurnId: this.activeTurnId,
        source: params.source,
        ts: Date.now(),
      }
      this.emit('lifecycle_violation', violation)
      return
    }

    this.activeTurnId = params.turnId
    this.activeRole = params.role
    this.lastSource = params.source
    this.lastFullText = ''

    const ev: SemanticTurnStartedEvent = {
      type: 'turn_started',
      turnId: params.turnId,
      role: params.role,
      source: params.source,
      confidence: params.confidence ?? (params.source === 'screen' ? 'fallback' : 'high'),
      ts: Date.now(),
    }
    this.emit('turn_started', ev)
    this.emit('event', ev)
  }

  /**
   * Publish a delta for the active turn.
   *
   * Strict lifecycle (see file header): mismatched turnId or no open
   * turn → DROP + emit `lifecycle_violation`. The previous auto-start
   * behaviour was removed because it let any producer hijack the
   * active-turn slot with a delta alone.
   *
   * Same-turn source promotion (e.g. screen → rollout mid-turn, which
   * in practice we no longer do because screen and rollout run on
   * separate channels now, but the publisher contract still allows
   * it) still emits `source_changed` before the delta.
   */
  applyDelta(params: {
    turnId: string
    fullText: string
    textDelta?: string
    markdownText?: string
    source: SemanticSource
    confidence?: SemanticTurnDeltaEvent['confidence']
  }): void {
    if (this.activeTurnId !== params.turnId) {
      const violation: SemanticLifecycleViolationEvent = {
        type: 'lifecycle_violation',
        kind: 'delta_mismatched_turn',
        attemptedTurnId: params.turnId,
        activeTurnId: this.activeTurnId,
        source: params.source,
        ts: Date.now(),
      }
      this.emit('lifecycle_violation', violation)
      return
    }

    if (this.lastFullText === params.fullText && !params.textDelta) {
      return
    }

    if (this.lastSource !== null && this.lastSource !== params.source) {
      const ev: SemanticSourceChangedEvent = {
        type: 'source_changed',
        turnId: params.turnId,
        previousSource: this.lastSource,
        source: params.source,
        confidence: params.confidence ?? 'high',
        ts: Date.now(),
      }
      this.emit('source_changed', ev)
      this.emit('event', ev)
    }

    this.lastSource = params.source
    this.lastFullText = params.fullText

    const ev: SemanticTurnDeltaEvent = {
      type: 'turn_delta',
      turnId: params.turnId,
      textDelta: params.textDelta,
      fullText: params.fullText,
      markdownText: params.markdownText,
      source: params.source,
      confidence: params.confidence ?? (params.source === 'screen' ? 'fallback' : 'high'),
      ts: Date.now(),
    }
    this.emit('turn_delta', ev)
    this.emit('event', ev)
  }

  /**
   * Finalize the active turn.
   *
   * Idempotent by design (two producers can legitimately both think
   * they ended the same turn; first wins). Mismatched turnId → DROP
   * + emit `lifecycle_violation`. Dropping is safe because the real
   * `turn_completed` has already fired; a duplicate would just
   * confuse late subscribers.
   */
  finishTurn(params: {
    turnId: string
    fullText?: string
    source: SemanticSource
    confidence?: SemanticTurnCompletedEvent['confidence']
  }): void {
    if (this.activeTurnId !== params.turnId) {
      const violation: SemanticLifecycleViolationEvent = {
        type: 'lifecycle_violation',
        kind: 'finish_mismatched_turn',
        attemptedTurnId: params.turnId,
        activeTurnId: this.activeTurnId,
        source: params.source,
        ts: Date.now(),
      }
      this.emit('lifecycle_violation', violation)
      return
    }

    const ev: SemanticTurnCompletedEvent = {
      type: 'turn_completed',
      turnId: params.turnId,
      fullText: params.fullText ?? (this.lastFullText || undefined),
      source: params.source,
      confidence: params.confidence ?? (params.source === 'screen' ? 'fallback' : 'high'),
      ts: Date.now(),
    }
    this.emit('turn_completed', ev)
    this.emit('event', ev)

    this.activeTurnId = null
    this.activeRole = null
    this.lastSource = null
    this.lastFullText = ''
  }

  // --- Tool lifecycle ------------------------------------------------------

  toolStarted(params: {
    callId: string
    tool: SemanticToolStartedEvent['tool']
    label?: string
    source: SemanticSource
    confidence?: SemanticToolStartedEvent['confidence']
  }): void {
    const ev: SemanticToolStartedEvent = {
      type: 'tool_started',
      turnId: this.activeTurnId,
      callId: params.callId,
      tool: params.tool,
      label: params.label,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('tool_started', ev)
    this.emit('event', ev)
  }

  toolOutputDelta(params: {
    callId: string
    textDelta: string
    source: SemanticSource
    confidence?: SemanticToolOutputDeltaEvent['confidence']
  }): void {
    if (!params.textDelta) return
    const ev: SemanticToolOutputDeltaEvent = {
      type: 'tool_output_delta',
      callId: params.callId,
      textDelta: params.textDelta,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('tool_output_delta', ev)
    this.emit('event', ev)
  }

  toolCompleted(params: {
    callId: string
    exitCode?: number
    source: SemanticSource
    confidence?: SemanticToolCompletedEvent['confidence']
  }): void {
    const ev: SemanticToolCompletedEvent = {
      type: 'tool_completed',
      callId: params.callId,
      exitCode: params.exitCode,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('tool_completed', ev)
    this.emit('event', ev)
  }

  // --- Flow attribution diagnostics ---------------------------------------
  //
  // These are a first-class publisher surface so the proxy adapter
  // doesn't have to smuggle events through a typed-as-unknown cast on
  // `.emit('event', …)`. Before they existed the Agent Code adapter had
  // a `publishRawEvent` helper that did exactly that — see the old
  // `src/providers/codex/runtime/codexResponsesAdapter.ts:155`. Typed
  // methods keep the publisher contract visible and let future
  // consumers subscribe by name (`'flow_selected'`) instead of
  // filtering on the catch-all `event` stream.

  publishFlowSelected(params: {
    flowId: string
    turnId: string | null
    reason: string
    source: SemanticSource
    confidence?: SemanticFlowSelectedEvent['confidence']
  }): void {
    const ev: SemanticFlowSelectedEvent = {
      type: 'flow_selected',
      flowId: params.flowId,
      turnId: params.turnId,
      reason: params.reason,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('flow_selected', ev)
    this.emit('event', ev)
  }

  publishFlowIgnored(params: {
    flowId: string
    reason: string
    source: SemanticSource
    confidence?: SemanticFlowIgnoredEvent['confidence']
  }): void {
    const ev: SemanticFlowIgnoredEvent = {
      type: 'flow_ignored',
      flowId: params.flowId,
      reason: params.reason,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('flow_ignored', ev)
    this.emit('event', ev)
  }

  // --- Usage accounting ---------------------------------------------------

  publishUsageUpdated(params: {
    turnId: string
    usage: Record<string, number | string | undefined>
    costUSD?: number
    source: SemanticSource
    confidence?: SemanticUsageEvent['confidence']
  }): void {
    const ev: SemanticUsageEvent = {
      type: 'usage_updated',
      turnId: params.turnId,
      usage: params.usage,
      costUSD: params.costUSD,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('usage_updated', ev)
    this.emit('event', ev)
  }

  // --- Block-level publishers (Responses API alignment) ------------------
  //
  // These fire per ResponseItem — one block_started / optional deltas /
  // one block_completed per output_item on the wire. The proxy adapter
  // owns the translation; consumers just subscribe by name. See
  // channels/types.ts Block-level section for the design rationale and
  // the rollout-path source_changed reconciliation story.

  publishBlockStarted(params: {
    turnId: string
    blockIndex: number
    itemId?: string
    kind: SemanticBlockKind
    toolName?: string
    callId?: string
    messagePhase?: 'commentary' | 'final_answer'
    status?: string
    source: SemanticSource
    confidence?: SemanticBlockStartedEvent['confidence']
  }): void {
    const ev: SemanticBlockStartedEvent = {
      type: 'block_started',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      itemId: params.itemId,
      kind: params.kind,
      toolName: params.toolName,
      callId: params.callId,
      messagePhase: params.messagePhase,
      status: params.status,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('block_started', ev)
    this.emit('event', ev)
  }

  publishTextDelta(params: {
    turnId: string
    blockIndex: number
    itemId?: string
    textDelta: string
    textSoFar: string
    source: SemanticSource
    confidence?: SemanticTextDeltaEvent['confidence']
  }): void {
    const ev: SemanticTextDeltaEvent = {
      type: 'text_delta',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      itemId: params.itemId,
      textDelta: params.textDelta,
      textSoFar: params.textSoFar,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('text_delta', ev)
    this.emit('event', ev)
  }

  publishThinkingDelta(params: {
    turnId: string
    blockIndex: number
    itemId?: string
    track: 'summary' | 'full'
    thinkingDelta: string
    thinkingSoFar: string
    index: number
    source: SemanticSource
    confidence?: SemanticThinkingDeltaEvent['confidence']
  }): void {
    const ev: SemanticThinkingDeltaEvent = {
      type: 'thinking_delta',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      itemId: params.itemId,
      track: params.track,
      thinkingDelta: params.thinkingDelta,
      thinkingSoFar: params.thinkingSoFar,
      index: params.index,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('thinking_delta', ev)
    this.emit('event', ev)
  }

  publishBlockCompleted(params: {
    turnId: string
    blockIndex: number
    itemId?: string
    kind: SemanticBlockKind
    text?: string
    reasoningSummary?: string
    reasoningText?: string
    toolName?: string
    callId?: string
    argumentsJson?: string
    parsedArguments?: Record<string, unknown>
    parseError?: string
    output?: unknown
    webSearchAction?: SemanticBlockCompletedEvent['webSearchAction']
    imageGeneration?: SemanticBlockCompletedEvent['imageGeneration']
    localShellCall?: SemanticBlockCompletedEvent['localShellCall']
    status?: string
    raw?: Record<string, unknown>
    source: SemanticSource
    confidence?: SemanticBlockCompletedEvent['confidence']
  }): void {
    const ev: SemanticBlockCompletedEvent = {
      type: 'block_completed',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      itemId: params.itemId,
      kind: params.kind,
      text: params.text,
      reasoningSummary: params.reasoningSummary,
      reasoningText: params.reasoningText,
      toolName: params.toolName,
      callId: params.callId,
      argumentsJson: params.argumentsJson,
      parsedArguments: params.parsedArguments,
      parseError: params.parseError,
      output: params.output,
      webSearchAction: params.webSearchAction,
      imageGeneration: params.imageGeneration,
      localShellCall: params.localShellCall,
      status: params.status,
      raw: params.raw,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('block_completed', ev)
    this.emit('event', ev)
  }

  // --- Turn-lifecycle + error publishers ---------------------------------

  publishTurnStopped(params: {
    turnId: string
    stopReason: string | null
    isRefusal?: boolean
    source: SemanticSource
    confidence?: SemanticTurnStoppedEvent['confidence']
  }): void {
    const ev: SemanticTurnStoppedEvent = {
      type: 'turn_stopped',
      turnId: params.turnId,
      stopReason: params.stopReason,
      // Default: the `refusal` string is the conventional content-policy
      // refusal signal in recent OpenAI API shapes. Conservative fallback
      // keeps the flag tied to the stop reason without additional input.
      isRefusal: params.isRefusal ?? params.stopReason === 'refusal',
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('turn_stopped', ev)
    this.emit('event', ev)
  }

  publishStreamError(params: {
    turnId: string | null
    errorType: string
    message: string
    source: SemanticSource
    confidence?: SemanticStreamErrorEvent['confidence']
  }): void {
    const ev: SemanticStreamErrorEvent = {
      type: 'stream_error',
      turnId: params.turnId,
      errorType: params.errorType,
      message: params.message,
      source: params.source,
      // Stream errors come from the adapter's own parser, so they're
      // authoritative about what we SAW — but soft-failed. Keep the
      // confidence honest by defaulting to medium, not high.
      confidence: params.confidence ?? 'medium',
      ts: Date.now(),
    }
    this.emit('stream_error', ev)
    this.emit('event', ev)
  }

  publishApiError(params: {
    turnId: string | null
    errorType: SemanticApiErrorEvent['errorType']
    message: string
    retryAfterMs?: number
    status?: number
    source: SemanticSource
    confidence?: SemanticApiErrorEvent['confidence']
  }): void {
    const ev: SemanticApiErrorEvent = {
      type: 'api_error',
      turnId: params.turnId,
      errorType: params.errorType,
      message: params.message,
      retryAfterMs: params.retryAfterMs,
      status: params.status,
      isOverloaded: params.errorType === 'server_overloaded',
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('api_error', ev)
    this.emit('event', ev)
  }

  // -------------------------------------------------------------------
  // Stream-phase publisher.
  //
  // Same pattern as the Claude-side SemanticChannel: stateful dedupe on
  // (phase, turnId, toolUseId) so back-to-back identical emits are
  // swallowed. Parallel implementation kept intentionally (not shared
  // across packages) because each package's SemanticChannel is the
  // seam its adapter publishes through — collapsing them would require
  // a cross-package abstraction we don't have.
  // -------------------------------------------------------------------
  private lastPhase: StreamPhase = 'idle'
  private lastPhaseTurnId: string | null = null
  private lastPhaseToolUseId: string | undefined = undefined

  getLastPhase(): StreamPhase {
    return this.lastPhase
  }

  publishStreamPhase(params: {
    turnId: string | null
    phase: StreamPhase
    toolName?: string
    toolUseId?: string
    source: SemanticSource
    confidence?: SemanticStreamPhaseEvent['confidence']
  }): void {
    if (
      this.lastPhase === params.phase &&
      this.lastPhaseTurnId === params.turnId &&
      this.lastPhaseToolUseId === params.toolUseId
    ) {
      return
    }
    this.lastPhase = params.phase
    this.lastPhaseTurnId = params.turnId
    this.lastPhaseToolUseId = params.toolUseId

    const ev: SemanticStreamPhaseEvent = {
      type: 'stream_phase',
      turnId: params.turnId,
      phase: params.phase,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      source: params.source,
      confidence: params.confidence ?? 'high',
      ts: Date.now(),
    }
    this.emit('stream_phase', ev)
    this.emit('event', ev)
  }
}
