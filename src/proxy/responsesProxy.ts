import { EventEmitter } from 'events'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import type { Socket } from 'net'
import { Readable } from 'stream'
import { appendFileSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Local HTTP proxy for Codex's Responses API.
//
// WHY a proxy at all:
//   Codex sends its assistant turns over `POST {base_url}/responses`
//   as SSE. cc-shell wants to observe that wire so the renderer can
//   build a semantic live-turn without screen-scraping. Inserting a
//   local HTTP server between Codex and the real upstream gives us
//   decrypted events with zero CA-injection gymnastics (unlike the
//   Claude/mitmproxy path — OpenAI/ChatGPT natively support custom
//   `openai_base_url`, so we just redirect via a plain HTTP listener
//   on 127.0.0.1).
//
// WHY we detect auth_mode:
//   Codex has two auth paths that resolve DIFFERENT default upstream
//   URLs:
//     - apikey mode  → https://api.openai.com/v1
//     - chatgpt mode → https://chatgpt.com/backend-api/codex
//   The `openai_base_url` config override replaces the URL on the
//   built-in `openai` provider REGARDLESS of auth mode (see
//   codex-rs/model-provider-info/src/lib.rs:184-193), which means
//   the SAME proxy URL is injected for both. But WE still need to
//   know which real upstream to forward to, or ChatGPT-mode users
//   send their chatgpt.com JWT to api.openai.com and get 401.
//   Detection reads ~/.codex/auth.json at proxy-create time; if
//   that file is absent, we fall back to apikey mode (because an
//   explicit OPENAI_API_KEY env var can't authenticate against
//   chatgpt.com).
//
// WHY we transparently forward anything under /v1/:
//   Codex uses more provider endpoints than just /responses + /models.
//   Confirmed from upstream source (codex-rs/codex-api/src/endpoint/*
//   and codex-rs/core/src/client.rs — relative paths like `responses`,
//   `responses/compact`, `memories/trace_summarize`, `realtime/calls`,
//   `models` — all joined against the SAME base URL we inject via the
//   `openai_base_url` override). The earlier allowlist that only
//   handled /responses + /models silently broke remote compaction
//   (issues.md #23: "unexpected status 404: unsupported POST
//   /v1/responses/compact"), memory summarization, and realtime calls.
//
//   Strictness vs transparency:
//     The upstream Rust `responses-api-proxy` is intentionally strict
//     (POST /v1/responses only) because it runs as root with an
//     injected $OPENAI_API_KEY — the allowlist prevents unprivileged
//     misuse. OUR proxy is different: we don't inject auth, we pass
//     Codex's own Authorization header through untouched. The reason
//     we exist is observation, not key protection. So the strict
//     model is wrong for us — a transparent forward under /v1/ keeps
//     Codex working through CLI updates and feature additions without
//     us chasing each new endpoint.
//
//   Known endpoints are still tagged in debug events (kind: 'request'
//   carries `endpoint: 'responses/compact'` etc.) so the proxy debug
//   panel can surface them. Unknown /v1/ paths are forwarded and
//   tagged `endpoint: 'unknown'` so we notice if Codex adds something
//   new without having to dig through a 404 postmortem.
//
//   WebSocket upgrade handling is unchanged: Codex tries a WS upgrade
//   at /v1/responses first (`openai-beta: responses_websockets=
//   2026-02-06`), and we reject it so Codex falls back to SSE POST.
//   We don't proxy WS; doing so would add complexity with no renderer
//   upside.

export type CodexResponsesProxyEvents = {
  event: [Record<string, unknown>]
}

export interface CodexResponsesProxy {
  on<K extends keyof CodexResponsesProxyEvents>(
    event: K,
    listener: (...args: CodexResponsesProxyEvents[K]) => void,
  ): this
  off<K extends keyof CodexResponsesProxyEvents>(
    event: K,
    listener: (...args: CodexResponsesProxyEvents[K]) => void,
  ): this
  emit<K extends keyof CodexResponsesProxyEvents>(
    event: K,
    ...args: CodexResponsesProxyEvents[K]
  ): boolean
}

export type CodexAuthMode = 'apikey' | 'chatgpt'

export type CodexResponsesProxyInfo = {
  proxyBaseUrl: string
  upstreamBaseUrl: string
  authMode: CodexAuthMode
}

type Options = {
  upstreamBaseUrl?: string
  authMode?: CodexAuthMode
  /** Optional path of a JSONL file to mirror every emitted event into.
   *
   *  WHY this exists:
   *    Codex's proxy events used to flow through EventEmitter only —
   *    no on-disk record. The Claude proxy has had `proxy-events.jsonl`
   *    since day one (see ProxyServer in claude-code-headless'
   *    proxy-testing) and that's been load-bearing for forensic work
   *    against debug bundles ("what was the actual prompt that
   *    triggered this leak?"). Codex needs the same capability, ideally
   *    in the same on-disk shape so a single bundle-inspection tool
   *    can read either provider's traffic without branching.
   *
   *  WHY a path opt-in instead of always-on:
   *    The package has a public testing entry point that constructs a
   *    proxy without ever wiring disk persistence; baking it into the
   *    constructor would force every embedder to opt OUT. Path-driven
   *    opt-in keeps backward compat with existing callers while making
   *    cc-shell's wiring trivially `eventsFile: <path>` at create
   *    time.
   *
   *  Format mirrors mitmAddon.py: one JSON object per line, terminated
   *  by `\n`, no header. Append-only; rotation is the caller's
   *  problem (cc-shell allocates a fresh path per session run, so
   *  natural rotation falls out for free). */
  eventsFile?: string
}


// Cap on the request `body_b64` payload mirrored to disk. Sized to
// match the Claude addon (`mitmAddon.py:_REQUEST_BODY_CAP`) so the
// disk shape is identical across providers. Real Codex requests are
// generally smaller than Claude's because the input is a structured
// items array rather than a flat conversation string, but the cap is
// the same for symmetry — debug-bundle tooling can rely on a single
// invariant ("body_b64 fits, OR body was over 2 MiB and only
// request_shape is present").
const _REQUEST_BODY_CAP = 2 * 1024 * 1024


// Headers we forward verbatim onto the proxy event. Allowlist
// rationale matches the Claude addon's: Authorization is structurally
// excluded so a leaked debug bundle cannot expose bearer tokens, and
// unknown headers are dropped by default so a future Codex header
// addition can't accidentally make it onto disk before we've reviewed
// whether it's safe to record.
//
// Headers chosen by reading vendor/codex-src/codex-rs/core/src/client.rs
// (build_responses_options + build_subagent_headers +
//  build_responses_identity_headers) — these are the discriminating
// signals for sidecar vs main turn vs subagent.
const _HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'x-codex-installation-id',
  'x-codex-window-id',
  'x-codex-parent-thread-id',
  'x-codex-turn-state',
  'x-openai-subagent',
  'user-agent',
  'content-length',
  'content-type',
  'openai-beta',
])


function filterRequestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (!_HEADER_ALLOWLIST.has(lower)) continue
    if (typeof value === 'string') out[lower] = value
    else if (Array.isArray(value)) out[lower] = value.join(', ')
  }
  return out
}


// Pre-extracted request shape for the Codex /responses endpoints.
// Mirrors the design in claude-code-headless' mitmAddon.py: parse the
// buffered body once at request time, ship a small structured object
// instead of forwarding multi-MB base64 over the wire. Today the
// adapter doesn't consume these fields — they're forensic-only —
// but landing the slot now means future predicate work has a place
// to read from without re-parsing.
//
// Field meaning (source: vendor/codex-src/codex-rs/core/src/client.rs
// build_responses_request, compact_conversation_history,
// summarize_memories):
//   - model              slug like "gpt-5-codex"
//   - instructions_chars total length of the `instructions` string
//                        (Codex's equivalent of Claude's system block)
//   - input_items_count  number of entries in `input` (the structured
//                        conversation items array)
//   - tools_count        number of entries in `tools` array, or null
//                        if absent (memories/trace_summarize omits)
//   - has_reasoning      true iff a `reasoning` object is present —
//                        present on real turns and compact, absent
//                        on memory summarization
type CodexRequestShape = {
  model: string | null
  instructions_chars: number | null
  input_items_count: number | null
  tools_count: number | null
  has_reasoning: boolean
}


