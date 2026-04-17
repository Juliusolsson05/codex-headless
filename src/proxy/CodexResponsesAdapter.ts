import { StringDecoder } from 'string_decoder'
import type { CodexHeadless } from '../CodexHeadless.js'
import type { SemanticBlockKind } from '../channels/types.js'
import type { ResponsesProxy } from './responsesProxy.js'

// CodexResponsesAdapter — consumes the raw SSE chunks that
// `ResponsesProxy` emits on its 'event' channel, parses OpenAI
// Responses API events, and publishes them to the CodexHeadless
// SemanticChannel as `source: 'proxy'` turns/deltas.
//
// WHY this lives inside codex-headless (and not in cc-shell):
//   This file used to live at src/providers/codex/runtime/ in
//   cc-shell. The comment that used to justify that placement argued
//   the transport adapter belonged next to the HTTP server because
//   both were "cc-shell transport concerns". That argument was wrong
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
//   (cc-shell today, anyone else tomorrow) get a complete proxy
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
}

type EndEvent = {
  kind: 'response-end'
  requestId: string
  path: string
  bytes: number
}

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
  // `response.id` from the upstream, used as our semantic turnId.
  // Falls back to the flow id until response.created arrives.
  responseId: string | null
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
  // accumulate into `textSoFar` / `summarySoFar` / `reasoningSoFar`
  // so each delta event we emit carries a running total — consumers
  // can jump in mid-stream without replaying.
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
    }
  >
  // Whether we've emitted startTurn for this flow yet. Used to
  // avoid publishing deltas before the turn exists.
  turnOpened: boolean
  // Last observed `obfuscation` nonce — noisy, only for debug logs.
  lastObfuscation: string | null
}

export class CodexResponsesAdapter {
  private readonly proxy: ResponsesProxy
  private readonly headless: CodexHeadless
  private readonly flows = new Map<string, FlowState>()
  // Monotonically increasing flow id — not path-derived because
  // the same path fires on every retry and we need stable keys.
  private nextFlowSeq = 1
  private attachedHandler: ((ev: Record<string, unknown>) => void) | null = null

  constructor(proxy: ResponsesProxy, headless: CodexHeadless) {
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
  }

  detach(): void {
    if (!this.attachedHandler) return
    this.proxy.off('event', this.attachedHandler)
    this.attachedHandler = null
  }

  private onProxyEvent(ev: Record<string, unknown>): void {
    const kind = ev.kind
    // Only /responses POSTs produce semantic events. Skip /models
    // and any other observability events.
    const path = typeof ev.path === 'string' ? ev.path : ''
    if (!path.includes('/responses')) return

    if (kind === 'request') {
      const req = ev as unknown as StartEvent
      if (req.method !== 'POST') return
      // Mint a flow. Don't open a semantic turn yet — we want the
      // real response.id from response.created, not a synthetic id
      // that'd conflict with rollout's later task_started.
      const flowId = `proxy-${this.nextFlowSeq++}`
      this.flows.set(flowId, {
        flowId,
        requestId: req.requestId,
        path: req.path,
        responseId: null,
        buffer: '',
        decoder: new StringDecoder('utf8'),
        fullText: '',
        messageBlockIndex: null,
        blocks: new Map(),
        turnOpened: false,
        lastObfuscation: null,
      })
      // Publish via the typed publisher. cc-shell's ProxyDebugPanel
      // reads `runtime.semantic.flows` for its "flows seen" section,
      // and its reducer folds `flow_selected` events into that state
      // identically for Claude and Codex — the shape of
      // SemanticFlowSelectedEvent is deliberately the same in both
      // channels. Reason text mirrors the format the panel renders.
      this.headless.semantic.publishFlowSelected({
        flowId,
        turnId: null,
        reason: `${req.method} ${req.path}`,
        source: 'proxy',
      })
      return
    }

    if (kind === 'response-chunk') {
      const chunkEv = ev as unknown as ChunkEvent
      const flow = this.findFlowByRequestId(chunkEv.requestId)
      if (!flow) return
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
      flow.buffer += flow.decoder.write(chunkEv.chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      this.drainFrames(flow)
      return
    }

    if (kind === 'response-end') {
      const endEv = ev as unknown as EndEvent
      const flow = this.findFlowByRequestId(endEv.requestId)
      if (!flow) return
      // Flush any bytes the decoder was holding back (i.e. a trailing
      // partial sequence that never got its continuation). In healthy
      // streams this is empty; on truncated streams we'd rather see
      // a stray U+FFFD than silently swallow the tail.
      flow.buffer += flow.decoder.end()
      // Best-effort flush — upstream may not send a terminator.
      this.drainFrames(flow)
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
      this.flows.delete(flow.flowId)
      return
    }

    if (kind === 'response-error' || kind === 'upstream-error') {
      // Treat like an end: seal any open turn so the renderer
      // isn't stuck in "streaming" state, then drop the flow.
      const errReqId = typeof ev.requestId === 'string' ? ev.requestId : ''
      const flow = this.findFlowByRequestId(errReqId)
      if (!flow) return
      if (flow.turnOpened && flow.responseId) {
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'fallback',
        })
      }
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
      parsed = JSON.parse(payload) as Record<string, unknown>
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
        const response = parsed.response as Record<string, unknown> | undefined
        const id = typeof response?.id === 'string' ? response.id : null
        if (!id) return
        flow.responseId = id
        if (!flow.turnOpened) {
          this.headless.semantic.startTurn({
            turnId: id,
            role: 'assistant',
            source: 'proxy',
            confidence: 'high',
          })
          flow.turnOpened = true
        }
        return
      }

