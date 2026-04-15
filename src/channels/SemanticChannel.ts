import { EventEmitter } from 'events'

import type {
  SemanticEvent,
  SemanticSource,
  SemanticSourceChangedEvent,
  SemanticToolCompletedEvent,
  SemanticToolOutputDeltaEvent,
  SemanticToolStartedEvent,
  SemanticTurnCompletedEvent,
  SemanticTurnDeltaEvent,
  SemanticTurnStartedEvent,
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

export type SemanticChannelEvents = {
  event: [SemanticEvent]
  turn_started: [SemanticTurnStartedEvent]
  turn_delta: [SemanticTurnDeltaEvent]
  turn_completed: [SemanticTurnCompletedEvent]
  source_changed: [SemanticSourceChangedEvent]
  tool_started: [SemanticToolStartedEvent]
  tool_output_delta: [SemanticToolOutputDeltaEvent]
  tool_completed: [SemanticToolCompletedEvent]
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

  startTurn(params: {
    turnId: string
    role: 'user' | 'assistant'
    source: SemanticSource
    confidence?: SemanticTurnStartedEvent['confidence']
  }): void {
    if (this.activeTurnId === params.turnId) return

    // Seal the previous turn if it was never finished. Codex emits
    // `task_started` before `task_complete`, but recording gaps and
    // reconnects can both leave a turn dangling. Safer to auto-seal
    // than to silently refuse the new turn.
    if (this.activeTurnId) {
      this.finishTurn({
        turnId: this.activeTurnId,
        fullText: this.lastFullText || undefined,
        source: this.lastSource ?? params.source,
        confidence: 'medium',
      })
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

  applyDelta(params: {
    turnId: string
    fullText: string
    textDelta?: string
    markdownText?: string
    source: SemanticSource
    confidence?: SemanticTurnDeltaEvent['confidence']
  }): void {
    if (
      this.activeTurnId === params.turnId &&
      this.lastFullText === params.fullText &&
      !params.textDelta
    ) {
      return
    }

    if (
      this.activeTurnId === params.turnId &&
      this.lastSource !== null &&
      this.lastSource !== params.source
    ) {
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

    if (this.activeTurnId !== params.turnId) {
      this.startTurn({
        turnId: params.turnId,
        role: 'assistant',
        source: params.source,
      })
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

  finishTurn(params: {
    turnId: string
    fullText?: string
    source: SemanticSource
    confidence?: SemanticTurnCompletedEvent['confidence']
  }): void {
    if (this.activeTurnId !== params.turnId) return

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
}
