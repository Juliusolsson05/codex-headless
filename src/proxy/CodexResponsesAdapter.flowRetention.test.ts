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

it('holds no flow and no buffered text once each recorded response completes, response-end or not', () => {
  const { proxy, adapter } = createRecordedAdapterHarness()
  const ended = new Set(fixture.events.filter(e => e.kind === 'response-end').map(e => e.requestId))
  const requests = [...new Set(fixture.events.filter(e => e.kind === 'request').map(e => e.requestId))]
  expect(requests.filter(id => !ended.has(id)).length).toBeGreaterThan(0)

  const afterEach: Array<{ requestId: string; flows: number; bufferedChars: number }> = []
  let current: string | null = null
  for (const event of fixture.events) {
    // Sample between exchanges: the moment the next request arrives, the
    // previous one must already be released.
    if (event.kind === 'request' && current !== null) afterEach.push({ requestId: current, ...adapter.diagnostics() })
    if (event.kind === 'request') current = event.requestId
    const payload = event.chunk
      ? { ...event, chunk: Buffer.from(event.chunk.utf8, 'utf8') }
      : event
    proxy.emit('event', payload)
  }
  afterEach.push({ requestId: current!, ...adapter.diagnostics() })

  expect(afterEach).toEqual(requests.map(requestId => ({ requestId, flows: 0, bufferedChars: 0 })))
})
