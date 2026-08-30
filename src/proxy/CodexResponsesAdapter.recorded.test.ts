import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it } from 'vitest'

import { SemanticChannel } from '../channels/SemanticChannel.js'
import type { SemanticProviderRequestEvent } from '../channels/types.js'
import { CodexResponsesAdapter } from './CodexResponsesAdapter.js'
import type { ResponsesProxy } from './responsesProxy.js'

class RecordedProxy extends EventEmitter {}

describe('Codex Responses request observations from recorded traffic', () => {
  let adapter: CodexResponsesAdapter | null = null

  afterEach(() => {
    adapter?.detach()
    adapter = null
  })

  it('records creation, first-chunk attribution, cancellation, and the provider window identity', () => {
    const proxy = new RecordedProxy()
    const semantic = new SemanticChannel()
    const observed: SemanticProviderRequestEvent[] = []
    const productEvents: unknown[] = []
    semantic.on('provider_request', event => observed.push(event))
    semantic.on('event', event => productEvents.push(event))
    adapter = new CodexResponsesAdapter(
      proxy as unknown as ResponsesProxy,
      { semantic } as never,
    )
    adapter.attach()

    // Sanitized from proxy-events.jsonl line 42 in manual bundle
    // 2026-08-30T17-20-50-241-d00b4e7c. The request id and
    // x-codex-window-id are recorded facts; request body/content is omitted.
    proxy.emit('event', {
      kind: 'request',
      requestId: 'req-24',
      method: 'POST',
      path: '/v1/responses',
      upstream: 'https://chatgpt.com/backend-api/codex/responses',
      endpoint: 'responses',
      headers: {
        'x-codex-window-id': '01a053a8-0611-7711-9ca3-f69f130764ab:0',
      },
    })
    proxy.emit('event', {
      kind: 'response-chunk',
      requestId: 'req-24',
      path: '/v1/responses',
      size: 0,
      chunk: Buffer.alloc(0),
      endpoint: 'responses',
    })
    proxy.emit('event', {
      kind: 'response-end',
      requestId: 'req-24',
      path: '/v1/responses',
      bytes: 0,
      endpoint: 'responses',
    })

    expect(observed.map(event => [event.phase, event.cause])).toEqual([
      ['created', 'request-created'],
      ['selected', 'first-chunk'],
      ['cancelled', 'transport-ended-before-semantic-terminal'],
    ])
    expect(observed[0]).toMatchObject({
      requestId: 'req-24',
      flowId: 'proxy-1',
      providerSessionFingerprint: 'aca570c74cde331b785ba5bf566981ab43bc540cc9b71e68b2056fce42c5c27b',
      providerWindowGenerationId: '0',
      subagentHeaderPresent: false,
    })
    expect(productEvents.some(event =>
      typeof event === 'object' && event !== null &&
      (event as { type?: unknown }).type === 'provider_request')).toBe(false)
  })

  it('records ignored concurrent requests and their transport failure separately', () => {
    const proxy = new RecordedProxy()
    const semantic = new SemanticChannel()
    const observed: SemanticProviderRequestEvent[] = []
    semantic.on('provider_request', event => observed.push(event))
    adapter = new CodexResponsesAdapter(
      proxy as unknown as ResponsesProxy,
      { semantic } as never,
    )
    adapter.attach()

    const request = (requestId: string, subagent = false): void => {
      proxy.emit('event', {
        kind: 'request',
        requestId,
        method: 'POST',
        path: '/v1/responses',
        upstream: 'https://chatgpt.com/backend-api/codex/responses',
        endpoint: 'responses',
        ...(subagent ? { headers: { 'x-openai-subagent': 'collab_spawn' } } : {}),
      })
    }
    const chunk = (requestId: string): void => {
      proxy.emit('event', {
        kind: 'response-chunk',
        requestId,
        path: '/v1/responses',
        size: 0,
        chunk: Buffer.alloc(0),
        endpoint: 'responses',
      })
    }

    request('req-1')
    chunk('req-1')
    request('req-2', true)
    chunk('req-2')
    proxy.emit('event', {
      kind: 'response-error',
      requestId: 'req-2',
      path: '/v1/responses',
      endpoint: 'responses',
    })

    expect(observed.filter(event => event.requestId === 'req-2')).toMatchObject([
      { phase: 'created', cause: 'request-created' },
      { phase: 'ignored', cause: 'active-at-request', selected: false },
      { phase: 'failed', cause: 'response-error' },
    ])
    expect(observed.filter(event => event.requestId === 'req-2').every(
      event => event.subagentHeaderPresent,
    )).toBe(true)
  })

  it('keeps product semantic progression when a diagnostic listener throws', () => {
    const proxy = new RecordedProxy()
    const semantic = new SemanticChannel()
    const phases: string[] = []
    semantic.on('provider_request', () => {
      throw new Error('broken diagnostic sink')
    })
    semantic.on('stream_phase', event => phases.push(event.phase))
    adapter = new CodexResponsesAdapter(
      proxy as unknown as ResponsesProxy,
      { semantic } as never,
    )
    adapter.attach()

    expect(() => {
      proxy.emit('event', {
        kind: 'request',
        requestId: 'req-throwing-listener',
        method: 'POST',
        path: '/v1/responses',
        upstream: 'https://chatgpt.com/backend-api/codex/responses',
        endpoint: 'responses',
      })
      proxy.emit('event', {
        kind: 'response-chunk',
        requestId: 'req-throwing-listener',
        path: '/v1/responses',
        size: 0,
        chunk: Buffer.alloc(0),
        endpoint: 'responses',
      })
    }).not.toThrow()
    expect(phases).toContain('requesting')
  })
})