function extractRequestShape(body: Buffer): CodexRequestShape | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf-8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>

  const model = typeof obj.model === 'string' ? obj.model : null
  const instructions =
    typeof obj.instructions === 'string' ? obj.instructions.length : null
  const input = Array.isArray(obj.input) ? obj.input.length : null
  const tools = Array.isArray(obj.tools) ? obj.tools.length : null
  const hasReasoning = obj.reasoning != null && typeof obj.reasoning === 'object'

  return {
    model,
    instructions_chars: instructions,
    input_items_count: input,
    tools_count: tools,
    has_reasoning: hasReasoning,
  }
}

// Detect which auth path Codex is configured for. Cheap enough to
// run per-session — the alternative is to accept it as an option
// from callers, but the single source of truth is ~/.codex/auth.json
// so making it the proxy's job keeps callers simpler.
function detectAuthMode(): CodexAuthMode {
  const authPath = join(homedir(), '.codex', 'auth.json')
  try {
    const raw = readFileSync(authPath, 'utf-8')
    const parsed = JSON.parse(raw) as { auth_mode?: string }
    if (parsed.auth_mode === 'chatgpt') return 'chatgpt'
    if (parsed.auth_mode === 'apikey') return 'apikey'
  } catch {
    /* file missing / unreadable — fall through */
  }
  // No auth.json: if OPENAI_API_KEY is set we can only be useful
  // against api.openai.com.
  return 'apikey'
}

function defaultUpstreamFor(authMode: CodexAuthMode): string {
  return authMode === 'chatgpt'
    ? 'https://chatgpt.com/backend-api/codex'
    : 'https://api.openai.com/v1'
}

export class ResponsesProxy extends EventEmitter {
  private server: Server | null = null
  readonly info: CodexResponsesProxyInfo
  // Header timeout for the hot SSE `/responses` path. We still want a
  // relatively tight guard here because a live turn normally starts
  // streaming quickly, and a dead upstream should fail fast.
  private readonly streamingHeadersTimeoutMs = 30_000
  // Unary JSON endpoints like `/responses/compact` do not stream and
  // can legitimately take much longer before sending response headers.
  // Using the SSE timeout here turns slow-but-valid compaction into a
  // synthetic local 502 ("This operation was aborted").
  private readonly unaryHeadersTimeoutMs = 5 * 60_000
  // Track every open inbound socket so stop() can force them closed.
  // WHY: node's http.Server#close waits for all connections to finish
  // before it resolves. A long-running SSE turn holds its socket open
  // for minutes — without forcing them closed, stop() stalls session
  // teardown and the app feels frozen on quit/kill. Node 18.2+ has
  // `server.closeAllConnections()` which would do this for us; we
  // belt-and-suspenders with our own Set so this keeps working if a
  // future refactor wraps the server or hosts it elsewhere.
  private readonly openSockets = new Set<Socket>()
  // Per-request id counter. Used to tag every request/response/chunk/end/error
  // event with a stable requestId so downstream consumers (the
  // CodexResponsesAdapter in particular) can route chunks to their
  // originating request even when two requests to the same path overlap
  // — e.g. codex retrying a Responses call while the first one is still
  // streaming. Path-based routing was the old approach and silently
  // merged retries' bytes into the later request's flow state. Opaque
  // monotonic id avoids that and is cheap.
  private nextRequestSeq = 1
  // Path of the on-disk JSONL mirror, or null if disabled. When set,
  // `emit('event', …)` ALSO appends the event as a JSON line. Append
  // is synchronous (`appendFileSync`) because the events we emit are
  // small (KB-range, even with body_b64) and ordering matters for
  // forensic readback — an async stream tap would let later events
  // race ahead during a fast burst. Cost: a microbenchmark on a 4 MB
  // event takes <2 ms on SSD; the proxy's hot path (kind:
  // 'response-chunk') is bounded by network anyway.
  private readonly eventsFile: string | null

