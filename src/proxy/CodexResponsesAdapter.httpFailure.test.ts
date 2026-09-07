import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

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

describe('HTTP failures on /responses', () => {
  it('publishes usage_limit_reached with the active limit and reset time', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
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

  // The classifier above can only read what the proxy chose to forward, and
  // the `response` event is mirrored into shareable debug bundles. Pin the
  // allowlist here so widening it is a deliberate edit with a failing test
  // rather than a one-line convenience during a future debugging session.
  it('forwards only rate-limit headers on the response event', () => {
    const picked = pickRateLimitHeaders(new Headers({
      'x-codex-active-limit': 'codex',
      'x-codex-primary-used-percent': '100',
      'x-codex-secondary-reset-after-seconds': '3600',
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
      'x-codex-secondary-reset-after-seconds',
    ])
  })
})
