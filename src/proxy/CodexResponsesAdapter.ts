import { Buffer } from 'node:buffer'
import { StringDecoder } from 'string_decoder'
import type { CodexHeadless } from '../CodexHeadless.js'
import type { SemanticApiErrorEvent, SemanticBlockKind, SemanticTurnStoppedEvent, StreamPhase } from '../channels/types.js'
import type { ResponsesProxy } from './responsesProxy.js'
import { fingerprintProviderSession } from '../transcript/ProviderSessionFingerprint.js'

// CodexResponsesAdapter — consumes the raw SSE chunks that
// `ResponsesProxy` emits on its 'event' channel, parses OpenAI
// Responses API events, and publishes them to the CodexHeadless
// SemanticChannel as `source: 'proxy'` turns/deltas.
//
// WHY this lives inside codex-headless (and not in Agent Code):
//   This file used to live at src/providers/codex/runtime/ in
//   Agent Code. The comment that used to justify that placement argued
//   the transport adapter belonged next to the HTTP server because
//   both were "Agent Code transport concerns". That argument was wrong
//   on two counts:
//     1. It called itself a "parallel" to ClaudeProxyAdapter, which
//        in fact lives INSIDE the claude-code-headless package. The
//        split was an anti-parallel, not a parallel.
//     2. It forced the adapter to smuggle typed events through a
//        `headless.semantic as { emit }` cast (the old
//        `publishRawEvent` helper) because the submodule's
//        SemanticChannel had no typed publisher for `flow_selected`
//        or `usage_updated`. Every new proxy-only event type would
//        have required another cast, and the natural cure — adding
//        typed publishers to SemanticChannel — was blocked by the
//        file living outside the package that owned the channel.
//   Moving the adapter next to SemanticChannel lets us expose typed
//   publishers (publishFlowSelected / publishFlowIgnored /
//   publishUsageUpdated) and keeps the package's public surface
//   symmetric with claude-code-headless, where ClaudeProxyAdapter
//   has always lived inside the submodule. Downstream consumers
//   (Agent Code today, anyone else tomorrow) get a complete proxy
//   pipeline by importing one package, not two.
//
// WHY proxy source is preferred when available:
//   The rollout file is high-fidelity but *latent* — Codex writes
//   it after the fact, so the first byte arrives seconds after
//   Codex started producing output. The proxy sees response bytes
//   as they come back from the server, so the semantic live-turn
//   fills in instantly. When both fire, the rollout reducer in
//   CodexHeadless will emit `source_changed` on convergence and
//   defer to whichever source reached the turn first.
//
// Format reference:
//   OpenAI Responses API SSE events, as of 2026-04. Sampled live
//   in scripts/proxy-harness.mts against chatgpt.com/backend-api/codex
//   and api.openai.com/v1/responses. Known event types:
//     response.created
//     response.in_progress
//     response.output_item.added / .done
//     response.content_part.added / .done
//     response.output_text.delta / .done
//     response.reasoning_summary_part.added / .done
//     response.reasoning_summary_text.delta
//     response.reasoning_text.delta
//     response.completed
//     response.failed
//     response.incomplete
//   See codex-src/codex-rs/codex-api/src/sse/responses.rs for the
//   authoritative upstream parser.

type ChunkEvent = {
  kind: 'response-chunk'
  requestId: string
  path: string
  size: number
  chunk: Buffer
}

type StartEvent = {
  kind: 'request'
  requestId: string
  method: string
  path: string
  upstream: string
  /** Typed endpoint label emitted by responsesProxy.classifyEndpoint:
   *  one of 'responses', 'responses/compact', 'memories/trace_summarize',
   *  'realtime/calls', 'models', 'unknown'. Used by handleTransportEvent
   *  to filter sidecar endpoints out of the active-flow attribution
   *  state machine — see the path-vs-endpoint comment in that method. */
  endpoint?: string
  /** Filtered request headers. Allowlist enforced by the proxy
   *  (see responsesProxy.ts _HEADER_ALLOWLIST). Adapter does not
   *  consume these today; forwarded for forensic logging only. */
  headers?: Record<string, string>
  /** Base64-encoded raw request body, when ≤ 2 MiB. Adapter does
   *  not consume; future predicate work or bundle tooling reads it. */
  body_b64?: string
  /** Pre-parsed shape metadata (model, instructions_chars,
   *  input_items_count, tools_count, has_reasoning). Same forensic
   *  rationale as body_b64 — adapter doesn't read today. */
  request_shape?: {
    model?: string | null
    instructions_chars?: number | null
    input_items_count?: number | null
    tools_count?: number | null
    has_reasoning?: boolean
    client_metadata?: {
      thread_id?: string | null
      session_id?: string | null
      root_turn_id?: string | null
    } | null
    provider_session_id?: string | null
  }
}

type EndEvent = {
  kind: 'response-end'
  requestId: string
  path: string
  bytes: number
}

/** The proxy's response-headers event, emitted once per HTTP call the moment
 *  upstream status and headers are known and before any body byte flows.
 *
 *  WHY the adapter cares about it at all now: for a 2xx SSE turn the status
 *  line carries nothing the frames don't already say, which is why this event
 *  was ignored for the adapter's whole life. A non-2xx reply is the opposite —
 *  it is the ONLY place the HTTP status and the rate-limit pool headers
 *  appear, and its body is a one-shot JSON error document that never produces
 *  an SSE frame. */
type ResponseEvent = {
  kind: 'response'
  requestId: string
  path: string
  status: number
  /** Rate-limit subset only — allowlisted by responsesProxy.pickRateLimitHeaders.
   *  Anything else upstream sent is deliberately not here. */
  headers?: Record<string, string>
}

/** Buffered non-2xx reply, parked on the flow between `response` and
 *  `response-end`. Presence of this field is what switches the flow from
 *  "parse SSE frames" to "collect an error document". */
type HttpFailure = {
  status: number
  headers: Record<string, string>
  body: string
  /** Set once the body hit MAX_FAILURE_BODY_CHARS and stopped growing. The
   *  classifier reads it as "do not trust these bytes". */
  truncated: boolean
}

// Hard ceiling on a buffered error document, measured in decoded characters
// (never more than the byte count under UTF-8, so it is a conservative memory
// bound; for the ASCII JSON these documents are, the two are identical).
//
// WHY a cap at all: the `response` branch decides to buffer purely from the
// HTTP status, and nothing forces a >=400 reply to be small. A misconfigured
// upstream, a captive-portal login page, or a proxy streaming an error the
// size of a real turn would otherwise accumulate unbounded in memory on a
// flow that, by definition, nobody is watching for output.
//
// WHY 256 KB and not something tight like 64 KB: a real error document is a
// few hundred bytes, so any cap is effectively unreachable in practice; the
// number only has to be small enough to be harmless and large enough that no
// plausible JSON error is ever truncated. 256 KB satisfies both without
// anyone having to justify a tighter guess later.
const MAX_FAILURE_BODY_CHARS = 256 * 1024

type CodexResponsesAdapterHeadless = Pick<
  CodexHeadless,
  'semantic' | 'observeProviderThreadIdentity'
>

