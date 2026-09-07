import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import type { SemanticApiErrorEvent } from '../channels/types.js'
import { pickRateLimitHeaders } from './responsesProxy.js'
import { createRecordedAdapterHarness } from './testing/adapterHarness.js'

// Body shape from codex-rs/codex-api/src/api_bridge.rs (usage_limit_reached
// branch). Marked SOURCE-DERIVED: no local proxy dump contained a 429 at the
// time of writing; replace with a recorded body when one is captured.
const USAGE_LIMIT_BODY = JSON.stringify({
  error: {
    type: 'usage_limit_reached',
    message: "You've hit your usage limit. Try again later.",
    resets_at: 1788659183,
    plan_type: 'pro',
  },
})

// WHY `method`/`upstream`/`bytes` appear here even though the assertions never
// look at them: the adapter routes proxy events through isStartEvent /
// isEndEvent, which require the exact field set the live proxy emits
// (responsesProxy.ts handleRequest and streamUpstreamResponse). Omitting them
// makes the adapter drop the event silently, so a test written without them
// would be asserting against a flow that was never created.
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses'

/** Drive one complete refused request through the adapter: request, response
 *  headers, body, transport end. Written as a helper because the four-event
 *  sequence is the same for every classification case and only the status,
 *  headers and body differ — spelling it out five times would bury which of
 *  those three each test is actually about. */
function emitFailure(
  proxy: { emit: (event: string, payload: Record<string, unknown>) => boolean },
  requestId: string,
  status: number,
  headers: Record<string, string>,
  body: string,
): void {
  const chunk = Buffer.from(body)
  proxy.emit('event', { kind: 'request', requestId, method: 'POST', path: '/v1/responses', upstream: UPSTREAM, endpoint: 'responses' })
  proxy.emit('event', { kind: 'response', requestId, path: '/v1/responses', status, headers })
  proxy.emit('event', { kind: 'response-chunk', requestId, path: '/v1/responses', size: chunk.length, chunk })
  proxy.emit('event', { kind: 'response-end', requestId, path: '/v1/responses', bytes: chunk.length })
}