      case 'response.output_item.added': {
        if (!flow.turnOpened || !flow.responseId) return
        const item = parsed.item as Record<string, unknown> | undefined
        const itemId = typeof item?.id === 'string' ? item.id : null
        const itemType = typeof item?.type === 'string' ? item.type : ''
        const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : 0
        if (!itemId) return

        const kind = mapItemTypeToBlockKind(itemType)
        const callId =
          typeof item?.call_id === 'string' ? (item.call_id as string) : undefined
        const toolName =
          typeof item?.name === 'string' ? (item.name as string) : undefined
        const phase = extractMessagePhase(item)
        const status =
          typeof item?.status === 'string' ? (item.status as string) : undefined

        flow.blocks.set(itemId, {
          index: outputIndex,
          kind,
          callId,
          toolName,
          textSoFar: '',
          summarySoFar: '',
          fullSoFar: '',
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
        const itemId = typeof parsed.item_id === 'string' ? (parsed.item_id as string) : null
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

      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        if (!flow.turnOpened || !flow.responseId) return
        const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
        if (!delta) return
        const itemId = typeof parsed.item_id === 'string' ? (parsed.item_id as string) : null
        const block = itemId ? flow.blocks.get(itemId) : null
        if (!block || block.kind !== 'reasoning') return

        // Distinguish the two reasoning tracks — summary (user-facing
        // digest) vs full (detailed chain-of-thought). Each has its own
        // accumulator so a consumer that only wants to show the summary
        // doesn't inadvertently display the full reasoning.
        const isSummary = t === 'response.reasoning_summary_text.delta'
        const track: 'summary' | 'full' = isSummary ? 'summary' : 'full'
        const upstreamIndex =
          (typeof parsed.summary_index === 'number'
            ? (parsed.summary_index as number)
            : typeof parsed.content_index === 'number'
              ? (parsed.content_index as number)
              : 0)
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
        const item = (parsed.item as Record<string, unknown> | undefined) ?? {}
        const itemId = typeof item.id === 'string' ? (item.id as string) : null
        const outputIndex =
          typeof parsed.output_index === 'number'
            ? (parsed.output_index as number)
            : itemId
              ? (flow.blocks.get(itemId)?.index ?? 0)
              : 0
        const kind = mapItemTypeToBlockKind(
          typeof item.type === 'string' ? (item.type as string) : '',
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
            typeof item.status === 'string' ? (item.status as string) : undefined,
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
            const argumentsJson =
              typeof item.arguments === 'string' ? (item.arguments as string) : ''
            const parsedArgs = tryParseObject(argumentsJson)
            this.headless.semantic.publishBlockCompleted({
              ...base,
              toolName:
                typeof item.name === 'string' ? (item.name as string) : undefined,
              callId:
                typeof item.call_id === 'string' ? (item.call_id as string) : undefined,
              argumentsJson,
              parsedArguments: parsedArgs.value,
              parseError: parsedArgs.error,
            })
            return
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            this.headless.semantic.publishBlockCompleted({
              ...base,
              callId:
                typeof item.call_id === 'string' ? (item.call_id as string) : undefined,
              toolName:
                typeof item.name === 'string' ? (item.name as string) : undefined,
              output: item.output,
            })
            return
          }
          case 'custom_tool_call': {
            this.headless.semantic.publishBlockCompleted({
              ...base,
              toolName:
                typeof item.name === 'string' ? (item.name as string) : undefined,
              callId:
                typeof item.call_id === 'string' ? (item.call_id as string) : undefined,
              // CustomToolCall.input is a plain string (not JSON). Preserve
              // as argumentsJson for symmetry with function_call consumers.
              argumentsJson:
                typeof item.input === 'string' ? (item.input as string) : undefined,
            })
            return
          }
          case 'tool_search_call':
          case 'tool_search_output': {
            this.headless.semantic.publishBlockCompleted({
              ...base,
              callId:
                typeof item.call_id === 'string' ? (item.call_id as string) : undefined,
              // ToolSearchCall carries `arguments` (object), ToolSearchOutput
              // carries `tools` (array). Both flow through `raw` for now —
              // callers can reach into the typed payload if they need a
              // specific field. Future: add typed narrow fields if we find
              // a consumer that needs them.
            })
            return
          }
          case 'local_shell_call': {
            const action = item.action as Record<string, unknown> | undefined
            const command = Array.isArray(action?.command)
              ? (action.command as unknown[]).filter((s): s is string => typeof s === 'string')
              : []
            this.headless.semantic.publishBlockCompleted({
              ...base,
              callId:
                typeof item.call_id === 'string' ? (item.call_id as string) : undefined,
              localShellCall: {
                status:
                  typeof item.status === 'string'
                    ? (item.status as string)
                    : 'unknown',
                command,
                workingDirectory:
                  typeof action?.working_directory === 'string'
                    ? (action.working_directory as string)
                    : undefined,
                timeoutMs:
                  typeof action?.timeout_ms === 'number'
                    ? (action.timeout_ms as number)
                    : undefined,
                env:
                  action?.env && typeof action.env === 'object'
                    ? (action.env as Record<string, string>)
                    : undefined,
                user:
                  typeof action?.user === 'string' ? (action.user as string) : undefined,
              },
            })
            return
          }
          case 'web_search_call': {
            const action = item.action as Record<string, unknown> | undefined
            const actionKind = typeof action?.type === 'string' ? (action.type as string) : ''
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
              query:
                typeof action?.query === 'string' ? (action.query as string) : undefined,
              queries: Array.isArray(action?.queries)
                ? (action.queries as unknown[]).filter(
                    (s): s is string => typeof s === 'string',
                  )
                : undefined,
              url: typeof action?.url === 'string' ? (action.url as string) : undefined,
              pattern:
                typeof action?.pattern === 'string' ? (action.pattern as string) : undefined,
            }
            this.headless.semantic.publishBlockCompleted({ ...base, webSearchAction })
            return
          }
          case 'image_generation_call': {
            this.headless.semantic.publishBlockCompleted({
              ...base,
              imageGeneration: {
                status:
                  typeof item.status === 'string'
                    ? (item.status as string)
                    : 'unknown',
                revisedPrompt:
                  typeof item.revised_prompt === 'string'
                    ? (item.revised_prompt as string)
                    : undefined,
                result:
                  typeof item.result === 'string' ? (item.result as string) : '',
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
        if (!flow.responseId) return
        // Final usage is available on response.usage (mirrors
        // claude-code-headless's approach).
        const response = parsed.response as Record<string, unknown> | undefined
        const usage = response?.usage as Record<string, unknown> | undefined
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
        return
      }

      case 'response.failed': {
        if (!flow.responseId) return
        // Classify the upstream error. Port of codex-rs's
        // responses.rs:274-305 — same checks, same precedence, so a
        // renderer that branches on errorType sees identical semantics
        // whether the failure was observed via proxy or surfaced
        // through codex's own error path. Losing this classification
        // (as the old adapter did) collapsed context-window overflows,
        // rate limits, and quota errors into a generic "fallback"
        // finishTurn — the user couldn't tell why a turn died.
        const response = parsed.response as Record<string, unknown> | undefined
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
        return
      }

      case 'response.incomplete': {
        if (!flow.responseId) return
        // `incomplete_details.reason` is the upstream explanation:
        // `max_output_tokens`, `content_filter`, etc. codex-rs pulls
        // it at responses.rs:306-316. Surface via publishTurnStopped
        // so consumers can distinguish "ran out of tokens" from
        // "refused by safety" without parsing the raw event.
        const response = parsed.response as Record<string, unknown> | undefined
        const details = response?.incomplete_details as Record<string, unknown> | undefined
        const reason =
          typeof details?.reason === 'string' ? (details.reason as string) : null
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
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
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
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    if (obj.type === 'output_text' && typeof obj.text === 'string') {
      parts.push(obj.text as string)
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
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    if (obj.type === 'summary_text' && typeof obj.text === 'string') {
      parts.push(obj.text as string)
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
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    if (
      (obj.type === 'reasoning_text' || obj.type === 'text') &&
      typeof obj.text === 'string'
    ) {
      parts.push(obj.text as string)
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
    const obj = JSON.parse(s) as unknown
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return { value: obj as Record<string, unknown> }
    }
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
  const e = err as Record<string, unknown>
  const code = typeof e.code === 'string' ? (e.code as string) : ''
  const type = typeof e.type === 'string' ? (e.type as string) : ''
  const message =
    typeof e.message === 'string' ? (e.message as string) : 'response.failed'

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

/** Best-effort retry-after extraction. Upstream sometimes puts it in
 *  `error.retry_after` (seconds), `error.retry_after_ms` (ms), or
 *  `error.details.retry_after`. We check all known shapes and return
 *  milliseconds. Returns undefined when nothing parseable is found. */
function parseRetryAfterMs(err: Record<string, unknown>): number | undefined {
  const direct = err.retry_after_ms
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct

  const secs = err.retry_after
  if (typeof secs === 'number' && Number.isFinite(secs) && secs >= 0) return secs * 1000

  const details = err.details
  if (details && typeof details === 'object') {
    const nested = (details as Record<string, unknown>).retry_after
    if (typeof nested === 'number' && Number.isFinite(nested) && nested >= 0) return nested * 1000
  }
  return undefined
}