// Per-turn state tracked by the adapter. Keyed by the proxy's
// requestId (emitted on every request/response/chunk/end/error event
// for that specific HTTP call). Path-based keying was the old
// approach; it silently merged overlapping retries' bytes into
// whichever flow happened to be most-recent on that path.
type FlowState = {
  flowId: string
  // requestId from the proxy. Responses are routed to this flow by
  // requestId equality, not by path — path is kept only for
  // observability/logging.
  requestId: string
  path: string
  // Parsed from the proxy's allowlisted x-codex-window-id header. Keep the
  // upstream thread UUID and numeric window generation separate so Agent Code
  // can compare the UUID with committed session_meta without persisting a raw
  // header line or teaching this adapter any transcript-ownership policy.
  providerSessionFingerprint: string | null
  providerWindowGenerationId: string | null
  // Presence only. Upstream values such as `collab_spawn` identify child
  // traffic but are not needed for continuity and may evolve into free-form
  // labels. Absence does NOT prove this is a root request, so the field name
  // deliberately states the one-sided observation instead of a classification.
  subagentHeaderPresent: boolean
  // `response.id` from the upstream, used as our semantic turnId.
  // Falls back to the flow id until response.created arrives.
  responseId: string | null
  // Active flow visible at request time, if any. First-chunk
  // attribution deliberately happens later, but request-time
  // concurrency is still semantically important: a request born while
  // another response owns the slot is a retry/warmup/overlap, not the
  // client-executed tool follow-up that appears only after a terminal
  // SSE event. Without preserving this snapshot, an overlap whose
  // first bytes arrive after the active flow completes can steal the
  // newly freed active slot and demote the real follow-up to secondary.
  activeFlowIdAtRequest: string | null
  // Rolling SSE frame buffer — bytes are chunked arbitrarily.
  buffer: string
  // Incremental UTF-8 decoder. HTTP chunks can split a multi-byte
  // codepoint at any byte boundary (emoji, CJK, box-drawing all come
  // back as ≥2 bytes). An eager `Buffer.toString('utf-8')` per chunk
  // substitutes the split tail with U+FFFD, permanently corrupting
  // the assistant text. `StringDecoder` holds the trailing partial
  // bytes until the next chunk arrives and emits only complete
  // codepoints, so the assistant stream is byte-accurate.
  decoder: StringDecoder
  // Accumulated assistant text across all output_text.delta events.
  // Used for the legacy turn-level applyDelta call so consumers that
  // don't subscribe to per-block events still see the whole reply.
  fullText: string
  // Block index for the current assistant message output item, if
  // any. Multiple items can exist in one response (message, tool
  // call, reasoning, etc.) but we only surface the message text as
  // the turn's `fullText`.
  messageBlockIndex: number | null
  // Per-block state. Indexed by the upstream item id (e.g. `msg_...`,
  // `rs_...`, `fc_...`) which is stable for the life of the block.
  //
  // Every block we've seen a `response.output_item.added` for gets an
  // entry here. Kept until `response.output_item.done` fires (and then
  // for the remainder of the flow so later events referencing the
  // same item id by race don't NPE). Deltas for text and reasoning
  // accumulate into `textSoFar` / `summarySoFar` / `reasoningSoFar` /
  // `inputSoFar` so each delta event we emit carries a running total —
  // consumers can jump in mid-stream without replaying.
  blocks: Map<
    string,
    {
      index: number
      kind: SemanticBlockKind
      // For tool call variants: the upstream call_id, surfaced on
      // block_started and carried through to block_completed so
      // consumers can pair calls with their *_output siblings.
      callId?: string
      // For function_call / custom_tool_call: the tool name, needed
      // on block_started for skeleton rendering.
      toolName?: string
      // For Message blocks: accumulator for output_text.delta events.
      // Needed because the wire delivers deltas keyed to the response
      // (not the item), and we want per-block text accumulators too.
      textSoFar: string
      // For Reasoning blocks: separate accumulators per upstream
      // reasoning track. `summarySoFar` for reasoning_summary_text.delta
      // (the user-facing short summary); `fullSoFar` for
      // reasoning_text.delta (the detailed chain-of-thought).
      summarySoFar: string
      fullSoFar: string
      // For custom tool calls like apply_patch. The Responses wire
      // streams these through response.custom_tool_call_input.delta
      // before the final CustomToolCall.input appears at
      // output_item.done. Keeping the accumulator here makes the
      // semantic event self-sufficient and prevents renderers from
      // having to replay raw SSE frames to reconstruct the patch.
      inputSoFar: string
    }
  >
  // Whether we've emitted startTurn for this flow yet. Used to
  // avoid publishing deltas before the turn exists.
  turnOpened: boolean
  // Tool-call items that finalised their arguments during this flow,
  // in the order their `response.output_item.done` fired. Used at
  // `response.completed` to pick the "next tool to run" for the
  // `awaiting-tool` phase transition. Populated only for tool
  // variants (function_call / custom_tool_call / local_shell_call /
  // web_search_call / image_generation_call / tool_search_call); the
  // `_output` kinds never land here.
  pendingToolUses: Array<{ toolUseId: string; toolName: string }>
  // Last observed `obfuscation` nonce — noisy, only for debug logs.
  lastObfuscation: string | null
  // Wall-clock timestamp of the last proxy event touching this flow
  // (request / response-chunk / response-end / response-error /
  // upstream-error). Updated on every handler entry so the watchdog
  // can detect flows that went silent without a terminator.
  //
  // Seeded at `request` time; refreshed on every subsequent chunk.
  // A flow whose `lastEventAt` hasn't moved in WATCHDOG_STALE_MS is
  // assumed dead and released, matching the Claude adapter's
  // timeout pattern.
  lastEventAt: number
  // Attribution — mirrors ClaudeProxyAdapter's three-state model.
  //
  //   'candidate' — freshly minted on `request`. No publishing yet.
  //                 Upgraded to 'active' or 'secondary' on first
  //                 response-chunk.
  //   'active'    — sole flow permitted to publish onto
  //                 headless.semantic for this session. Exactly one
  //                 active flow at a time; the rest are secondary.
  //   'secondary' — concurrent flow whose bytes land while another
  //                 flow is already active. Parsed (for bookkeeping)
  //                 but never published. Would-be publishes are
  //                 dropped at the handleFrame entry point.
  //   'completed' — the SSE stream reached response.completed and
  //                 published its terminal semantic state, but the
  //                 HTTP transport has not emitted response-end yet.
  //                 This state exists because response.completed is
  //                 the semantic end of a Responses turn; waiting for
  //                 the socket close to release the active slot makes
  //                 client-executed tool calls such as MCP hide the
  //                 next flow when the transport end lags.
  //
  // WHY this exists: before the gate was added, a retry or warmup
  // could open a second POST /v1/responses while the first was still
  // streaming. Both flows called startTurn on the SHARED
  // SemanticChannel with distinct `resp_...` ids, and the channel's
  // single-slot activeTurnId thrashed between them. The renderer
  // then alternated between rendering one flow's blocks and the
  // other's — the user-visible 0/1/0/1 flicker below the prompt.
  // See docs/superpowers/plans/2026-04-17-codex-semantic-flicker-fix.md.
  attribution: 'candidate' | 'active' | 'secondary' | 'completed'
  // Semantic terminals commonly precede response-end. This bit prevents the
  // later transport close from falsely recording a second cancelled outcome.
  requestTerminalObserved: boolean
  // Non-null once the proxy reported a >=400 status for this flow. Set on the
  // `response` event, filled by the chunk branch, drained and classified at
  // `response-end`.
  //
  // WHY the body is buffered instead of being classified chunk-by-chunk: an
  // error document is small but still arrives split across arbitrary TCP
  // chunks, and a JSON body has no frame delimiter to parse incrementally
  // against. Waiting for response-end is the only point at which the document
  // is guaranteed complete, and a failed request has no live-streaming
  // deadline to miss.
  httpFailure: HttpFailure | null
}

// Watchdog thresholds for silent / leaked flows.
//
// WATCHDOG_STALE_MS — how long a flow can sit without any proxy
//   event (request, chunk, end, error) before the watchdog treats
//   it as dead. 60s is generous for legitimate deep-thinking or
//   image-generation responses: OpenAI's SSE stream emits heartbeat
//   deltas (`response.reasoning_summary_text.delta`,
//   `response.output_text.delta`, obfuscation events) regularly
//   during active streaming, and we've never seen a healthy flow go
//   more than a few seconds without at least ONE event. Anything
//   past 60s is almost certainly a dropped connection / proxy-side
//   stall / upstream crash that never surfaced an error frame.
//
//   The concrete scenario this guards against was observed in the
//   2026-04-23 debug bundle: a flow (`proxy-6`) got first-chunk
//   attribution ('active'), published `flow_selected`, emitted one
//   block_started / block_completed, then went silent. No
//   response-end, no response-error. activeFlowId stayed pinned to
//   proxy-6 for the rest of the session, so every subsequent
//   /responses POST (18 of them over 2+ minutes) got attributed
//   'secondary' at first-chunk and never published — effectively
//   freezing the live semantic view for the rest of the session.
//
// WATCHDOG_INTERVAL_MS — how often the watchdog wakes up. 10s is
//   short enough that a stale flow clears within ~70s of going
//   silent (60s threshold + up to 10s poll lag), but long enough
//   not to be a CPU sink. Event-loop timer; runs even during
//   proxy backpressure.
const WATCHDOG_STALE_MS = 60_000
const WATCHDOG_INTERVAL_MS = 10_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' ? value : undefined
}

function stringArrayField(record: Record<string, unknown> | null | undefined, key: string): string[] | undefined {
  const value = record?.[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

function stringRecordField(record: Record<string, unknown> | null | undefined, key: string): Record<string, string> | undefined {
  const value = asRecord(record?.[key])
  if (!value) return undefined
  const out: Record<string, string> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === 'string') out[entryKey] = entryValue
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseProviderWindowIdentity(
  headers: Record<string, string> | undefined,
): { providerSessionFingerprint: string; providerWindowGenerationId: string } | null {
  if (!headers) return null
  const raw = Object.entries(headers).find(([key]) =>
    key.toLowerCase() === 'x-codex-window-id')?.[1]
  if (!raw) return null
  // Recorded Codex 0.151 traffic uses `<session UUID>:<generation>`. Reject
  // rather than trim or partially copy unexpected values: a future header
  // shape must be reviewed before it enters the shareable observation stream.
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]{0,19})$/i.exec(raw)
  if (!match) return null
  return {
    // The same domain-separated transform is applied to session_meta in Agent
    // Code main. Equality survives for forensic joins, while a shareable
    // recording never contains the provider's raw thread UUID.
    providerSessionFingerprint: fingerprintProviderSession(match[1])!,
    providerWindowGenerationId: match[2]!,
  }
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return headers
    ? Object.keys(headers).some(key => key.toLowerCase() === name)
    : false
}

function isStartEvent(ev: Record<string, unknown>): ev is StartEvent {
  return (
    ev.kind === 'request' &&
    typeof ev.requestId === 'string' &&
    typeof ev.method === 'string' &&
    typeof ev.path === 'string' &&
    typeof ev.upstream === 'string'
  )
}

function isChunkEvent(ev: Record<string, unknown>): ev is ChunkEvent {
  return (
    ev.kind === 'response-chunk' &&
    typeof ev.requestId === 'string' &&
    typeof ev.path === 'string' &&
    typeof ev.size === 'number' &&
    Buffer.isBuffer(ev.chunk)
  )
}

function isResponseEvent(ev: Record<string, unknown>): ev is ResponseEvent {
  return (
    ev.kind === 'response' &&
    typeof ev.requestId === 'string' &&
    typeof ev.path === 'string' &&
    typeof ev.status === 'number'
  )
}

function isEndEvent(ev: Record<string, unknown>): ev is EndEvent {
  return (
    ev.kind === 'response-end' &&
    typeof ev.requestId === 'string' &&
    typeof ev.path === 'string' &&
    typeof ev.bytes === 'number'
  )
}

export class CodexResponsesAdapter {
  private readonly proxy: ResponsesProxy
  private readonly headless: CodexResponsesAdapterHeadless
  private readonly flows = new Map<string, FlowState>()
  // Monotonically increasing flow id — not path-derived because
  // the same path fires on every retry and we need stable keys.
  private nextFlowSeq = 1
  private attachedHandler: ((ev: Record<string, unknown>) => void) | null = null

  /**
   * How much per-request state this adapter is holding right now.
   *
   * WHY it exists (agent-code#369): main-process OOMs during long Codex runs
   * pointed at flow retention here, and nothing measured it. A host samples
   * this into its performance heartbeat, so a leak shows up as a number that
   * climbs across turns instead of as a crash. `bufferedChars` counts the
   * undrained SSE text across flows, the part that grows with response size.
   * Cheap on purpose: one pass over a map that is empty between turns.
   */
  diagnostics(): { flows: number; bufferedChars: number } {
    let bufferedChars = 0
    for (const flow of this.flows.values()) bufferedChars += flow.buffer.length
    return { flows: this.flows.size, bufferedChars }
  }
  // flowId of the one flow that currently owns publishing rights on
  // headless.semantic. Null when nothing is streaming. Cleared by
  // response-end / response-error / upstream-error for the active
  // flow. See FlowState.attribution for the full rationale.
  private activeFlowId: string | null = null
  // Watchdog timer handle. Wakes every WATCHDOG_INTERVAL_MS,
  // looks for flows whose lastEventAt is older than
  // WATCHDOG_STALE_MS, and forcibly releases them. Armed in
  // attach(), cleared in detach().
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  // When the watchdog last ran. A run that arrives far later than its interval
  // means the process was frozen (the machine slept), and every flow looks
  // stale at that moment for the same reason — see runWatchdog.
  private lastWatchdogRunAt: number | null = null