  constructor(info: CodexResponsesProxyInfo, eventsFile: string | null) {
    super()
    this.info = info
    this.eventsFile = eventsFile
  }

  // Override emit to mirror events into the on-disk JSONL. Done at
  // emit time (not inside each handler) so ANY event the proxy
  // produces — request, response-chunk, response-end, response-error,
  // upgrade-rejected, server-error, request-error, rejected — lands
  // on disk consistently. If we mirrored per-handler we'd inevitably
  // forget to add the call when adding a new event kind.
  override emit(event: string, ...args: unknown[]): boolean {
    if (this.eventsFile && event === 'event' && args.length > 0) {
      try {
        // Strip Buffer instances out of mirror payloads. The
        // 'response-chunk' event carries a Buffer with raw upstream
        // bytes — JSON.stringify of a Buffer produces a useless
        // {"type":"Buffer","data":[…]} blob and balloons disk size.
        // Substitute a base64 encoding inline so the mirror file
        // stays human-decodable without forcing all callers to
        // pre-encode.
        const payload = args[0]
        const serialised = JSON.stringify(payload, (_key, value) => {
          if (value && typeof value === 'object' && value instanceof Buffer) {
            return { _buffer_b64: value.toString('base64') }
          }
          return value
        })
        appendFileSync(this.eventsFile, serialised + '\n', 'utf-8')
      } catch {
        // Best-effort. A failed mirror write must never break the
        // live proxy — disk full or permissions issues should
        // degrade to "no on-disk record" silently rather than crash
        // the session.
      }
    }
    return super.emit(event, ...args)
  }

