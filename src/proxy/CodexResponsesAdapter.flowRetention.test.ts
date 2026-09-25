import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { createRecordedAdapterHarness } from './testing/adapterHarness.js'

// agent-code#369: main-process OOMs in long Codex runs pointed at flow state
// retained by this adapter. The recording behind this fixture shows why the
// terminator matters: in real traffic about HALF of all /v1/responses
// exchanges never get a `response-end` (the client closes after
// `response.completed`; 16 of 32 in the source session). For those, the SSE
// terminator is the ONLY thing that can release the flow; nothing else
// arrives until the watchdog.
//
// The fixture is minimized and redacted (see its `source`), but the event
// kinds, their order, the chunk count per response and which exchanges lack
// a `response-end` are recorded facts.

type RecordedEvent = {
  kind: string
  requestId: string
  chunk?: { utf8: string }
  [key: string]: unknown
}
const fixture = JSON.parse(readFileSync(
  new URL('../../testing/fixtures/flow-retention/completed-without-response-end.json', import.meta.url),
  'utf8',
)) as { events: RecordedEvent[] }

function replay(events: RecordedEvent[], proxy: { emit: (name: string, payload: unknown) => boolean }): void {
  for (const event of events) proxy.emit('event', toPayload(event))
}

function toPayload(event: RecordedEvent): unknown {
  return event.chunk ? { ...event, chunk: Buffer.from(event.chunk.utf8, 'utf8') } : event
}

const requests = [...new Set(fixture.events.filter(e => e.kind === 'request').map(e => e.requestId))]

it('holds no flow and no buffered text once each recorded response completes, response-end or not', () => {
  const { proxy, semantic, adapter } = createRecordedAdapterHarness()
  const rows: Array<{ requestId: string; phase: string; cause: string }> = []
  semantic.on('provider_request', (row: { requestId: string; phase: string; cause: string }) => rows.push(row))
  const ended = new Set(fixture.events.filter(e => e.kind === 'response-end').map(e => e.requestId))
  expect(requests.filter(id => !ended.has(id)).length).toBeGreaterThan(0)

  const midExchange: Array<{ requestId: string; flows: number; bufferedChars: number }> = []
  const afterEach: Array<{ requestId: string; flows: number; bufferedChars: number }> = []
  let current: string | null = null
  let sampledMid = false
  for (const event of fixture.events) {
    // Sample between exchanges: the moment the next request arrives, the
    // previous one must already be released.
    if (event.kind === 'request' && current !== null) afterEach.push({ requestId: current, ...adapter.diagnostics() })
    if (event.kind === 'request') { current = event.requestId; sampledMid = false }
    proxy.emit('event', toPayload(event))
    // WHY a positive control (#1238 review A): "0 flows" is also what a
    // replay that never CREATES a flow reads. Before the harness stubbed
    // observeProviderThreadIdentity the adapter threw on every request and
    // this test passed with zeros for the wrong reason; a diagnostics() that
    // always said 0 would pass the same way. After the first chunk the flow
    // must be visible.
    if (event.kind === 'response-chunk' && !sampledMid) {
      sampledMid = true
      midExchange.push({ requestId: event.requestId, ...adapter.diagnostics() })
    }
  }
  afterEach.push({ requestId: current!, ...adapter.diagnostics() })

  expect(midExchange.map(({ requestId, flows }) => ({ requestId, flows })))
    .toEqual(requests.map(requestId => ({ requestId, flows: 1 })))
  // Every recorded first chunk ends mid-frame, so the partial frame is held:
  // the other half of the positive control, for the bufferedChars gauge.
  expect(midExchange.every(sample => sample.bufferedChars > 0)).toBe(true)
  expect(afterEach).toEqual(requests.map(requestId => ({ requestId, flows: 0, bufferedChars: 0 })))
  // The release must not cost the request its outcome (#1238 review A): each
  // recorded exchange, response-end or not, is selected and records exactly
  // one terminal, `completed` at the semantic terminal, never a later
  // `cancelled` from the transport. Deleting the flow without publishing
  // first would leave the no-response-end exchanges with no terminal at all.
  for (const requestId of requests) {
    const own = rows.filter(row => row.requestId === requestId)
    expect(own.some(row => row.phase === 'selected')).toBe(true)
    expect(own.filter(row => !['created', 'selected', 'ignored'].includes(row.phase)))
      .toEqual([expect.objectContaining({ phase: 'completed', cause: 'semantic-terminal' })])
  }
})

it('parses nothing after response.completed when later frames share its chunk', () => {
  // Recorded bytes, coalesced: req-15's whole stream and req-21's frames
  // arrive as ONE chunk on req-15. Real traffic had no bytes after
  // response.completed (0 of 30 exchanges), but a coalescing socket is
  // allowed to deliver them together, and the flow must stop at its terminal
  // instead of publishing the next stream's turn as its own.
  const { proxy, semantic } = createRecordedAdapterHarness()
  const turns: string[] = []
  semantic.on('turn_started', (ev: { turnId: string }) => turns.push(ev.turnId))
  const bytesOf = (requestId: string): string => fixture.events
    .filter(e => e.requestId === requestId && e.kind === 'response-chunk')
    .map(e => e.chunk!.utf8)
    .join('')
  const header = fixture.events.filter(e => e.requestId === 'req-15' && (e.kind === 'request' || e.kind === 'response'))
  replay(header, proxy)
  const coalesced = Buffer.from(bytesOf('req-15') + bytesOf('req-21'), 'utf8')
  proxy.emit('event', { kind: 'response-chunk', requestId: 'req-15', path: '/v1/responses', size: coalesced.length, chunk: coalesced })

  expect(turns).toEqual(['resp_0447ac33000e95f5016ab63ae5afd487d08cfe46f57a92c43e'])
})