  constructor(proxy: ResponsesProxy, headless: CodexResponsesAdapterHeadless) {
    this.proxy = proxy
    this.headless = headless
  }

  attach(): void {
    if (this.attachedHandler) return
    this.attachedHandler = ev => {
      try {
        this.onProxyEvent(ev)
      } catch (err) {
        // Adapter failures must NOT crash the proxy pipeline.
        // Log to console and move on; the next chunk usually
        // re-syncs the stream state. If it doesn't, we lose
        // semantic fidelity for this turn but the user still
        // sees raw output via the rollout path.
        console.warn('[CodexResponsesAdapter] parse error:', err)
      }
    }
    this.proxy.on('event', this.attachedHandler)
    // Arm the watchdog. `unref` so it doesn't keep the Node
    // process alive during shutdown — the adapter gets detached
    // explicitly but a stray timer after detach is possible in
    // testing/embedded contexts.
    this.watchdogTimer = setInterval(() => {
      try {
        this.runWatchdog()
      } catch (err) {
        console.warn('[CodexResponsesAdapter] watchdog error:', err)
      }
    }, WATCHDOG_INTERVAL_MS)
    this.watchdogTimer.unref?.()
    this.lastWatchdogRunAt = Date.now()
  }

  detach(): void {
    if (!this.attachedHandler) return
    this.proxy.off('event', this.attachedHandler)
    this.attachedHandler = null
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    // A teardown is an observable cancellation, not disappearance. This is
    // especially important for requests that never produced a first chunk:
    // without the row, bundle analysis cannot separate "Codex never sent it"
    // from "the adapter stopped while it was pending".
    for (const flow of this.flows.values()) {
      this.publishRequestTerminal(flow, 'cancelled', 'adapter-detached')
    }
    // Drop any in-flight flow bookkeeping. A session restart that re-attaches
    // a new adapter shouldn't see residual state.
    this.flows.clear()
    this.activeFlowId = null
  }

  private markFlowTerminal(
    flow: FlowState,
    phase: 'completed' | 'failed' | 'incomplete',
  ): void {
    // WHY centralize terminal cleanup instead of only deleting flows on
    // transport-level response-end: the Responses API has semantic terminal
    // events (`completed`, `failed`, `incomplete`) that can arrive before the
    // proxy observes socket closure, and in the recent heap incidents the
    // socket closure path was exactly what lagged or went missing. Once a
    // terminal SSE event lands, this flow must stop owning the active slot and
    // must stop accepting late chunk bytes into `flow.buffer`; otherwise every
    // follow-up request is demoted to secondary until the watchdog fires, and
    // late trailers/keepalives can keep a dead flow alive under memory pressure.
    if (this.activeFlowId === flow.flowId) {
      this.activeFlowId = null
    }
    this.publishRequestTerminal(flow, phase, 'semantic-terminal')
    flow.attribution = 'completed'
    // WHY the flow is released HERE and not left for response-end or the
    // watchdog (agent-code#369): in recorded Codex 0.157 traffic about half of
    // all /v1/responses exchanges never get a response-end, because the
    // client closes the stream after reading response.completed (16 of 32 in
    // the source session of testing/fixtures/flow-retention). Each of those
    // FlowState objects, with its fullText, blocks and tool accumulators, then
    // stayed in `flows` until the watchdog, which is the
    // "watchdog releasing proxy-* (attribution=completed ...)" line in the
    // OOM breadcrumbs. After this point nothing reads the flow: the turn was
    // finished above the call, late chunks and a late response-end look the
    // flow up by request id and return when it is gone, and
    // publishRequestTerminal is idempotent per flow.
    flow.buffer = ''
    this.flows.delete(flow.flowId)
  }

  private publishRequestObservation(
    flow: FlowState,
    phase: 'created' | 'selected' | 'ignored',
    cause: 'request-created' | 'first-chunk' | 'active-at-request' | 'concurrent-active',
    selected?: boolean,
  ): void {
    this.headless.semantic.publishProviderRequest({
      requestId: flow.requestId,
      flowId: flow.flowId,
      phase,
      cause,
      subagentHeaderPresent: flow.subagentHeaderPresent,
      ...(selected === undefined ? {} : { selected }),
      ...(flow.providerSessionFingerprint
        ? { providerSessionFingerprint: flow.providerSessionFingerprint }
        : {}),
      ...(flow.providerWindowGenerationId
        ? { providerWindowGenerationId: flow.providerWindowGenerationId }
        : {}),
    })
  }

  private publishRequestTerminal(
    flow: FlowState,
    phase: 'completed' | 'failed' | 'incomplete' | 'cancelled',
    cause:
      | 'semantic-terminal'
      | 'transport-ended-before-semantic-terminal'
      | 'response-error'
      | 'upstream-error'
      | 'watchdog-timeout'
      | 'adapter-detached'
      | 'http-error'
      | 'system-suspended',
  ): void {
    if (flow.requestTerminalObserved) return
    flow.requestTerminalObserved = true
    this.headless.semantic.publishProviderRequest({
      requestId: flow.requestId,
      flowId: flow.flowId,
      phase,
      cause,
      subagentHeaderPresent: flow.subagentHeaderPresent,
      ...(flow.providerSessionFingerprint
        ? { providerSessionFingerprint: flow.providerSessionFingerprint }
        : {}),
      ...(flow.providerWindowGenerationId
        ? { providerWindowGenerationId: flow.providerWindowGenerationId }
        : {}),
    })
  }

  private hydrateResponseIdFromFrame(flow: FlowState, parsed: Record<string, unknown>): void {
    if (flow.responseId) return
    const response = asRecord(parsed.response)
    const id = stringField(response, 'id') ?? null
    if (id) flow.responseId = id
  }