describe('HTTP failures on /responses', () => {
  it('publishes usage_limit_reached with the active limit and reset time', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
    // Subscribing to the aggregate stream as well as spying on the publisher:
    // the spy proves the adapter computed the right fields, the stream proves
    // SemanticChannel actually forwards them. Those are separate failures —
    // dropping resetsAt/limitId/limitName from the emitted event would leave
    // the spy assertion perfectly green.
    const apiErrors: SemanticApiErrorEvent[] = []
    semantic.on('api_error', event => apiErrors.push(event))
    proxy.emit('event', { kind: 'request', requestId: 'r1', method: 'POST', path: '/v1/responses', upstream: UPSTREAM, endpoint: 'responses' })
    proxy.emit('event', {
      kind: 'response', requestId: 'r1', path: '/v1/responses', status: 429,
      headers: {
        'x-codex-active-limit': 'codex',
        'x-codex-primary-used-percent': '100',
        'x-codex-secondary-used-percent': '42.5',
        'x-codex-limit-name': 'Codex',
      },
    })
    proxy.emit('event', { kind: 'response-chunk', requestId: 'r1', path: '/v1/responses', size: USAGE_LIMIT_BODY.length, chunk: Buffer.from(USAGE_LIMIT_BODY) })
    proxy.emit('event', { kind: 'response-end', requestId: 'r1', path: '/v1/responses', bytes: USAGE_LIMIT_BODY.length })
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      errorType: 'usage_limit_reached',
      status: 429,
      resetsAt: 1788659183,
      limitId: 'codex',
      limitName: 'Codex',
    }))
    expect(apiErrors).toMatchObject([{
      type: 'api_error',
      errorType: 'usage_limit_reached',
      status: 429,
      resetsAt: 1788659183,
      limitId: 'codex',
      limitName: 'Codex',
      source: 'proxy',
    }])
  })

  it('classifies a generic 429 without the usage-limit type as rate_limited', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
    proxy.emit('event', { kind: 'request', requestId: 'r2', method: 'POST', path: '/v1/responses', upstream: UPSTREAM, endpoint: 'responses' })
    proxy.emit('event', { kind: 'response', requestId: 'r2', path: '/v1/responses', status: 429, headers: { 'retry-after': '20' } })
    proxy.emit('event', { kind: 'response-chunk', requestId: 'r2', path: '/v1/responses', size: 2, chunk: Buffer.from('{}') })
    proxy.emit('event', { kind: 'response-end', requestId: 'r2', path: '/v1/responses', bytes: 2 })
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'rate_limited', retryAfterMs: 20_000 }))
  })

  // Both of these arrive as HTTP 429 (OpenAI bills quota exhaustion that way,
  // and codex-rs handles usage_not_included inside its own TOO_MANY_REQUESTS
  // arm at api_bridge.rs:160-161). They exist to pin the ORDER of the checks:
  // a generic-429 test alone stays green even if the specific types are
  // flattened back into rate_limited.
  it('classifies a 429 carrying insufficient_quota as quota_exceeded', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
    // `code` rather than `type`: upstream uses both spellings for the same
    // taxonomy, and the SSE classifier this delegates to matches on `code`.
    emitFailure(proxy, 'r3', 429, {}, JSON.stringify({
      error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' },
    }))
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      errorType: 'quota_exceeded',
      status: 429,
      message: 'You exceeded your current quota.',
    }))
  })

  it('classifies a 429 carrying usage_not_included as usage_not_included', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
    emitFailure(proxy, 'r4', 429, {}, JSON.stringify({
      error: { type: 'usage_not_included', message: 'Your plan does not include Codex usage.' },
    }))
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      errorType: 'usage_not_included',
      status: 429,
    }))
  })

  it('keeps the status-only message when an error reply carries no JSON error object', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
    // A real edge-proxy 502: HTML, not JSON. The SSE classifier's fallback
    // message ('response.failed event received') would be a lie here.
    emitFailure(proxy, 'r5', 502, {}, '<html><body>502 Bad Gateway</body></html>')
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      status: 502,
      message: 'HTTP 502 from /responses',
    }))
  })

  it('classifies an over-cap error body by status alone', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
    // Valid JSON that is simply too large to trust: the adapter stops
    // appending at MAX_FAILURE_BODY_CHARS, so whatever it holds is a prefix
    // and must not be parsed into a classification.
    const oversized = JSON.stringify({
      error: { type: 'insufficient_quota', message: 'x'.repeat(300 * 1024) },
    })
    emitFailure(proxy, 'r6', 500, {}, oversized)
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      status: 500,
      message: 'HTTP 500 from /responses',
    }))
    // The truncated body must not have leaked its own type through.
    expect(published.mock.calls[0]?.[0].errorType).not.toBe('quota_exceeded')
  })

  // The classifier above can only read what the proxy chose to forward, and
  // the `response` event is mirrored into shareable debug bundles. Pin the
  // allowlist here so widening it is a deliberate edit with a failing test
  // rather than a one-line convenience during a future debugging session.
  it('forwards only rate-limit headers on the response event', () => {
    const picked = pickRateLimitHeaders(new Headers({
      'x-codex-active-limit': 'codex',
      'x-codex-primary-used-percent': '100',
      'x-codex-secondary-reset-at': '1788659183',
      'x-codex-primary-window-minutes': '300',
      'x-codex-limit-name': 'Codex',
      'retry-after': '20',
      // Everything below is real upstream response-header traffic that must
      // never reach the semantic stream.
      'set-cookie': '__Secure-next-auth.session-token=redacted',
      'x-request-id': 'req_abc123',
      'openai-organization': 'org-abc',
      'content-type': 'application/json',
    }))
    expect(Object.keys(picked).sort()).toEqual([
      'retry-after',
      'x-codex-active-limit',
      'x-codex-limit-name',
      'x-codex-primary-used-percent',
      'x-codex-primary-window-minutes',
      'x-codex-secondary-reset-at',
    ])
  })
})
