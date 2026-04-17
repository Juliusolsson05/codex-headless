// Three-channel truth model for codex-headless.
//
// Mirrors the split in claude-code-headless (see
// claude-code-headless/src/channels/types.ts for the full rationale):
//
//   semantic  — what Codex is producing right now
//   screen    — what the terminal is rendering right now
//   committed — what the rollout file has persisted
//
// WHY this matters for Codex specifically:
//
// Codex already publishes a rich semantic stream through its rollout
// file — `event_msg` entries include `agent_message_delta`,
// `turn_started`, `turn_complete`, tool begin/end, and exec output
// deltas. That means Codex's semantic channel can be authoritative
// (source='rollout', confidence='high') with zero screen scraping in
// the happy path. Screen parsing stays as a fallback path only, so the
// consumer can render JIT markdown from genuine provider-ordered
// deltas instead of inferring them from TUI paint.
//
// Screen channel remains fully separate. Trust dialogs, approval
// overlays, and working-row state are visual UI that the consumer
// mirrors; they have no business on the semantic channel.
//
// Pure types only — no runtime, no Node, no DOM.

import type { ScreenApproval } from '../parsers/ApprovalParser.js'
import type { CodexTrustDialogState } from '../parsers/TrustDialogParser.js'
import type {
  CodexMessageItem,
  CodexResponseItem,
  CodexRolloutLine,
  CodexSessionMeta,
} from '../transcript/TranscriptTypes.js'

// ---------------------------------------------------------------------------
// Provenance tags shared across events.
// ---------------------------------------------------------------------------

/** Which raw source produced a semantic event. Codex's rollout stream
 *  is the primary semantic truth; screen fallback exists only when the
 *  rollout hasn't caught up (e.g. a fresh session whose rollout file
 *  has not been created yet). Proxy is listed for future parity with
 *  the Claude package — Codex itself does not currently need a proxy
 *  adapter because rollout deltas are already authoritative. */
export type SemanticSource = 'rollout' | 'proxy' | 'screen'

/** Trust tag layered on top of source.
 *
 *  high     — `event_msg` delta or committed response_item.
 *  medium   — derived from a committed rollout entry after the fact.
 *  fallback — inferred from TUI paint (screen extractor). Correct
 *             often, wrong enough of the time that the consumer should
 *             be defensive about any destructive action keyed on the
 *             content. */
export type SemanticConfidence = 'high' | 'medium' | 'fallback'

// ---------------------------------------------------------------------------
// Semantic channel.
// ---------------------------------------------------------------------------

