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
// Live-turn ownership model.
// ---------------------------------------------------------------------------
//
// Mirrors the claude-code-headless LiveOwner* shapes — same reasoning
// about why ownership belongs on the orchestrator and not on the
// SemanticChannel transport. See claude-code-headless/src/channels/
// types.ts for the full rationale; Codex's differences:
//
//   * `rollout` is a first-class live owner because Codex's rollout
//     stream delivers `agent_message_delta` events that are genuinely
//     authoritative. Claude's JSONL is not a live producer — it only
//     lands after an assistant turn has committed — so its package
//     does not list `rollout` (and would not list `jsonl`) here.
//
//   * Proxy is listed because the CodexResponsesAdapter can publish
//     live semantics when it is active. Selection between proxy and
//     rollout as live owner is a per-session choice made by the
//     orchestrator.
//
// See docs/superpowers/plans/2026-04-18-headless-live-turn-redesign.md
// for the full architectural rationale.

export type LiveOwnerKind = 'proxy' | 'rollout' | 'screen'

export interface LiveOwnerState {
  kind: LiveOwnerKind | null
  turnId: string | null
  startedAt: number | null
  status: 'idle' | 'live' | 'reconciling'
}

export interface LiveOwnerDecision {
  accept: boolean
  action: 'start' | 'drop' | 'promote' | 'finalize' | 'clear'
  kind: LiveOwnerKind
  turnId: string
  reason: string
  prev: LiveOwnerState
  next: LiveOwnerState
  ts: number
}

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
// Block-level semantic events (Responses API alignment).
// ---------------------------------------------------------------------------
//
// Codex's rollout stream aggregates items after the fact — a single
// rollout line carries the whole `agent_message` or `exec_command_end`
// payload. The wire-level /responses SSE, by contrast, is block-
// structured: one response contains N output items (see
// `response.output_item.added` / `.done`), each of which is one
// concrete variant from ResponseItem — Message, Reasoning, FunctionCall,
// WebSearchCall, ImageGenerationCall, LocalShellCall, etc. All thirteen
// variants are documented in codex-rs/protocol/src/models.rs:188-341.
//
// WHY block-level events exist on THIS channel (not just on the rollout
// path): a consumer listening only to `turn_delta.fullText` gets one
// flat string for the turn, which loses the interleaving of "text,
// then function call, then more text, then image generation" that the
// Codex TUI actually renders. Block events preserve that structure so
// a proxy-driven renderer can show tool cards, image cards, and
// reasoning segments in the order Codex emitted them — without waiting
// for rollout to catch up.
//
// WHY these look a lot like Claude's block events: deliberate parallel.
// The naming (`block_started` / `text_delta` / `block_completed`)
// matches claude-code-headless's channels/types.ts so a consumer that
// already subscribes to Claude's block lifecycle can reuse the same
// handler shape for Codex with only a kind-mapping change. See
// claude-code-headless/src/channels/types.ts:190-327 for the sibling
// definitions.
//
// Index semantics: `blockIndex` comes from the `output_index` field
// on Responses SSE (or the position in `response.output` for replay).
// Stable within a turn; paired across `block_started` → any
// per-kind deltas → `block_completed`.

export type SemanticBlockRef = {
  turnId: string
  /** Upstream `output_index` field — stable within a turn, used to
   *  correlate `block_started` / delta / `block_completed` for the
   *  same block and to preserve ordering across interleaved items. */
  blockIndex: number
  /** The upstream item id (e.g. `rs_…`, `msg_…`, `fc_…`). Preserved so
   *  consumers can match SSE events against rollout entries that carry
   *  the same id. Optional because early frames sometimes arrive before
   *  the id is known (`response.created` with no items yet). */
  itemId?: string
}

/** Every ResponseItem variant the /responses SSE can carry. Mirrors
 *  the Rust enum at codex-rs/protocol/src/models.rs:188-341 one-to-one,
 *  plus an `other` catch-all so a new variant added upstream doesn't
 *  silently vanish from the consumer's view. Kept as a discriminated
 *  union of string literals (not a class hierarchy) so the renderer
 *  can do a simple switch without a runtime instanceof check. */