  private onProxyEvent(ev: Record<string, unknown>): void {
    const kind = ev.kind
    // Only main `/responses` (the streaming SSE turn endpoint) produces
    // semantic events. Skip every sidecar Codex routes through the same
    // proxy:
    //   - /responses/compact      conversation compaction (unary JSON)
    //   - /memories/trace_summarize  memory summarization (unary JSON)
    //   - /realtime/calls         WebRTC media setup
    //   - /models                 quota/health
    //   - any /v1/ path we forward but haven't classified
    //
    // The previous filter was `path.includes('/responses')` — a
    // substring match that ALSO accepted '/responses/compact'. In
    // practice the unary JSON payload from compact wouldn't drive the
    // SSE parser past its first frame, so the leak was masked, but the
    // attribution state machine was still being touched by every
    // compact request. Switch to the typed `endpoint` label the proxy
    // already emits (responsesProxy.classifyEndpoint) so the filter is
    // intent-driven, not URL-pattern-driven. Old proxies that don't
    // send `endpoint` fall back to the legacy substring check so a
    // version-mismatched submodule pair still works.
    const endpoint = typeof ev.endpoint === 'string' ? ev.endpoint : null
    if (endpoint !== null) {
      if (endpoint !== 'responses') return
    } else {
      const path = typeof ev.path === 'string' ? ev.path : ''
      if (!path.includes('/responses')) return
      // Belt-and-suspenders: even with the legacy substring path, drop
      // /responses/compact explicitly so we don't accidentally let
      // compact requests touch flow attribution if the typed label is
      // missing for some reason.
      if (path.includes('/responses/compact')) return
    }

    if (kind === 'request') {
      const req = isStartEvent(ev) ? ev : null
      if (!req) return
      if (req.method !== 'POST') return
      const providerSessionId = req.request_shape?.provider_session_id
      const isSubagent =
        typeof req.headers?.['x-openai-subagent'] === 'string' ||
        typeof req.headers?.['x-codex-parent-thread-id'] === 'string'
      if (typeof providerSessionId === 'string' && !isSubagent) {
        // WHY the semantic adapter forwards identity but does not arbitrate it:
        // this is already the single typed consumer of per-session proxy
        // request events, so adding a second listener would create ordering and
        // teardown races. CodexHeadless owns rollout I/O and delegates exact
        // validation/leases to the transcript layer; this call transfers only
        // a candidate string, never a path or permission to tail.
        this.headless.observeProviderThreadIdentity(providerSessionId)
      }
      // Mint a flow in 'candidate' state. Don't publish anything
      // onto the shared semantic channel yet — we need to see the
      // first response chunk to decide whether this flow gets to be
      // the one 'active' flow or is demoted to 'secondary' because
      // another flow already owns the slot.
      //
      // WHY defer publishFlowSelected until first chunk (and not
      // fire it at request time as the earlier implementation did):
      // request-time attribution can't distinguish "this is the only
      // flow" from "this is the Nth concurrent flow". The upstream
      // may also never actually respond to a POST (cancelled warmup,
      // timeout, auth flow), and we don't want a `flow_selected`
      // event for a flow that never produces any bytes.
      const flowId = `proxy-${this.nextFlowSeq++}`
      const requestHeaders = stringRecordField(ev, 'headers')
      const providerWindow = parseProviderWindowIdentity(requestHeaders)
      const flow: FlowState = {
        flowId,
        requestId: req.requestId,
        path: req.path,
        providerSessionFingerprint: providerWindow?.providerSessionFingerprint ?? null,
        providerWindowGenerationId: providerWindow?.providerWindowGenerationId ?? null,
        subagentHeaderPresent: hasHeader(requestHeaders, 'x-openai-subagent'),
        responseId: null,
        activeFlowIdAtRequest: this.activeFlowId,
        buffer: '',
        decoder: new StringDecoder('utf8'),
        fullText: '',
        messageBlockIndex: null,
        blocks: new Map(),
        turnOpened: false,
        pendingToolUses: [],
        lastObfuscation: null,
        lastEventAt: Date.now(),
        attribution: 'candidate',
        requestTerminalObserved: false,
        httpFailure: null,
      }
      this.flows.set(flowId, flow)
      this.publishRequestObservation(flow, 'created', 'request-created')
      return
    }

    if (kind === 'response') {
      const responseEv = isResponseEvent(ev) ? ev : null
      if (!responseEv) return
      const flow = this.findFlowByRequestId(responseEv.requestId)
      // status < 400 is the overwhelmingly common case (a normal SSE turn).
      // Leave those flows completely untouched so nothing about the healthy
      // path depends on this branch having run.
      if (!flow || responseEv.status < 400) return
      // A non-2xx /responses reply is a JSON error document, not an SSE
      // stream. Buffer it whole and classify at response-end; the SSE frame
      // drain would otherwise see a body with no `data:` lines and publish
      // nothing, which is how usage limits used to vanish into a timeout.
      flow.httpFailure = {
        status: responseEv.status,
        // stringRecordField drops non-string values rather than casting the
        // whole bag, so a malformed proxy event can't smuggle objects into
        // the header lookups the classifier does below.
        headers: stringRecordField(ev, 'headers') ?? {},
        body: '',
        truncated: false,
      }
      return
    }

    if (kind === 'response-chunk') {
      const chunkEv = isChunkEvent(ev) ? ev : null
      if (!chunkEv) return
      const flow = this.findFlowByRequestId(chunkEv.requestId)
      if (!flow) return

      // A flow that already reached response.completed is semantically
      // done. Late chunks for it (SSE keepalives, trailers, a retry
      // tail) must NOT be appended or refresh lastEventAt: completed
      // flows never drain (only 'active' does), so appending would
      // leak flow.buffer, and refreshing lastEventAt would keep the
      // watchdog from ever reaping the finished flow. Drop them. (A flow
      // that reached a semantic terminal is already gone from `flows`, see
      // markFlowTerminal; this guard covers any other 'completed' flow.)
      if (flow.attribution === 'completed') return

      // Error-document bytes. Collect and stop here — deliberately BEFORE
      // first-chunk attribution, because a request that already failed at the
      // HTTP layer must never claim the single active-flow slot. If it did,
      // the retry that Codex issues immediately afterwards would be demoted
      // to 'secondary' and its whole turn would go unpublished.
      if (flow.httpFailure) {
        const remaining = MAX_FAILURE_BODY_CHARS - flow.httpFailure.body.length
        if (remaining > 0) {
          // Plain toString is safe where the SSE path needs StringDecoder: the
          // error document is JSON, and JSON.parse is the only consumer. A
          // split multi-byte codepoint inside an error *message* would corrupt
          // one glyph of display text, which is not worth carrying a second
          // decoder for; the classification itself is ASCII-only fields.
          const text = chunkEv.chunk.toString('utf8')
          // Slice rather than append-then-check, so one enormous chunk can't
          // land in memory in full before the cap notices.
          flow.httpFailure.body += text.length > remaining ? text.slice(0, remaining) : text
          if (flow.httpFailure.body.length >= MAX_FAILURE_BODY_CHARS) {
            flow.httpFailure.truncated = true
          }
          flow.lastEventAt = Date.now()
        }
        // Past the cap, deliberately do NOT refresh lastEventAt. An upstream
        // that streams an unbounded error body would otherwise keep this flow
        // permanently fresh and permanently un-reapable: response-end may
        // never come, and the watchdog is the only thing left that can free
        // the flow. Letting it go stale is the whole point of stopping here.
        return
      }

      flow.lastEventAt = Date.now()

      // First-chunk attribution. Any /responses chunk is a reliable
      // "this is live streaming" signal — request headers don't
      // distinguish warmups or non-SSE calls from the real turn.
      //
      // Promotion rule: first chunker wins the slot. Concurrent flows
      // arriving while another flow is active get marked secondary
      // and publish flow_ignored for observability. This matches
      // ClaudeProxyAdapter's activeStreamingFlowId pattern 1:1.
      if (flow.attribution === 'candidate') {
        if (flow.activeFlowIdAtRequest !== null) {
          flow.attribution = 'secondary'
          this.headless.semantic.publishFlowIgnored({
            requestId: flow.requestId,
            flowId: flow.flowId,
            reason: `request started while active flow ${flow.activeFlowIdAtRequest} owned the slot`,
            source: 'proxy',
          })
          this.publishRequestObservation(flow, 'ignored', 'active-at-request', false)
        } else if (this.activeFlowId === null) {
          flow.attribution = 'active'
          this.activeFlowId = flow.flowId
          this.headless.semantic.publishFlowSelected({
            requestId: flow.requestId,
            flowId: flow.flowId,
            turnId: null,
            reason: 'first-chunk (no competing active flow)',
            source: 'proxy',
          })
          this.publishRequestObservation(flow, 'selected', 'first-chunk', true)
          // First-chunk promotion → emit 'requesting'. Like the Claude
          // adapter, we don't have a real turnId yet (arrives on the
          // `response.created` frame); null signals "attached to the
          // session, not a specific turn" and is upgraded once the real
          // id lands.
          this.publishPhase(flow, 'requesting')
        } else {
          flow.attribution = 'secondary'
          this.headless.semantic.publishFlowIgnored({
            requestId: flow.requestId,
            flowId: flow.flowId,
            reason: `concurrent with active flow ${this.activeFlowId}`,
            source: 'proxy',
          })
          this.publishRequestObservation(flow, 'ignored', 'concurrent-active', false)
        }
      }

      // decoder.write holds any trailing partial multi-byte sequence
      // until the next chunk arrives — see the FlowState.decoder
      // comment for why a plain toString('utf-8') corrupts non-ASCII.
      //
      // Normalize line endings at the boundary: the SSE spec allows
      // \r\n or \n line terminators, and some corporate proxies /
      // TLS-terminating CDNs rewrite the stream with \r\n. The frame
      // splitter below only looks for \n\n, so we canonicalize here
      // (dropping bare \r is safe because SSE field payloads never
      // contain them). Without this, a CRLF upstream emits zero
      // semantic events for an entire turn because `\n\n` never
      // appears in the buffer.
      const decoded = flow.decoder.write(chunkEv.chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      // Only the active flow feeds the semantic channel. Secondary
      // flows still pass through StringDecoder so split UTF-8 state
      // remains internally consistent, but they no longer retain the
      // decoded SSE text in `flow.buffer` or pay frame/JSON parse cost.
      if (flow.attribution !== 'active') return

      flow.buffer += decoded
      this.drainFrames(flow)
      return
    }

    if (kind === 'response-end') {
      const endEv = isEndEvent(ev) ? ev : null
      if (!endEv) return
      const flow = this.findFlowByRequestId(endEv.requestId)
      if (!flow) return
      flow.lastEventAt = Date.now()

      // The failed-request terminal. Runs instead of the SSE teardown below,
      // not in addition to it: there is no frame buffer to drain and no
      // upstream turn id to seal against, so everything past this point would
      // be a no-op that ends by recording a misleading 'cancelled' outcome for
      // a request the server explicitly refused.
      if (flow.httpFailure) {
        const classified = classifyHttpFailure(flow.httpFailure)
        this.headless.semantic.publishApiError({
          // Usually null: an HTTP failure means upstream never sent
          // response.created, so no `resp_...` id exists to attach to. The
          // consumer keys this off the session, not the turn.
          turnId: flow.responseId,
          // The proxy already names every attempt. Reuse that identity instead
          // of requiring consumers to dedupe by timestamps or error prose.
          requestId: flow.requestId,
          rateLimitReachedType: classified.rateLimitReachedType,
          errorType: classified.errorType,
          message: classified.message,
          retryAfterMs: classified.retryAfterMs,
          status: flow.httpFailure.status,
          resetsAt: classified.resetsAt,
          limitId: classified.limitId,
          limitName: classified.limitName,
          source: 'proxy',
        })
        // Defensive: a turn can only be open here if a previous 2xx attempt on
        // the SAME requestId opened one, which the proxy's per-call requestId
        // makes impossible today. Seal it anyway rather than leave a renderer
        // spinning if that invariant ever changes.
        if (flow.turnOpened && flow.responseId) {
          this.headless.semantic.finishTurn({ turnId: flow.responseId, fullText: flow.fullText || undefined, source: 'proxy', confidence: 'fallback' })
        }
        if (this.activeFlowId === flow.flowId) this.activeFlowId = null
        this.publishRequestTerminal(flow, 'failed', 'http-error')
        this.flows.delete(flow.flowId)
        return
      }

      // Flush any bytes the decoder was holding back (i.e. a trailing
      // partial sequence that never got its continuation). In healthy
      // streams this is empty; on truncated streams we'd rather see
      // a stray U+FFFD than silently swallow the tail.
      flow.buffer += flow.decoder.end()
      // Best-effort flush — upstream may not send a terminator. Skip
      // the frame drain entirely for non-active flows (nothing reads
      // their parsed state).
      if (flow.attribution === 'active') {
        this.drainFrames(flow)
      }
      // If we got this far without seeing response.completed,
      // close the turn to avoid a dangling in-progress indicator.
      // The rollout source will correct the final text.
      if (flow.turnOpened && flow.responseId) {
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'medium',
        })
      }
      // Release the active-flow slot so the NEXT flow's first chunk
      // can promote itself. Without this, a stuck activeFlowId would
      // starve every subsequent turn's attribution path.
      if (this.activeFlowId === flow.flowId) {
        this.activeFlowId = null
      }
      this.publishRequestTerminal(
        flow,
        'cancelled',
        'transport-ended-before-semantic-terminal',
      )
      this.flows.delete(flow.flowId)
      return
    }