export type SemanticTurnStartedEvent = {
  type: 'turn_started'
  turnId: string
  role: 'user' | 'assistant'
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticTurnDeltaEvent = {
  type: 'turn_delta'
  turnId: string
  textDelta?: string
  fullText: string
  /** Codex rollout deltas deliver plain UTF-8; the screen fallback can
   *  optionally deliver markdown when it has it. Kept optional so the
   *  common `rollout` path doesn't have to fabricate a markdown flavor
   *  that upstream already intends as markdown. */
  markdownText?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticTurnCompletedEvent = {
  type: 'turn_completed'
  turnId: string
  fullText?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticSourceChangedEvent = {
  type: 'source_changed'
  turnId: string | null
  previousSource: SemanticSource | null
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Tool lifecycle on the semantic channel — a first-class Codex
 *  concept because the rollout stream emits `exec_command_begin`,
 *  `exec_command_output_delta`, `exec_command_end`, and the MCP
 *  equivalents. Consumers that want to render tool cards, progress,
 *  or output can fold these directly. */
export type SemanticToolStartedEvent = {
  type: 'tool_started'
  turnId: string | null
  callId: string
  tool: 'exec' | 'mcp' | 'custom' | 'function'
  /** Best-effort human-friendly label. For exec we pass the command
   *  array joined with a space; for MCP we pass `${server}.${tool}`. */
  label?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticToolOutputDeltaEvent = {
  type: 'tool_output_delta'
  callId: string
  textDelta: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticToolCompletedEvent = {
  type: 'tool_completed'
  callId: string
  exitCode?: number
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Flow attribution diagnostics (proxy-sourced only).
// ---------------------------------------------------------------------------
//
// The rollout source has no notion of "flows" — it's a single ordered
// append-only file, so there is nothing to attribute. The proxy source
// DOES: every HTTP request to /responses opens a distinct flow, and
// retries or overlapping compaction requests can produce multiple
// concurrent flows on the same path. The adapter surfaces its
// selection decisions here so the UI can explain "we're rendering
// flow X" / "we dropped flow Y because Z" without each consumer
// having to reverse-engineer it from request/response events.
//
// These mirror Claude's SemanticFlowSelectedEvent/SemanticFlowIgnoredEvent
// one-to-one — same shape so a shared reducer in cc-shell can fold
// either provider's diagnostics into the same ProxyDebugPanel state.
// Before these existed, the cc-shell adapter had to cast
// `headless.semantic as { emit }` to smuggle raw `flow_selected`
// events through the untyped `event` channel — a hack that leaked
// publisher details into the adapter and blocked further type-safety
// tightening. Typed publishers close the loop.

export type SemanticFlowSelectedEvent = {
  type: 'flow_selected'
  turnId: string | null
  flowId: string
  /** Freeform diagnostic reason — usually method+path of the picked
   *  request ("POST /v1/responses"). Not machine-parsed. */
  reason: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticFlowIgnoredEvent = {
  type: 'flow_ignored'
  flowId: string
  /** Why this flow was excluded — e.g. "non-POST", "path does not
   *  match /responses", "concurrent flow already active". Freeform. */
  reason: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Usage accounting.
// ---------------------------------------------------------------------------
//
// Published on turn completion when the upstream response carried a
// `usage` block. We pass the payload through as a flat map of
// numbers/strings — nested upstream shapes (e.g. `input_tokens_details`)
// are flattened with `parent.child` keys so the downstream cost
// calculator can read them without knowing the specific Responses API
// shape. Intentionally mirrors Claude's SemanticUsageEvent so a
// shared cost model can consume either.
//
// Why not a stricter typed shape: Codex's Responses API usage fields
// are still evolving (new cache tiers, new service_tier hints); a
// loose Record keeps us forward-compatible instead of dropping fields
// the parser doesn't know about yet. Strictness belongs in the cost
// calculator, not at the wire boundary.

export type SemanticUsageEvent = {
  type: 'usage_updated'
  turnId: string
  usage: Record<string, number | string | undefined>
  /** Optional cost estimate in USD if a calculator was provided. The
   *  adapter does not populate this today — reserved for future
   *  consumer-layer enrichment. */
  costUSD?: number
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticEvent =
  | SemanticTurnStartedEvent
  | SemanticTurnDeltaEvent
  | SemanticTurnCompletedEvent
  | SemanticSourceChangedEvent
  | SemanticToolStartedEvent
  | SemanticToolOutputDeltaEvent
  | SemanticToolCompletedEvent
  | SemanticFlowSelectedEvent
  | SemanticFlowIgnoredEvent
  | SemanticUsageEvent

// ---------------------------------------------------------------------------
// Screen channel.
// ---------------------------------------------------------------------------

export type ScreenSnapshotEvent = {
  type: 'snapshot'
  plain: string
  markdown: string
  ts: number
}

export type ScreenActivityEvent = {
  type: 'activity'
  active: boolean
  status: string | null
  ts: number
}

export type ScreenTrustDialogEvent = {
  type: 'trust_dialog'
  state: CodexTrustDialogState
  ts: number
}

export type ScreenApprovalEvent = {
  type: 'approval'
  visible: boolean
  state: ScreenApproval | null
  ts: number
}

export type ScreenEvent =
  | ScreenSnapshotEvent
  | ScreenActivityEvent
  | ScreenTrustDialogEvent
  | ScreenApprovalEvent

// ---------------------------------------------------------------------------
// Committed channel.
// ---------------------------------------------------------------------------

export type CommittedTurnEvent = {
  type: 'turn_committed'
  /** Synthesised id. Rollout `response_item` entries do not carry a
   *  per-line uuid, so we use the item's own `id` when present and
   *  fall back to a monotonic fingerprint of timestamp + content hash
   *  (see CommittedChannel.publishLine for the fingerprinting logic). */
  turnId: string
  role: 'user' | 'assistant' | 'developer' | 'system'
  text: string
  item: CodexMessageItem
  file: string
  ts: number
}

export type CommittedResponseItemEvent = {
  type: 'response_item'
  item: CodexResponseItem
  file: string
  ts: number
}

export type CommittedSessionMetaEvent = {
  type: 'session_meta'
  meta: CodexSessionMeta
  file: string
  ts: number
}

export type CommittedRolloutLineEvent = {
  type: 'rollout_line'
  line: CodexRolloutLine
  file: string
  ts: number
}

export type CommittedEvent =
  | CommittedTurnEvent
  | CommittedResponseItemEvent
  | CommittedSessionMetaEvent
  | CommittedRolloutLineEvent