export type SemanticBlockKind =
  | 'message'
  | 'reasoning'
  | 'function_call'
  | 'function_call_output'
  | 'custom_tool_call'
  | 'custom_tool_call_output'
  | 'tool_search_call'
  | 'tool_search_output'
  | 'local_shell_call'
  | 'web_search_call'
  | 'image_generation_call'
  | 'compaction'
  | 'ghost_snapshot'
  | 'other'

/** Fires at `response.output_item.added`. Carries enough metadata for
 *  the renderer to mount a skeleton card — the concrete contents arrive
 *  later via kind-specific deltas (text / thinking) or at
 *  `block_completed`. The skeleton-on-added pattern matches what
 *  Claude's adapter does and keeps the UI from looking stuck while a
 *  long tool call streams. */
export type SemanticBlockStartedEvent = SemanticBlockRef & {
  type: 'block_started'
  kind: SemanticBlockKind
  /** For function / custom tool calls: the tool name. */
  toolName?: string
  /** For tool / function variants: the upstream `call_id` — pairs the
   *  call against its later `*_output` block, since the output arrives
   *  as a SEPARATE output_item with only the call_id in common. */
  callId?: string
  /** For Message blocks: `"commentary"` or `"final_answer"` when the
   *  model declared one. See codex-rs/protocol/src/models.rs:176-184.
   *  Legacy/older models may omit it — treat `undefined` as "unknown". */
  messagePhase?: 'commentary' | 'final_answer'
  /** Initial status when present (e.g. `"in_progress"` on a tool call
   *  that hasn't completed yet). */
  status?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Per-block text delta. Fires from `response.output_text.delta`, which
 *  Codex delivers keyed to the currently open Message block's item.
 *  `textSoFar` is a running accumulator so late subscribers can catch
 *  up without replaying every delta — same contract Claude uses. */
export type SemanticTextDeltaEvent = SemanticBlockRef & {
  type: 'text_delta'
  textDelta: string
  textSoFar: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Thinking delta for a `reasoning` block. Fires from
 *  `response.reasoning_text.delta` (the detailed reasoning) AND
 *  `response.reasoning_summary_text.delta` (the shorter summary). The
 *  `track` field distinguishes them so a consumer can collapse
 *  summaries separately from full reasoning. Both tracks accumulate
 *  independently.
 *
 *  The old adapter parsed these and threw them away with a comment
 *  arguing rollout would render them eventually. That's only true if
 *  the user is fine with a several-second gap during a thinking pause.
 *  Publishing them live is a clearer UX; the rollout reconciler can
 *  emit `source_changed` when it catches up (the channel already does
 *  this for text). */
export type SemanticThinkingDeltaEvent = SemanticBlockRef & {
  type: 'thinking_delta'
  /** Which reasoning track the delta is on. `'summary'` comes from
   *  reasoning_summary_text.delta; `'full'` from reasoning_text.delta. */
  track: 'summary' | 'full'
  thinkingDelta: string
  thinkingSoFar: string
  /** Index within the reasoning item for this track. `summary_index`
   *  for summary tracks, `content_index` for full tracks — both come
   *  directly off the SSE event so a renderer that wants to keep
   *  independent summaries in order can do so. */
  index: number
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Fires at `response.output_item.done`. Carries the final, fully
 *  typed ResponseItem. This is the authoritative "this block is
 *  settled" signal — every structural item (tool calls, web searches,
 *  image generations, compactions, ghost snapshots) lands here. The
 *  renderer should prefer this over deltas when it needs the canonical
 *  state, because deltas may arrive out-of-order during retries.
 *
 *  WHY we carry `raw` in addition to typed fields: the ResponseItem
 *  enum is growing (`WebSearchAction` added new variants in recent
 *  codex-rs releases). A future upstream addition wouldn't be visible
 *  through the typed fields until we update this file, but `raw` keeps
 *  the full payload available to app code that wants to poke at new
 *  fields without waiting for a package bump. */
export type SemanticBlockCompletedEvent = SemanticBlockRef & {
  type: 'block_completed'
  kind: SemanticBlockKind
  /** For `message`: the flattened text content across all output_text
   *  ContentItems in the final message. */
  text?: string
  /** For `reasoning`: the final summary text (joined across all
   *  SummaryText entries) and full reasoning text when present. */
  reasoningSummary?: string
  reasoningText?: string
  /** For tool variants: tool name + call id. */
  toolName?: string
  callId?: string
  /** For function_call: the final arguments JSON string (raw — may be
   *  invalid JSON, same as Claude's contract). `parsed` is our best
   *  effort JSON.parse; `parseError` is set if it failed so the
   *  renderer can show an error state instead of a half-rendered
   *  tool call. */
  argumentsJson?: string
  parsedArguments?: Record<string, unknown>
  parseError?: string
  /** For function_call_output / custom_tool_call_output: the output
   *  payload as-is. May be a string or a structured content array
   *  depending on `FunctionCallOutputPayload` on the Rust side. */
  output?: unknown
  /** For web_search_call: the action variant (Search/OpenPage/FindInPage)
   *  plus its query/url. We keep it as a typed object so the renderer
   *  doesn't have to reparse raw. */
  webSearchAction?: {
    kind: 'search' | 'open_page' | 'find_in_page' | 'other'
    query?: string
    queries?: string[]
    url?: string
    pattern?: string
  }
  /** For image_generation_call: the generated payload. `result` is
   *  base64-encoded by default; consumers that want to save or display
   *  it need to decode. */
  imageGeneration?: {
    status: string
    revisedPrompt?: string
    result: string
  }
  /** For local_shell_call: the exec action details (command, cwd, env,
   *  user, timeout). Mirrors LocalShellExecAction on the Rust side. */
  localShellCall?: {
    status: string
    command: string[]
    workingDirectory?: string
    timeoutMs?: number
    env?: Record<string, string>
    user?: string
  }
  /** Final upstream status if the item carried one (tool calls often
   *  do; messages usually don't). */
  status?: string
  /** Full raw upstream payload, kept for future-proofing when a new
   *  ResponseItem variant ships before we add typed fields. */
  raw?: Record<string, unknown>
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Turn-lifecycle events beyond start / delta / completed.
// ---------------------------------------------------------------------------

/** Fires when the turn ended with information the caller needs beyond
 *  "it's done": an incomplete-reason from `response.incomplete` (e.g.
 *  `max_output_tokens`, `content_filter`) or a classified error from
 *  `response.failed`. For error cases, `apiError` holds the
 *  classified shape (see SemanticApiErrorEvent).
 *
 *  Why `stopReason` is a string and not a union: codex-rs's
 *  incomplete_details.reason is freeform string (responses.rs:311);
 *  upstream can add new reasons without schema changes, and we don't
 *  want a package bump every time they do. Common values at time of
 *  writing: `max_output_tokens`, `content_filter`, `max_tokens`. */
export type SemanticTurnStoppedEvent = {
  type: 'turn_stopped'
  turnId: string
  stopReason: string | null
  /** Convenience flag when stopReason indicates a content-policy
   *  refusal. Saves the renderer from hardcoding the value. */
  isRefusal: boolean
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Error events.
// ---------------------------------------------------------------------------
//
// Mirrors Claude's two-tier split: stream errors are soft (the SSE had
// a hiccup but more bytes may follow), api errors are hard (the request
// failed, show the error card).

/** Soft streaming-defensive error. Fires when the adapter's own SSE
 *  parser hits a malformed frame — invalid JSON, missing fields, or
 *  an unexpected event shape. The turn continues if possible; the
 *  consumer can show a diagnostic badge without tearing down the
 *  card. */
export type SemanticStreamErrorEvent = {
  type: 'stream_error'
  turnId: string | null
  /** Machine-readable tag so the renderer can branch. Values:
   *  `json_parse_error`, `unexpected_frame_shape`, `missing_required_field`. */
  errorType: string
  message: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Hard API-level failure. Port of codex-rs's ApiError classification
 *  from codex-api/src/error.rs:14-32. The `errorType` values are
 *  stable identifiers suitable for UI branching — NOT human-readable
 *  messages. Use `message` for display text.
 *
 *  Classification mirrors responses.rs:280-298 exactly so rendering
 *  behaviour stays consistent between the proxy path and whatever
 *  else might reconstruct an error later. */
export type SemanticApiErrorEvent = {
  type: 'api_error'
  turnId: string | null
  /** One of: `context_window_exceeded`, `quota_exceeded`,
   *  `usage_not_included`, `server_overloaded`, `invalid_request`,
   *  `retryable`, or `stream` for the generic fallback. Matches the
   *  ApiError variants in codex-api/src/error.rs. */
  errorType:
    | 'context_window_exceeded'
    | 'quota_exceeded'
    | 'usage_not_included'
    | 'server_overloaded'
    | 'invalid_request'
    | 'retryable'
    | 'stream'
  message: string
  /** For `retryable`: the server-suggested delay in milliseconds if
   *  present on the upstream error. Parsed from the `Retry-After`-style
   *  hint via try_parse_retry_after on the Rust side. */
  retryAfterMs?: number
  /** HTTP status when available (upstream transport errors). */
  status?: number
  /** Convenience flag: `errorType === 'server_overloaded'`. */
  isOverloaded?: boolean
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
// one-to-one — same shape so a shared reducer in Agent Code can fold
// either provider's diagnostics into the same ProxyDebugPanel state.
// Before these existed, the Agent Code adapter had to cast
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
// Lifecycle-violation diagnostic.
// ---------------------------------------------------------------------------
//
// Fires when a publisher calls into SemanticChannel with a turnId that
// does not match the channel's current active turnId. Mirrors the
// Claude package's `SemanticLifecycleViolationEvent` — see that file
// for the full rationale. Kept off the `SemanticEvent` union so the
// reducer in Agent Code doesn't have to grow a new branch.
export type SemanticLifecycleViolationEvent = {
  type: 'lifecycle_violation'
  kind:
    | 'start_while_active'
    | 'delta_mismatched_turn'
    | 'finish_mismatched_turn'
  attemptedTurnId: string
  activeTurnId: string | null
  source: SemanticSource
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

// ---------------------------------------------------------------------------
// Stream phase — "what is the model doing right now".
// ---------------------------------------------------------------------------
//
// Parallel to claude-code-headless/src/channels/types.ts — both packages
// expose the same vocabulary so the Agent Code renderer can drive its
// in-feed WorkIndicator off a single field regardless of provider. See
// the sibling types file for the WHY of each label.
export type StreamPhase =
  | 'idle'
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'tool-input'
  | 'tool-use'
  | 'awaiting-tool'

/** Semantic stream phase — authoritative "what is the model doing right
 *  now" signal, derived by the proxy adapter from Responses-API SSE
 *  events. Mirrors the Claude-side SemanticStreamPhaseEvent shape so the
 *  downstream renderer has one code path for both providers. */
export type SemanticStreamPhaseEvent = {
  type: 'stream_phase'
  turnId: string | null
  phase: StreamPhase
  toolName?: string
  toolUseId?: string
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
  | SemanticBlockStartedEvent
  | SemanticTextDeltaEvent
  | SemanticThinkingDeltaEvent
  | SemanticBlockCompletedEvent
  | SemanticTurnStoppedEvent
  | SemanticStreamErrorEvent
  | SemanticApiErrorEvent
  | SemanticFlowSelectedEvent
  | SemanticFlowIgnoredEvent
  | SemanticUsageEvent
  | SemanticStreamPhaseEvent

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