  static async create(options: Options = {}): Promise<ResponsesProxy> {
    const authMode = options.authMode ?? detectAuthMode()
    const upstreamBaseUrl = options.upstreamBaseUrl ?? defaultUpstreamFor(authMode)
    const server = createServer()
    const proxy = new ResponsesProxy(
      {
        // Populated after listen() resolves. Kept syntactically valid
        // so callers that accidentally read it early don't crash.
        proxyBaseUrl: 'http://127.0.0.1:0/v1',
        upstreamBaseUrl,
        authMode,
      },
      options.eventsFile ?? null,
    )
    proxy.server = server
    server.on('connection', socket => {
      // Record the socket for forced teardown in stop(). `once('close')`
      // removes it on its own if the client/upstream tears down first,
      // so the Set stays bounded to live sockets only.
      proxy.openSockets.add(socket)
      socket.once('close', () => proxy.openSockets.delete(socket))
    })
    server.on('request', (req, res) => {
      void proxy.handle(req, res)
    })
    // Handle WS upgrade attempts by responding with HTTP 426 Upgrade
    // Required. Codex tries a websocket upgrade at /responses first
    // (`openai-beta: responses_websockets=2026-02-06`). Its fallback
    // logic in codex-rs/core/src/client.rs:1302-1306 ONLY recognises
    // `StatusCode::UPGRADE_REQUIRED` (HTTP 426) as "no WS available,
    // fall back to SSE POST". Every other non-101 status — including
    // 404 Not Found — bubbles up as `ApiError::Transport(Http{..})`
    // and the session errors out before any POST is attempted.
    //
    // We don't proxy websockets (implementing upstream WS bridging
    // would double the transport footprint for zero renderer
    // upside — the SSE POST path already delivers every event we
    // care about). Replying 426 is the documented handshake Codex
    // expects when an upgrade is refused.
    //
    // Spec note: RFC 9110 §15.5.22 specifies 426 MUST include an
    // `Upgrade` header. For an HTTP→HTTPS redirect that would be
    // `Upgrade: TLS/1.2`; for our "no websocket available" case a
    // conventional sentinel is enough — crossterm/tungstenite only
    // reads the status line. We include a benign `Upgrade:` value
    // so well-formed HTTP clients don't choke on a missing header.
    //
    // Previously we responded with 404 and a comment that claimed
    // "codex treats any non-101 response as fall back to SSE POST".
    // That comment was wrong. The symptom was: prompt typed into
    // Codex's TUI composer, no request ever sent, session hung.
    // One `upgrade-rejected` event on the proxy and nothing else.
    server.on('upgrade', (_req, socket) => {
      proxy.emit('event', { kind: 'upgrade-rejected', path: _req.url })
      try {
        socket.write(
          'HTTP/1.1 426 Upgrade Required\r\n' +
            'Connection: close\r\n' +
            'Upgrade: HTTP/1.1\r\n' +
            'Content-Length: 0\r\n' +
            '\r\n',
        )
      } catch { /* socket already gone */ }
      try { socket.destroy() } catch { /* already gone */ }
    })
    // Forward server errors as events. Unlike EventEmitter's default
    // 'error' semantics (synchronous throw if unhandled), we have a
    // listener here AND re-expose via our own channel so callers can
    // observe without risking a crash.
    server.on('error', err => {
      proxy.emit('event', { kind: 'server-error', message: String(err) })
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('error', onError)
        reject(err)
      }
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine Codex proxy bind address'))
          return
        }
        proxy.info.proxyBaseUrl = `http://127.0.0.1:${address.port}/v1`
        server.off('error', onError)
        resolve()
      })
    })
    return proxy
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    // Rip the rug out from under every in-flight request BEFORE awaiting
    // close(). Without this step, a live SSE turn keeps its socket open
    // for as long as upstream keeps streaming (can be minutes), and
    // server.close() waits until every such socket is idle — so stop()
    // blocks session teardown indefinitely. Destroying sockets causes
    // the upstream pipe to error, propagates through the 'response-error'
    // path, and close() resolves immediately.
    for (const socket of this.openSockets) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    this.openSockets.clear()
    // Additionally call closeAllConnections() when available (Node
    // 18.2+). Belt-and-braces for any socket we somehow missed tracking
    // (e.g. a keep-alive socket delivered before our 'connection'
    // handler ran — vanishingly rare but cheap to guard).
    const maybeCloseAll = (server as Server & {
      closeAllConnections?: () => void
    }).closeAllConnections
    if (typeof maybeCloseAll === 'function') {
      try { maybeCloseAll.call(server) } catch { /* ignore */ }
    }
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'

    // Strip query string for path matching (models call includes ?client_version=…).
    const pathOnly = url.split('?', 1)[0] ?? url

    // Relative path against the real upstream base. We advertise
    // `http://127.0.0.1:PORT/v1` as the proxy base, so Codex requests
    // always arrive with a `/v1/` prefix. Strip that prefix before
    // joining against the upstream base — `new URL(relative, base)`
    // then does the right thing whether the upstream carries `/v1`
    // (apikey mode → https://api.openai.com/v1) or not (chatgpt mode
    // → https://chatgpt.com/backend-api/codex).
    //
    // We still accept bare `/responses`, `/models` shapes because a
    // consumer could theoretically override to a base without `/v1`.
    // That path was intentional in the old allowlist and is cheap to
    // preserve here.
    const relative = relativeUpstreamPath(pathOnly)
    if (!relative) {
      res.statusCode = 404
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(`codex-responses-proxy: unsupported ${method} ${pathOnly}\n`)
      this.emit('event', { kind: 'rejected', method, path: pathOnly })
      return
    }

    await this.forwardRequest(req, res, {
      method,
      originalUrl: url,
      pathOnly,
      relative,
    })
  }

  /**
   * Generic forwarder: read body (for methods that have one), forward
   * to the upstream at `{upstreamBase}/{relative}{?query}`, stream the
   * response back. Works for both SSE (`/responses`) and unary JSON
   * (`/responses/compact`, `/memories/trace_summarize`, `/models`)
   * because `Readable.fromWeb(upstreamRes.body).pipe(res)` preserves
   * the upstream content-type — piping bytes is format-agnostic.
   *
   * WHY we tag a `kind` on known endpoints:
   *   The debug panel needs to surface "this was a compact call" vs
   *   "this was the hot responses stream" without re-parsing the URL.
   *   Unknown /v1/ paths get `endpoint: 'unknown'` so we notice new
   *   Codex endpoints before they cause a 404 postmortem.
   */
  private async forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    params: {
      method: string
      originalUrl: string
      pathOnly: string
      relative: string
    },
  ): Promise<void> {
    const { method, originalUrl, pathOnly, relative } = params
    const requestId = `req-${this.nextRequestSeq++}`
    const endpoint = classifyEndpoint(pathOnly)

    // Read the request body for methods that have one. GET/HEAD never
    // carry a body; POST/PUT/PATCH/DELETE might. We read unconditionally
    // for non-GET/HEAD because the upstream Codex uses POST for every
    // non-model endpoint today and letting the buffer complete keeps
    // the streaming forward logic simple.
    const hasBody = method !== 'GET' && method !== 'HEAD'
    let body: Buffer | undefined
    if (hasBody) {
      try {
        body = await this.readBody(req)
      } catch (err) {
        // readBody rejects if the client disconnects mid-upload (rare
        // but possible on fast Ctrl-C). Emit a tagged event so the
        // disconnect is visible — observability loss is the real
        // damage here, since the client already went away.
        this.emit('event', {
          kind: 'request-error',
          requestId,
          endpoint,
          path: originalUrl,
          message: err instanceof Error ? err.message : String(err),
        })
        try {
          res.statusCode = 400
          res.end()
        } catch { /* client already gone */ }
        return
      }
    }

    const upstream = this.resolveUpstreamPath(relative, originalUrl)
    const headers = this.buildForwardedHeaders(req)
    const headersTimeoutMs = this.headersTimeoutMsFor(endpoint)

    // Enriched request event. Pre-extension we emitted only
    // {kind, requestId, endpoint, method, path, upstream, bytes} —
    // useful for "did a request happen?" but useless for the
    // forensic question "what prompt was sent?" Now we forward:
    //   - headers      filtered allowlist (no Authorization). Lets
    //                  bundle tooling discriminate subagent calls
    //                  from main turns by `x-openai-subagent`
    //                  presence and correlate windows by
    //                  `x-codex-window-id`.
    //   - body_b64     raw request body up to _REQUEST_BODY_CAP. If
    //                  the body exceeds the cap it's omitted; the
    //                  pre-extracted shape below still ships.
    //   - request_shape  small parsed metadata (model,
    //                  instructions_chars, input_items_count,
    //                  tools_count, has_reasoning) so future predicate
    //                  work has structured fields without re-parsing.
    let bodyB64: string | undefined
    let requestShape: CodexRequestShape | null = null
    if (body) {
      requestShape = extractRequestShape(body)
      if (body.length <= _REQUEST_BODY_CAP) {
        bodyB64 = body.toString('base64')
      }
    }
    this.emit('event', {
      kind: 'request',
      requestId,
      endpoint,
      method,
      path: originalUrl,
      upstream,
      bytes: body?.length,
      headers: filterRequestHeaders(req),
      ...(bodyB64 !== undefined ? { body_b64: bodyB64 } : {}),
      ...(requestShape !== null ? { request_shape: requestShape } : {}),
    })

    const abort = new AbortController()
    const headersTimer = setTimeout(() => {
      abort.abort(new Error(
        `upstream headers timeout after ${headersTimeoutMs}ms for ${endpoint}`,
      ))
    }, headersTimeoutMs)
    const onClientGone = (): void => {
      // If the local client has already disconnected there is no point
      // in finishing the upstream fetch, and surfacing a synthetic 502
      // back to a dead socket only muddies the real failure mode.
      if (req.destroyed || res.destroyed) {
        abort.abort(new Error(`downstream client disconnected during ${endpoint}`))
      }
    }
    req.once('aborted', onClientGone)
    res.once('close', onClientGone)

    try {
      // Node's undici runtime accepts Buffer directly (Buffer extends
      // Uint8Array, which is a valid BodyInit at runtime). But the
      // `BodyInit` type is only declared globally when the TypeScript
      // `lib` includes DOM, and the codex-headless tsconfig intentionally
      // keeps `lib: ["ES2022"]` (no DOM) — we're a Node package.
      //
      // Early versions imported `BodyInit` from `undici-types` to get
      // the name in scope. That broke when cc-shell compiled this file
      // through its path alias: cc-shell's @types/node ALSO declares a
      // global `BodyInit`, and TypeScript saw the undici-types-named
      // value as a different nominal type than the one `fetch()` in
      // cc-shell's context expects. Result: type mismatch at the call
      // site.
      //
      // The cross-context fix is to derive the body type from fetch
      // itself. Whatever `BodyInit` variant is in scope in the current
      // compile, `Parameters<typeof fetch>[1]` resolves to the matching
      // `RequestInit`, and its `body` field is the right union. No named
      // import, no nominal conflicts.
      type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body']
      const upstreamRes = await fetch(upstream, {
        method,
        headers,
        body: body ? (body as unknown as FetchBody) : undefined,
        signal: abort.signal,
      })
      // Headers received — stop the abort timer. The body may still
      // stream for minutes (long SSE turns), which is fine.
      clearTimeout(headersTimer)
      req.off('aborted', onClientGone)
      res.off('close', onClientGone)

      await this.streamUpstreamResponse(req, res, upstreamRes, originalUrl, requestId)
    } catch (err) {
      clearTimeout(headersTimer)
      req.off('aborted', onClientGone)
      res.off('close', onClientGone)
      this.emit('event', {
        kind: 'upstream-error',
        requestId,
        endpoint,
        path: originalUrl,
        message: err instanceof Error ? err.message : String(err),
      })
      if (req.destroyed || res.destroyed) {
        return
      }
      res.statusCode = 502
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(err instanceof Error ? err.message : String(err))
    }
  }

  private resolveUpstreamPath(relative: string, originalUrl: string): string {
    // Preserve query string from the original request.
    const qIndex = originalUrl.indexOf('?')
    const query = qIndex >= 0 ? originalUrl.slice(qIndex) : ''
    const base = this.info.upstreamBaseUrl.endsWith('/')
      ? this.info.upstreamBaseUrl
      : `${this.info.upstreamBaseUrl}/`
    return `${new URL(relative, base).toString()}${query}`
  }

  private buildForwardedHeaders(req: IncomingMessage): Headers {
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue
      const lower = key.toLowerCase()
      // Hop-by-hop headers we must not forward. Codex sends the
      // request body compressed with zstd sometimes (content-encoding:
      // zstd) — we KEEP that; upstream handles it.
      if (
        lower === 'host' ||
        lower === 'content-length' ||
        lower === 'connection' ||
        lower === 'transfer-encoding' ||
        lower === 'upgrade' ||
        lower === 'proxy-connection'
      ) {
        continue
      }
      if (Array.isArray(value)) {
        for (const part of value) headers.append(key, part)
      } else {
        headers.set(key, value)
      }
    }
    return headers
  }

  private async streamUpstreamResponse(
    _req: IncomingMessage,
    res: ServerResponse,
    upstreamRes: Response,
    originalUrl: string,
    requestId: string,
  ): Promise<void> {
    res.statusCode = upstreamRes.status
    upstreamRes.headers.forEach((value, key) => {
      // Hop-by-hop and length headers tiny_http-style: let node
      // recompute framing.
      const lower = key.toLowerCase()
      if (
        lower === 'content-length' ||
        lower === 'transfer-encoding' ||
        lower === 'connection' ||
        lower === 'trailer' ||
        lower === 'upgrade'
      ) {
        return
      }
      res.setHeader(key, value)
    })

    this.emit('event', {
      kind: 'response',
      requestId,
      path: originalUrl,
      status: upstreamRes.status,
    })

    if (!upstreamRes.body) {
      res.end()
      return
    }

    const nodeStream = Readable.fromWeb(upstreamRes.body as never)
    let bytesEstimate = 0
    nodeStream.on('data', chunk => {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
      bytesEstimate += size
      this.emit('event', {
        kind: 'response-chunk',
        requestId,
        path: originalUrl,
        size,
        // The raw SSE / JSON bytes. Consumers that want structured
        // semantic events should layer a parser on top.
        chunk: Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      })
    })
    nodeStream.on('end', () => {
      this.emit('event', {
        kind: 'response-end',
        requestId,
        path: originalUrl,
        bytes: bytesEstimate,
      })
    })
    nodeStream.on('error', err => {
      this.emit('event', {
        kind: 'response-error',
        requestId,
        path: originalUrl,
        message: err instanceof Error ? err.message : String(err),
      })
      try { res.destroy() } catch { /* best-effort */ }
    })
    nodeStream.pipe(res)
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  private headersTimeoutMsFor(endpoint: string): number {
    if (endpoint === 'responses') return this.streamingHeadersTimeoutMs
    return this.unaryHeadersTimeoutMs
  }
}