    if (kind === 'response-error' || kind === 'upstream-error') {
      // Treat like an end: seal any open turn so the renderer
      // isn't stuck in "streaming" state, then drop the flow.
      const errReqId = typeof ev.requestId === 'string' ? ev.requestId : ''
      const flow = this.findFlowByRequestId(errReqId)
      if (!flow) return
      flow.lastEventAt = Date.now()
      if (flow.turnOpened && flow.responseId) {
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'fallback',
        })
      }
      // Same rationale as response-end above: release the slot so
      // the next flow can claim it.
      if (this.activeFlowId === flow.flowId) {
        this.activeFlowId = null
      }
      this.publishRequestTerminal(
        flow,
        'failed',
        kind === 'response-error' ? 'response-error' : 'upstream-error',
      )
      this.flows.delete(flow.flowId)
    }
  }

  // Watchdog sweep. Called every WATCHDOG_INTERVAL_MS.
  //
  // The only failure mode this guards against is a flow that went
  // silent without a terminator event (no response-end, no
  // response-error, no upstream-error). Healthy flows always see
  // SSE heartbeats during active streaming, so a gap > WATCHDOG_STALE_MS
  // means the upstream connection is dead-for-our-purposes and
  // holding onto `activeFlowId` just starves every subsequent flow's
  // first-chunk promotion path.
  //
  // The sweep does two things:
  //
  //   1. For the ACTIVE flow: if it's been silent too long, seal any
  //      open turn (fallback confidence — we don't know if this is
  //      the real end), release `activeFlowId`, and drop the flow.
  //      Matches the `response-error` branch's cleanup exactly; the
  //      caller side sees the same sequence of events either way.
  //
  //   2. For CANDIDATE / SECONDARY flows: if they've been silent too
  //      long AND they're not the active slot-holder, just drop them.
  //      Memory-pressure insurance — a proxy retry burst can leave
  //      dozens of candidates that never chunked; they don't starve
  //      anything but they sit in `this.flows` forever.
  //
  // Intentionally no "seal turn" for non-active flows — they never
  // called startTurn, so there's nothing to seal.
  private runWatchdog(): void {
    const now = Date.now()
    const previousRunAt = this.lastWatchdogRunAt
    this.lastWatchdogRunAt = now
    // A tick this late means the interval could not fire: the process was
    // frozen, almost always because the machine slept (#963). Every flow is
    // "silent" for the same reason, so releasing now would close a slept-through
    // turn as an anonymous watchdog timeout — the host could no longer tell the
    // user it was interrupted by sleep, and a stream that survived the sleep
    // would be cut before it can deliver its next chunk. Defer exactly one tick:
    // the host's suspension notice (sealFlowsSilentSince) arrives in the
    // meantime, and without one the next tick releases as before.
    if (previousRunAt !== null && now - previousRunAt > WATCHDOG_STALE_MS) return
    const staleFlows: FlowState[] = []
    for (const flow of this.flows.values()) {
      if (now - flow.lastEventAt > WATCHDOG_STALE_MS) {
        staleFlows.push(flow)
      }
    }
    for (const flow of staleFlows) {
      const silentFor = now - flow.lastEventAt
      const isActive = this.activeFlowId === flow.flowId
      // eslint-disable-next-line no-console
      console.warn(
        `[CodexResponsesAdapter] watchdog releasing ${flow.flowId} ` +
          `(attribution=${flow.attribution} silent=${silentFor}ms)`,
      )
      if (isActive && flow.turnOpened && flow.responseId) {
        // Seal the turn so the renderer doesn't sit in "streaming"
        // state forever. `fallback` confidence signals to consumers
        // that the end reason is synthesized, not upstream-attested.
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'fallback',
        })
      }
      if (isActive) {
        this.activeFlowId = null
      }
      this.publishRequestTerminal(flow, 'cancelled', 'watchdog-timeout')
      this.flows.delete(flow.flowId)
    }
  }

  /** Seal every flow that has had no proxy event since `silentSince` (#963).
   *
   *  WHY this exists: when the machine sleeps, the stream's connection dies with
   *  it. The watchdog would eventually release such a flow, but as an anonymous
   *  timeout, and without publishing `idle` — so a pane sitting in
   *  `awaiting-tool` or any phase the `turn_completed` bridge refuses to leave kept
   *  its pre-sleep clock. The host calls this as soon as it learns the machine was
   *  suspended, passing the moment the suspension began.
   *
   *  WHY immediately (unlike Claude's host grace period): a Codex retry cannot
   *  claim the active slot while a dead flow still holds it — follow-ups are
   *  demoted to secondary until the slot is released — so waiting would only
   *  delay the retry.
   *
   *  Only flows silent for the WHOLE window are touched; any event after the
   *  suspension began proves the stream survived. A completed flow (a client tool
   *  is running, phase `awaiting-tool`) has no open turn and is dropped without a
   *  phase change: the tool's process was suspended too and usually completes. */
  sealFlowsSilentSince(
    silentSince: number,
    interruption: NonNullable<SemanticTurnStoppedEvent['interruption']>,
  ): void {
    for (const flow of [...this.flows.values()]) {
      if (flow.lastEventAt > silentSince) continue
      const isActive = this.activeFlowId === flow.flowId
      if (isActive && flow.turnOpened && flow.responseId) {
        this.headless.semantic.publishTurnStopped({
          turnId: flow.responseId,
          stopReason: null,
          interruption,
          source: 'proxy',
          confidence: 'medium',
        })
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'fallback',
        })
        flow.turnOpened = false
      }
      if (isActive) {
        // Publish before releasing: publishPhase only speaks for the active flow.
        this.publishPhase(flow, 'idle')
        this.activeFlowId = null
      }
      this.publishRequestTerminal(flow, 'cancelled', 'system-suspended')
      this.flows.delete(flow.flowId)
    }
  }

  // Route chunks by requestId. The proxy mints a monotonic requestId
  // per HTTP call and stamps every request/response/chunk/end/error
  // event with it, so overlapping retries to the same path never
  // collide — each retry gets its own requestId and its own flow.
  private findFlowByRequestId(requestId: string): FlowState | null {
    if (!requestId) return null
    for (const flow of this.flows.values()) {
      if (flow.requestId === requestId) return flow
    }
    return null
  }

  // SSE framing: events are separated by blank lines ("\n\n"). A
  // single frame is a sequence of "field: value\n" lines. We only
  // care about the `data:` field(s); `event:` is informational but
  // every OpenAI Responses frame sets `data.type` redundantly, so
  // relying on the JSON payload keeps the parser simpler.
  private drainFrames(flow: FlowState): void {
    let idx = flow.buffer.indexOf('\n\n')
    while (idx >= 0) {
      const frame = flow.buffer.slice(0, idx)
      flow.buffer = flow.buffer.slice(idx + 2)
      this.handleFrame(flow, frame)
      idx = flow.buffer.indexOf('\n\n')
    }
  }

  /** Publish a stream-phase event on behalf of this flow. Suppressed
   *  for secondary flows so a warmup / retry never flips the renderer's
   *  phase out from under the active turn. Channel-level dedupe swallows
   *  no-op (phase, turnId, toolUseId) repeats, so we don't re-check here. */
  private publishPhase(
    flow: FlowState,
    phase: StreamPhase,
    extras: { toolName?: string; toolUseId?: string } = {},
  ): void {
    if (flow.attribution !== 'active') return
    this.headless.semantic.publishStreamPhase({
      turnId: flow.responseId,
      phase,
      toolName: extras.toolName,
      toolUseId: extras.toolUseId,
      source: 'proxy',
      confidence: 'high',
    })
  }

  private handleFrame(flow: FlowState, rawFrame: string): void {
    // Collect all `data:` lines (a frame can have multiple, joined
    // by newlines per the SSE spec). Drop `event:`, `id:`, `retry:`
    // — we don't need them.
    //
    // WHY silently drop data-less frames instead of logging/upgrading
    // them: the OpenAI Responses SSE wire always pairs `event: ...`
    // with a `data: {...}` payload; a frame with only `event:` or
    // only a comment (`: keepalive`) carries no state we can fold
    // into the semantic channel. If upstream ever introduces a
    // data-less signal (e.g. a heartbeat that hints at quota
    // throttling) we'd want to surface it, but until that exists
    // dropping them is the right call — anything else just generates
    // noise in the event log.
    const dataLines: string[] = []
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      else if (line.startsWith('data:')) dataLines.push(line.slice(5))
    }
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n')
    // The keepalive frame `data: [DONE]` isn't used by Responses
    // SSE (it's a Chat Completions convention) but be defensive.
    if (payload.trim() === '[DONE]') return

    let parsed: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(payload)
      const record = asRecord(value)
      if (!record) {
        this.headless.semantic.publishStreamError({
          turnId: flow.responseId,
          errorType: 'json_parse_error',
          message: 'SSE data frame was not a JSON object',
          source: 'proxy',
        })
        return
      }
      parsed = record
    } catch (err) {
      // Malformed SSE data frame. In normal streams this never happens;
      // it's been observed when an upstream CDN buffers bytes incorrectly
      // or a hot-path retry corrupts the stream. We surface the incident
      // as a stream_error (soft — more bytes may follow) so the consumer
      // can show a diagnostic badge instead of going silently blind. The
      // turn is not torn down; subsequent frames will usually re-sync.
      this.headless.semantic.publishStreamError({
        turnId: flow.responseId,
        errorType: 'json_parse_error',
        message: err instanceof Error ? err.message : String(err),
        source: 'proxy',
      })
      return
    }

    const t = typeof parsed.type === 'string' ? parsed.type : ''
    switch (t) {
      case 'response.created':
      case 'response.in_progress': {
        const response = asRecord(parsed.response)
        const id = stringField(response, 'id') ?? null
        if (!id) return
        flow.responseId = id
        if (!flow.turnOpened) {
          this.headless.semantic.startTurn({
            turnId: id,
            requestId: flow.requestId,
            flowId: flow.flowId,
            role: 'assistant',
            source: 'proxy',
            confidence: 'high',
          })
          flow.turnOpened = true
        }
        // Re-emit `requesting` now that we have a real turnId. Channel
        // dedupe would drop a no-op repeat with the same params, but
        // the turnId has changed from null → id so this is new info.
        this.publishPhase(flow, 'requesting')
        return
      }

      case 'response.output_item.added': {
        if (!flow.turnOpened || !flow.responseId) return
        const item = asRecord(parsed.item)
        const itemId = stringField(item, 'id') ?? null
        const itemType = stringField(item, 'type') ?? ''
        const outputIndex = numberField(parsed, 'output_index') ?? 0
        if (!itemId) return

        const kind = mapItemTypeToBlockKind(itemType)
        const callId = stringField(item, 'call_id')
        const toolName = stringField(item, 'name')
        const phase = extractMessagePhase(item ?? undefined)
        const status = stringField(item, 'status')

        flow.blocks.set(itemId, {
          index: outputIndex,
          kind,
          callId,
          toolName,
          textSoFar: '',
          summarySoFar: '',
          fullSoFar: '',
          inputSoFar: '',
        })
        if (kind === 'message' && flow.messageBlockIndex === null) {
          flow.messageBlockIndex = outputIndex
        }

        // Publish a block_started skeleton. Renderers mount a card
        // immediately (spinner for tool calls, empty bubble for text)
        // and fill it in from later deltas / block_completed.
        this.headless.semantic.publishBlockStarted({
          turnId: flow.responseId,
          blockIndex: outputIndex,
          itemId,
          kind,
          toolName,
          callId,
          messagePhase: phase,
          status,
          source: 'proxy',
        })

        // Phase transition — same table as Claude's adapter, adapted
        // to the Codex ResponseItem taxonomy. Message → responding,
        // reasoning → thinking, any tool-call variant → tool-input.
        // `_output` variants are skipped here because they arrive on
        // the NEXT assistant flow as results; there's no phase change
        // within this flow for them.
        switch (kind) {
          case 'message':
            this.publishPhase(flow, 'responding')
            break
          case 'reasoning':
            this.publishPhase(flow, 'thinking')
            break
          case 'function_call':
          case 'custom_tool_call':
          case 'local_shell_call':
          case 'web_search_call':
          case 'image_generation_call':
          case 'tool_search_call':
            this.publishPhase(flow, 'tool-input', {
              toolName,
              toolUseId: callId,
            })
            break
          // Other kinds (outputs, unknown) — leave phase as-is.
        }
        return
      }

      case 'response.output_text.delta': {
        if (!flow.turnOpened || !flow.responseId) return
        const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
        if (!delta) return
        flow.fullText += delta
        flow.lastObfuscation =
          typeof parsed.obfuscation === 'string' ? parsed.obfuscation : flow.lastObfuscation

        // Turn-level delta (legacy applyDelta) — consumers that only
        // care about "the whole reply as one string" still get it here.
        this.headless.semantic.applyDelta({
          turnId: flow.responseId,
          textDelta: delta,
          fullText: flow.fullText,
          source: 'proxy',
          confidence: 'high',
        })

        // Per-block delta — higher-fidelity consumers (renderers that
        // want to distinguish multiple message blocks in a single turn,
        // e.g. commentary + final_answer) use this.
        //
        // The wire delivers `item_id` on each delta so we can look up
        // the specific Message block this chunk belongs to. If the id
        // isn't present (older schema) we fall back to the first
        // message block we saw, which matches pre-multi-message
        // behaviour.
        const itemId = stringField(parsed, 'item_id') ?? null
        const block = itemId ? flow.blocks.get(itemId) : null
        if (block && block.kind === 'message') {
          block.textSoFar += delta
          this.headless.semantic.publishTextDelta({
            turnId: flow.responseId,
            blockIndex: block.index,
            itemId: itemId ?? undefined,
            textDelta: delta,
            textSoFar: block.textSoFar,
            source: 'proxy',
          })
        }
        return
      }

      case 'response.custom_tool_call_input.delta': {
        if (!flow.turnOpened || !flow.responseId) return
        const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
        if (!delta) return
        const itemId = stringField(parsed, 'item_id') ?? null
        const block = itemId ? flow.blocks.get(itemId) : null
        if (!block || block.kind !== 'custom_tool_call') return
        block.inputSoFar += delta

        // WHY this is a semantic event, not renderer special-casing:
        // the debug bundle 2026-05-16T19-21-30 showed the wire already
        // had hundreds of apply_patch input deltas while the UI's live
        // block stayed at inputJson: "". That means the renderer had the
        // right abstraction but the adapter dropped the only live payload
        // source. Forwarding the accumulator here keeps apply_patch,
        // future write/edit tools, and any non-React consumer on the same
        // block lifecycle instead of teaching each surface to decode raw
        // Responses SSE frames.
        this.headless.semantic.publishToolInputDelta({
          turnId: flow.responseId,
          blockIndex: block.index,
          itemId: itemId ?? undefined,
          toolName: block.toolName ?? '',
          toolUseId: block.callId ?? itemId ?? '',
          partialJson: delta,
          inputJsonSoFar: block.inputSoFar,
          source: 'proxy',
        })
        return
      }

      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        if (!flow.turnOpened || !flow.responseId) return
        const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
        if (!delta) return
        const itemId = stringField(parsed, 'item_id') ?? null
        const block = itemId ? flow.blocks.get(itemId) : null
        if (!block || block.kind !== 'reasoning') return

        // Distinguish the two reasoning tracks — summary (user-facing
        // digest) vs full (detailed chain-of-thought). Each has its own
        // accumulator so a consumer that only wants to show the summary
        // doesn't inadvertently display the full reasoning.
        const isSummary = t === 'response.reasoning_summary_text.delta'
        const track: 'summary' | 'full' = isSummary ? 'summary' : 'full'
        const upstreamIndex =
          numberField(parsed, 'summary_index') ?? numberField(parsed, 'content_index') ?? 0
        if (isSummary) block.summarySoFar += delta
        else block.fullSoFar += delta

        // PREVIOUSLY: both deltas were parse-dropped with a comment
        // arguing rollout would render reasoning eventually. That's
        // correct for a post-mortem view but leaves the live turn
        // dark during a thinking pause — the user sees the composer
        // idle for seconds before rollout catches up. Publishing live
        // is strictly better; rollout's own reducer will emit
        // source_changed when it reconciles.
        this.headless.semantic.publishThinkingDelta({
          turnId: flow.responseId,
          blockIndex: block.index,
          itemId: itemId ?? undefined,
          track,
          thinkingDelta: delta,
          thinkingSoFar: isSummary ? block.summarySoFar : block.fullSoFar,
          index: upstreamIndex,
          source: 'proxy',
        })
        return
      }

      case 'response.output_item.done': {
        if (!flow.turnOpened || !flow.responseId) return
        const item = asRecord(parsed.item) ?? {}
        const itemId = stringField(item, 'id') ?? null
        const outputIndex =
          numberField(parsed, 'output_index') ??
          (itemId
              ? (flow.blocks.get(itemId)?.index ?? 0)
              : 0)
        const kind = mapItemTypeToBlockKind(
          stringField(item, 'type') ?? '',
        )
        const block = itemId ? flow.blocks.get(itemId) : null

        // Dispatch per-variant. Every variant ultimately publishes ONE
        // block_completed — the optional fields on SemanticBlockCompletedEvent
        // carry the variant-specific payload. Consumers pattern-match on
        // `kind` and read the fields they care about.
        const base = {
          turnId: flow.responseId,
          blockIndex: outputIndex,
          itemId: itemId ?? undefined,
          kind,
          status:
            stringField(item, 'status'),
          raw: item,
          source: 'proxy' as const,
        }

        switch (kind) {
          case 'message': {
            const text = extractMessageText(item) ?? block?.textSoFar ?? ''
            this.headless.semantic.publishBlockCompleted({ ...base, text })
            return
          }
          case 'reasoning': {
            const summary = extractReasoningSummary(item) ?? block?.summarySoFar
            const full = extractReasoningContent(item) ?? block?.fullSoFar
            this.headless.semantic.publishBlockCompleted({
              ...base,
              reasoningSummary: summary,
              reasoningText: full,
            })
            return
          }
          case 'function_call': {
            const argumentsJson = stringField(item, 'arguments') ?? ''
            const parsedArgs = tryParseObject(argumentsJson)
            const toolName = stringField(item, 'name')
            const callId = stringField(item, 'call_id')
            this.headless.semantic.publishBlockCompleted({
              ...base,
              toolName,
              callId,
              argumentsJson,
              parsedArguments: parsedArgs.value,
              parseError: parsedArgs.error,
            })
            // Record the pending tool so response.completed can flip
            // the phase to `awaiting-tool` with this tool as the hint.
            if (callId) {
              flow.pendingToolUses.push({
                toolUseId: callId,
                toolName: toolName ?? '',
              })
            }
            return
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            this.headless.semantic.publishBlockCompleted({
              ...base,
              callId: stringField(item, 'call_id'),
              toolName: stringField(item, 'name'),
              output: item.output,
            })
            return
          }
          case 'custom_tool_call': {
            const toolName = stringField(item, 'name')
            const callId = stringField(item, 'call_id')
            this.headless.semantic.publishBlockCompleted({
              ...base,
              toolName,
              callId,
              // CustomToolCall.input is a plain string (not JSON). Preserve
              // as argumentsJson for symmetry with function_call consumers.
              argumentsJson: stringField(item, 'input'),
            })
            // Record pending tool — same rationale as function_call above.
            if (callId) {
              flow.pendingToolUses.push({
                toolUseId: callId,
                toolName: toolName ?? '',
              })
            }
            return
          }
          case 'tool_search_call':
          case 'tool_search_output': {
            this.headless.semantic.publishBlockCompleted({
              ...base,
              callId: stringField(item, 'call_id'),
              // ToolSearchCall carries `arguments` (object), ToolSearchOutput
              // carries `tools` (array). Both flow through `raw` for now —
              // callers can reach into the typed payload if they need a
              // specific field. Future: add typed narrow fields if we find
              // a consumer that needs them.
            })
            return
          }
          case 'local_shell_call': {
            const action = asRecord(item.action)
            const command = stringArrayField(action, 'command') ?? []
            this.headless.semantic.publishBlockCompleted({
              ...base,
              callId: stringField(item, 'call_id'),
              localShellCall: {
                status: stringField(item, 'status') ?? 'unknown',
                command,
                workingDirectory: stringField(action, 'working_directory'),
                timeoutMs: numberField(action, 'timeout_ms'),
                env: stringRecordField(action, 'env'),
                user: stringField(action, 'user'),
              },
            })
            return
          }
          case 'web_search_call': {
            const action = asRecord(item.action)
            const actionKind = stringField(action, 'type') ?? ''
            // Map Rust's WebSearchAction variants onto our simplified
            // tagged union. See codex-rs/protocol/src/models.rs:972-1000.
            const webSearchAction: {
              kind: 'search' | 'open_page' | 'find_in_page' | 'other'
              query?: string
              queries?: string[]
              url?: string
              pattern?: string
            } = {
              kind:
                actionKind === 'search'
                  ? 'search'
                  : actionKind === 'open_page'
                    ? 'open_page'
                    : actionKind === 'find_in_page'
                      ? 'find_in_page'
                      : 'other',
              query: stringField(action, 'query'),
              queries: stringArrayField(action, 'queries'),
              url: stringField(action, 'url'),
              pattern: stringField(action, 'pattern'),
            }
            this.headless.semantic.publishBlockCompleted({ ...base, webSearchAction })
            return
          }
          case 'image_generation_call': {
            this.headless.semantic.publishBlockCompleted({
              ...base,
              imageGeneration: {
                status: stringField(item, 'status') ?? 'unknown',
                revisedPrompt: stringField(item, 'revised_prompt'),
                result: stringField(item, 'result') ?? '',
              },
            })
            return
          }
          case 'compaction':
          case 'ghost_snapshot':
          case 'other':
          default: {
            // Variants we don't have typed fields for yet — forward via
            // `raw` so app code that knows the shape can read it.
            this.headless.semantic.publishBlockCompleted(base)
            return
          }
        }
      }

      case 'response.completed': {
        this.hydrateResponseIdFromFrame(flow, parsed)
        if (!flow.responseId) {
          this.markFlowTerminal(flow, 'completed')
          return
        }
        // Final usage is available on response.usage (mirrors
        // claude-code-headless's approach).
        const response = asRecord(parsed.response)
        const usage = asRecord(response?.usage)
        if (usage) {
          this.headless.semantic.publishUsageUpdated({
            turnId: flow.responseId,
            usage: flattenUsage(usage),
            source: 'proxy',
          })
        }
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'high',
        })
        flow.turnOpened = false
        // Phase terminal transition. If the turn produced function_call
        // or custom_tool_call items, the Agent Code client will execute
        // them and send the outputs back on the next `/v1/responses`
        // call — until then we sit in `awaiting-tool` so the user can
        // see which tool the session is blocked on. Server-executed
        // tools (web_search, image_generation, local_shell) don't
        // land in pendingToolUses because they don't pause the client.
        if (flow.pendingToolUses.length > 0) {
          const first = flow.pendingToolUses[0]!
          this.publishPhase(flow, 'awaiting-tool', {
            toolName: first.toolName,
            toolUseId: first.toolUseId,
          })
        } else {
          this.publishPhase(flow, 'idle')
        }
        // WHY release on response.completed instead of waiting for
        // response-end:
        // `response.completed` is the upstream semantic terminal
        // event. For client-executed tools (including MCP), Codex can
        // issue the follow-up `/v1/responses` request containing the
        // function_call_output before the proxy observes the previous
        // socket's response-end, and in broken/long-lived transports
        // that end event may never arrive. Holding `activeFlowId` past
        // response.completed incorrectly demotes the legitimate
        // follow-up flow to secondary, so the renderer sees only
        // phase changes and no block/text events. Marking this flow
        // completed keeps any stray tail chunks from publishing while
        // allowing the next model turn to claim the active slot.
        this.markFlowTerminal(flow, 'completed')
        return
      }

      case 'response.failed': {
        this.hydrateResponseIdFromFrame(flow, parsed)
        if (!flow.responseId) {
          this.markFlowTerminal(flow, 'failed')
          return
        }
        // Classify the upstream error. Port of codex-rs's
        // responses.rs:274-305 — same checks, same precedence, so a
        // renderer that branches on errorType sees identical semantics
        // whether the failure was observed via proxy or surfaced
        // through codex's own error path. Losing this classification
        // (as the old adapter did) collapsed context-window overflows,
        // rate limits, and quota errors into a generic "fallback"
        // finishTurn — the user couldn't tell why a turn died.
        const response = asRecord(parsed.response) ?? undefined
        const classified = classifyResponseFailed(response)
        this.headless.semantic.publishApiError({
          turnId: flow.responseId,
          errorType: classified.errorType,
          message: classified.message,
          retryAfterMs: classified.retryAfterMs,
          source: 'proxy',
        })
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'fallback',
        })
        flow.turnOpened = false
        // API failure tears down the turn; pending tools are moot
        // because the failure happened before we could send results.
        this.publishPhase(flow, 'idle')
        this.markFlowTerminal(flow, 'failed')
        return
      }

      case 'response.incomplete': {
        this.hydrateResponseIdFromFrame(flow, parsed)
        if (!flow.responseId) {
          this.markFlowTerminal(flow, 'incomplete')
          return
        }
        // `incomplete_details.reason` is the upstream explanation:
        // `max_output_tokens`, `content_filter`, etc. codex-rs pulls
        // it at responses.rs:306-316. Surface via publishTurnStopped
        // so consumers can distinguish "ran out of tokens" from
        // "refused by safety" without parsing the raw event.
        const response = asRecord(parsed.response)
        const details = asRecord(response?.incomplete_details)
        const reason = stringField(details, 'reason') ?? null
        this.headless.semantic.publishTurnStopped({
          turnId: flow.responseId,
          stopReason: reason,
          source: 'proxy',
        })
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'fallback',
        })
        flow.turnOpened = false
        // Incomplete response (max_output_tokens / content_filter /
        // etc.). Turn is done, no tools to wait on.
        this.publishPhase(flow, 'idle')
        this.markFlowTerminal(flow, 'incomplete')
        return
      }

      default:
        // Unknown event: ignore. Upstream adds new kinds
        // occasionally; we don't want to crash when that happens.
        return
    }
  }
}