// ---------------------------------------------------------------------------
// Path classification helpers
// ---------------------------------------------------------------------------

/**
 * Translate an inbound proxy path into the relative path we should
 * append to the upstream base URL. Returns null for paths we refuse
 * to forward at all (root probes, /favicon, etc.).
 *
 * Examples:
 *   /v1/responses               → responses
 *   /v1/responses/compact       → responses/compact
 *   /v1/memories/trace_summarize→ memories/trace_summarize
 *   /v1/realtime/calls          → realtime/calls
 *   /v1/models                  → models
 *   /responses                  → responses   (no-/v1 base override)
 *   /                           → null        (not a Codex API path)
 */
function relativeUpstreamPath(pathOnly: string): string | null {
  if (!pathOnly || pathOnly === '/' || pathOnly === '/v1' || pathOnly === '/v1/') {
    return null
  }
  // Prefer /v1/ stripping when present — our advertised proxy base
  // always includes /v1, so Codex requests carry it.
  if (pathOnly.startsWith('/v1/')) {
    const relative = pathOnly.slice(4)
    return relative.length > 0 ? relative : null
  }
  // Fallback for bare shapes (consumer overrode base without /v1).
  if (pathOnly.startsWith('/')) {
    const relative = pathOnly.slice(1)
    return relative.length > 0 ? relative : null
  }
  return null
}

/**
 * Tag known Codex endpoints for structured debug events. Pure string
 * matching — kept in sync with codex-rs/codex-api/src/endpoint/* by
 * source, not by wire-probing, so adding an entry here when Codex
 * introduces a new endpoint is a one-liner.
 *
 * `unknown` is the catch-all for /v1/ paths we still forward but
 * haven't explicitly labelled; it's a debug-panel hint, not a reject.
 */
function classifyEndpoint(pathOnly: string): string {
  if (pathOnly.endsWith('/responses/compact')) return 'responses/compact'
  if (pathOnly.endsWith('/responses')) return 'responses'
  if (pathOnly.endsWith('/memories/trace_summarize')) return 'memories/trace_summarize'
  if (pathOnly.endsWith('/realtime/calls')) return 'realtime/calls'
  if (pathOnly.endsWith('/models')) return 'models'
  return 'unknown'
}