function flattenUsage(u: Record<string, unknown>): Record<string, number | string | undefined> {
  const out: Record<string, number | string | undefined> = {}
  for (const [k, v] of Object.entries(u)) {
    if (typeof v === 'number' || typeof v === 'string') out[k] = v
    else if (v && typeof v === 'object') {
      for (const [ck, cv] of Object.entries(asRecord(v) ?? {})) {
        if (typeof cv === 'number' || typeof cv === 'string') out[`${k}.${ck}`] = cv
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Item-shape helpers.
// ---------------------------------------------------------------------------
//
// Separated from the hot switch so the variant handling stays readable
// and each mapping is testable in isolation. All of these mirror
// behaviour in codex-rs/protocol/src/models.rs — the wire payload the
// adapter receives is a direct serialization of the ResponseItem enum
// there, so our parsing must stay aligned with upstream's shape.

/** Map ResponseItem.type wire string → SemanticBlockKind. Falls back
 *  to 'other' for unknown variants (Codex adds new ones occasionally);
 *  the consumer's switch can default-render an unknown kind without
 *  losing the raw payload. See codex-rs/protocol/src/models.rs:188-341. */
function mapItemTypeToBlockKind(itemType: string): SemanticBlockKind {
  switch (itemType) {
    case 'message': return 'message'
    case 'reasoning': return 'reasoning'
    case 'function_call': return 'function_call'
    case 'function_call_output': return 'function_call_output'
    case 'custom_tool_call': return 'custom_tool_call'
    case 'custom_tool_call_output': return 'custom_tool_call_output'
    case 'tool_search_call': return 'tool_search_call'
    case 'tool_search_output': return 'tool_search_output'
    case 'local_shell_call': return 'local_shell_call'
    case 'web_search_call': return 'web_search_call'
    case 'image_generation_call': return 'image_generation_call'
    case 'compaction':
    case 'compaction_summary': // alias kept for older wire compat (models.rs:335)
      return 'compaction'
    case 'ghost_snapshot': return 'ghost_snapshot'
    default: return 'other'
  }
}

/** Extract MessagePhase if the upstream populated it. Phase is
 *  optional — providers that don't emit it leave the field absent and
 *  we treat that as "unknown" (renderer falls back to legacy behavior).
 *  See codex-rs/protocol/src/models.rs:170-184. */
function extractMessagePhase(
  item: Record<string, unknown> | undefined,
): 'commentary' | 'final_answer' | undefined {
  const raw = item?.phase
  if (raw === 'commentary' || raw === 'final_answer') return raw
  return undefined
}

/** Flatten a Message block's `content: ContentItem[]` into a plain
 *  string. ContentItem variants (see codex-rs/protocol/src/models.rs:
 *  153-159): InputText / InputImage / OutputText. We only care about
 *  OutputText here — input items belong to user turns, not assistant. */
function extractMessageText(item: Record<string, unknown>): string | undefined {
  const content = item.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const entry of content) {
    const obj = asRecord(entry)
    const text = stringField(obj, 'text')
    if (obj?.type === 'output_text' && text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('') : undefined
}

/** Flatten a Reasoning block's `summary: ReasoningItemReasoningSummary[]`
 *  into a plain string. Only the SummaryText variant exists today
 *  (codex-rs/protocol/src/models.rs:1002-1006). */
function extractReasoningSummary(
  item: Record<string, unknown>,
): string | undefined {
  const summary = item.summary
  if (!Array.isArray(summary)) return undefined
  const parts: string[] = []
  for (const entry of summary) {
    const obj = asRecord(entry)
    const text = stringField(obj, 'text')
    if (obj?.type === 'summary_text' && text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Flatten a Reasoning block's optional `content: ReasoningItemContent[]`
 *  into a plain string. Two variants exist — ReasoningText and Text
 *  (codex-rs/protocol/src/models.rs:1008-1013). */
function extractReasoningContent(
  item: Record<string, unknown>,
): string | undefined {
  const content = item.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const entry of content) {
    const obj = asRecord(entry)
    const text = stringField(obj, 'text')
    if (
      (obj?.type === 'reasoning_text' || obj?.type === 'text') &&
      text
    ) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Parse a JSON string that may be invalid mid-stream. Returns a
 *  `{ value, error }` shape: if parsing succeeds, `value` is the
 *  parsed object; if it fails, `error` carries the parser message so
 *  the renderer can show an error state instead of half-rendering a
 *  broken tool call. Mirrors Claude's tryParseJson behaviour in
 *  claude-code-headless/src/proxy/ClaudeProxyAdapter.ts. */
function tryParseObject(
  s: string,
): { value: Record<string, unknown>; error?: undefined } | { value?: undefined; error: string } {
  try {
    const value: unknown = JSON.parse(s)
    const obj = asRecord(value)
    if (obj) return { value: obj }
    return { error: 'arguments did not parse to an object' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Classify `response.failed` into the same ApiError variants codex-rs
 *  uses at responses.rs:274-305. Port of its check functions so the
 *  proxy path produces semantically identical error types to codex's
 *  own error handler — a renderer that branches on errorType gets
 *  consistent behaviour whether the failure was observed via proxy or
 *  surfaced through codex.
 *
 *  The Rust source checks (in order):
 *    1. is_context_window_error → ContextWindowExceeded
 *    2. is_quota_exceeded_error → QuotaExceeded
 *    3. is_usage_not_included → UsageNotIncluded
 *    4. is_invalid_prompt_error → InvalidRequest { message }
 *    5. is_server_overloaded_error → ServerOverloaded
 *    6. default → Retryable { message, delay }
 *
 *  We mirror the same order. Detection predicates use the upstream
 *  error code/type/message strings — they're documented across the
 *  OpenAI Responses API error taxonomy. */
function classifyResponseFailed(
  response: Record<string, unknown> | undefined,
): {
  errorType:
    | 'context_window_exceeded'
    | 'quota_exceeded'
    | 'usage_not_included'
    | 'server_overloaded'
    | 'invalid_request'
    | 'retryable'
    | 'stream'
  message: string
  retryAfterMs?: number
} {
  const err = response?.error
  if (!err || typeof err !== 'object') {
    return { errorType: 'stream', message: 'response.failed event received' }
  }
  const e = asRecord(err)
  if (!e) return { errorType: 'stream', message: 'response.failed event received' }
  const code = stringField(e, 'code') ?? ''
  const type = stringField(e, 'type') ?? ''
  const message = stringField(e, 'message') ?? 'response.failed'

  // Context window overflow — OpenAI returns "context_length_exceeded"
  // code or the phrase in the message. codex-rs's is_context_window_error
  // covers both paths (see its implementation in core/src/client.rs).
  if (
    code === 'context_length_exceeded' ||
    /context[_ ]?length[_ ]?exceeded|maximum context length/i.test(message)
  ) {
    return { errorType: 'context_window_exceeded', message }
  }

  // Quota / billing exhaustion.
  if (
    code === 'insufficient_quota' ||
    /insufficient[_ ]?quota|exceeded.*quota/i.test(message)
  ) {
    return { errorType: 'quota_exceeded', message }
  }

  // ChatGPT plan without Responses API access — a distinct auth-adjacent
  // failure mode that codex-rs calls out explicitly.
  if (/usage is not included/i.test(message)) {
    return { errorType: 'usage_not_included', message }
  }

  // Invalid prompt / malformed request.
  if (
    code === 'invalid_request_error' ||
    type === 'invalid_request_error' ||
    /invalid[_ ]?request|invalid[_ ]?prompt/i.test(message)
  ) {
    return { errorType: 'invalid_request', message }
  }

  // Server-side overload / rate limit (529-style).
  if (
    code === 'server_overloaded' ||
    code === 'overloaded' ||
    /overloaded|rate[_ ]?limit/i.test(message)
  ) {
    return { errorType: 'server_overloaded', message }
  }

  // Default: retryable generic error. Extract retry-after hint if
  // present — upstream can embed it in the error payload.
  const retryAfter = parseRetryAfterMs(e)
  return { errorType: 'retryable', message, retryAfterMs: retryAfter }
}

function parseRateLimitReachedType(value: unknown): SemanticApiErrorEvent['rateLimitReachedType'] {
  // Match the upstream enum exactly. Do not normalize unknown values into an
  // owner/member role: those roles determine which recovery action is possible.
  switch (value) {
    case 'rate_limit_reached':
    case 'workspace_owner_credits_depleted':
    case 'workspace_member_credits_depleted':
    case 'workspace_owner_usage_limit_reached':
    case 'workspace_member_usage_limit_reached':
      return value
    default:
      return undefined
  }
}

/** Port of the TransportError::Http arm of
 *  vendor/codex-src/codex-rs/codex-api/src/api_bridge.rs:133-168. Runs on
 *  buffered non-2xx bodies only.
 *
 *  WHY this is separate from classifyResponseFailed rather than folded into
 *  it: that function classifies an SSE `response.failed` frame, where the
 *  transport succeeded and the model turn died. Here the transport itself was
 *  refused, so the HTTP status and the rate-limit headers are first-class
 *  evidence that a frame-based classifier has no access to. The two still
 *  meet at the bottom — anything this function can't distinguish is handed to
 *  the SSE classifier so a body-only error keeps its existing errorType. */
function classifyHttpFailure(failure: HttpFailure): {
  rateLimitReachedType?: SemanticApiErrorEvent['rateLimitReachedType']
  errorType: SemanticApiErrorEvent['errorType']
  message: string
  retryAfterMs?: number
  resetsAt?: number
  limitId?: string
  limitName?: string
} {
  let parsed: Record<string, unknown> | null = null
  // A truncated body is not parsed at all rather than parsed-and-caught: half
  // a JSON document can still parse (a bare number, a string) into something
  // that reads as a legitimate error shape, and inventing a classification
  // from a body we deliberately stopped reading is worse than falling back to
  // the status. See MAX_FAILURE_BODY_CHARS for why the cap exists.
  if (!failure.truncated) {
    try { parsed = asRecord(JSON.parse(failure.body)) } catch { parsed = null }
  }
  const error = parsed ? asRecord(parsed.error) : null
  // codex-rs discriminates on `error.type` in the 429 arm (api_bridge.rs:135)
  // but on `error.code` elsewhere (api_bridge.rs:80, 92), and the SSE
  // classifier below already matches on `code`. Accept either: upstream uses
  // both spellings for the same taxonomy and a body that says
  // `code: "insufficient_quota"` must not be flattened into a throttle just
  // because it did not repeat itself in `type`.
  const discriminator = (error && (stringField(error, 'type') || stringField(error, 'code'))) || ''
  // A status-only message is still better than an empty card: some upstream
  // 5xx replies are HTML from an edge proxy and carry no JSON error at all.
  const statusMessage = `HTTP ${failure.status} from /responses`
  const message = (error && stringField(error, 'message')) || statusMessage
  const retryAfterSeconds = Number(failure.headers['retry-after'])
  // > 0, not just finite: `Number('')` is 0 and an HTTP-date `Retry-After` is
  // NaN, and a `retryAfterMs: 0` would tell a consumer "the server asked you
  // to retry immediately" when in fact the server said nothing parseable.
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : undefined

  if (failure.status === 429 && discriminator === 'usage_limit_reached') {
    // Same normalization codex-rs applies before building the header prefix
    // (rate_limits.rs:61-66): trim, lower-case, empty falls back to `codex`.
    // The fallback matters twice over — it is also the only prefix under which
    // the limit-name lookup below can find anything.
    const activeLimit = (failure.headers['x-codex-active-limit'] ?? '').trim().toLowerCase()
    const limitId = activeLimit || 'codex'
    // Header names cannot contain '_', so a pool id such as `codex_other`
    // addresses the `x-codex-other-*` family. This is the prefix rule from
    // rate_limits.rs:66-67, not a guess — do not re-add a second lookup on the
    // raw id, it can never match a header upstream actually sends.
    const limitName = failure.headers[`x-${limitId.replace(/_/g, '-')}-limit-name`]?.trim()
    const resets = error ? error.resets_at : undefined
    return {
      errorType: 'usage_limit_reached',
      rateLimitReachedType: parseRateLimitReachedType(failure.headers['x-codex-rate-limit-reached-type']),
      message,
      retryAfterMs,
      // Unix SECONDS, passed through untranslated. Converting to ms or to a
      // Date here would put a second time representation in the semantic
      // stream; the field's doc comment on SemanticApiErrorEvent is the one
      // place that unit is stated.
      resetsAt: typeof resets === 'number' ? resets : undefined,
      limitId,
      // Empty-string headers are dropped rather than surfaced as a blank
      // label, matching the filter codex-rs applies at rate_limits.rs:85-87.
      limitName: limitName || undefined,
    }
  }
  // Both of these MUST be tested before the generic 429 below. OpenAI delivers
  // billing exhaustion as a 429, and codex-rs handles `usage_not_included`
  // inside the very same TOO_MANY_REQUESTS arm (api_bridge.rs:160-161). An
  // earlier ordering here returned `rate_limited` first and flattened both
  // into "try again in a moment", which is the opposite of what either means:
  // neither clears on its own.
  if (discriminator === 'insufficient_quota') return { errorType: 'quota_exceeded', message }
  if (discriminator === 'usage_not_included') return { errorType: 'usage_not_included', message }
  // A 429 whose body names none of the above is a throttle, not an exhausted
  // subscription window. Keeping them distinct is the entire point of this
  // classifier: the app retries one and offers a provider switch for the
  // other.
  if (failure.status === 429) return { errorType: 'rate_limited', message, retryAfterMs }
  const sse = classifyResponseFailed(parsed ?? undefined)
  return {
    errorType: sse.errorType,
    // With no `error` object there was nothing for the SSE classifier to read,
    // and its no-op message ('response.failed event received') is a lie here —
    // this failure never involved an SSE frame. Keep the status line, which at
    // least tells the reader what happened.
    message: error ? sse.message : message,
    // Header retry-after only fills in when the body had none — the body is
    // the more specific signal when upstream bothered to send both.
    retryAfterMs: sse.retryAfterMs ?? retryAfterMs,
  }
}

/** Best-effort retry-after extraction. Upstream sometimes puts it in
 *  `error.retry_after` (seconds), `error.retry_after_ms` (ms), or
 *  `error.details.retry_after`. We check all known shapes and return
 *  milliseconds. Returns undefined when nothing parseable is found. */
function parseRetryAfterMs(err: Record<string, unknown>): number | undefined {
  const direct = err.retry_after_ms
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct

  const secs = err.retry_after
  if (typeof secs === 'number' && Number.isFinite(secs) && secs >= 0) return secs * 1000

  const nested = numberField(asRecord(err.details), 'retry_after')
  if (typeof nested === 'number' && Number.isFinite(nested) && nested >= 0) return nested * 1000
  return undefined
}
