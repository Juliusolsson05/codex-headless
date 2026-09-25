import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'

import { afterEach, expect, it } from 'vitest'

import { ResponsesProxy } from './responsesProxy.js'

// agent-code#369, the proxy half (#1238 review A, finding 3). In the recorded
// session behind testing/fixtures/flow-retention, 16 of 30 /v1/responses
// exchanges reached `response.completed` and then had NO response-end, no
// response-error and no upstream-error: the proxy never saw them finish.
// Codex closes its socket once it has read `response.completed`. The proxy
// dropped its client-gone listeners when upstream headers arrived, so from
// then on the only link was `nodeStream.pipe(res)`; when `res` closes, pipe
// unpipes and PAUSES the upstream stream and nobody destroys it. The undici
// body, its buffered bytes and the upstream socket then live for the rest of
// the process, invisible to the adapter's flow gauges.
//
// The upstream here replays the recorded (redacted) bytes of one of those
// exchanges and then holds the stream open, as a real upstream can after its
// last frame, so the only thing that can release it is the proxy noticing
// that the client left.

type RecordedEvent = { kind: string; requestId: string; chunk?: { utf8: string } }
const fixture = JSON.parse(readFileSync(
  new URL('../../testing/fixtures/flow-retention/completed-without-response-end.json', import.meta.url),
  'utf8',
)) as { events: RecordedEvent[] }
const recordedChunks = fixture.events
  .filter(e => e.requestId === 'req-15' && e.kind === 'response-chunk')
  .map(e => e.chunk!.utf8)

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

it('releases the upstream stream and reports the end when the client closes after response.completed', async () => {
  let upstreamClosed = false
  const upstream: Server = createServer((req, res) => {
    req.resume()
    // Only the proxied exchange counts. Local port scanners (Agent Code's own
    // lane-port probe, when the suite runs inside it) do hit this listener
    // with a stray `GET /`, and its close must not satisfy the assertion.
    if (req.url !== '/v1/responses') { res.end(); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of recordedChunks) res.write(chunk)
    // No res.end(): the stream stays open after its last recorded frame.
    res.on('close', () => { upstreamClosed = true })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => {
    upstream.closeAllConnections()
    upstream.close(() => resolve())
  }))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('upstream did not bind')

  const proxy = await ResponsesProxy.create({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    authMode: 'apikey',
  })
  cleanup.push(() => proxy.stop())
  const events: Array<{ kind: string; requestId?: string }> = []
  proxy.on('event', event => events.push(event))

  // Codex's behaviour: read until response.completed, then close the socket.
  await new Promise<void>((resolve, reject) => {
    const client = httpRequest(`${proxy.info.proxyBaseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => {
      let seen = ''
      res.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8')
        if (seen.includes('response.completed')) {
          client.destroy()
          resolve()
        }
      })
    })
    client.on('error', () => { /* destroyed on purpose */ })
    client.on('close', () => resolve())
    client.end('{}')
    setTimeout(() => reject(new Error('client never read response.completed')), 2_000)
  })

  const requestId = events.find(event => event.kind === 'request')?.requestId
  expect(requestId).toBeTruthy()
  await waitFor(() => upstreamClosed, 'the proxy to release the upstream stream')
  await waitFor(
    () => events.some(event => event.requestId === requestId && event.kind === 'response-end'),
    'a response-end for the exchange',
  )
})

// The other two ways an exchange ends must still report exactly ONE transport
// terminal: the client-close listener fires on every `res` close, including
// the one after a normal finish or an upstream failure, and a second terminal
// would contradict the first (#1238 review round 2, R2-1).
async function replayThroughProxy(finish: (res: import('node:http').ServerResponse) => void) {
  const upstream: Server = createServer((req, res) => {
    req.resume()
    if (req.url !== '/v1/responses') { res.end(); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of recordedChunks) res.write(chunk)
    finish(res)
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('upstream did not bind')
  const proxy = await ResponsesProxy.create({ upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`, authMode: 'apikey' })
  cleanup.push(() => proxy.stop())
  const events: Array<{ kind: string; requestId?: string; downstreamClosed?: boolean }> = []
  proxy.on('event', event => events.push(event))
  await new Promise<void>(resolve => {
    const client = httpRequest(`${proxy.info.proxyBaseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.resume()
      res.on('end', () => resolve())
      res.on('error', () => resolve())
      res.on('close', () => resolve())
    })
    client.on('error', () => resolve())
    client.end('{}')
  })
  // Let every late close/error listener run before counting.
  await new Promise(resolve => setTimeout(resolve, 100))
  return events.filter(event => ['response-end', 'response-error', 'upstream-error'].includes(event.kind))
}

it('reports exactly one response-end, not marked downstreamClosed, when the stream finishes normally', async () => {
  const terminals = await replayThroughProxy(res => res.end())
  expect(terminals).toEqual([expect.objectContaining({ kind: 'response-end' })])
  expect(terminals[0]!.downstreamClosed).toBeUndefined()
})

it('reports only the response-error when upstream fails mid-stream', async () => {
  const terminals = await replayThroughProxy(res => { setTimeout(() => res.socket?.destroy(), 20) })
  expect(terminals.map(event => event.kind)).toEqual(['response-error'])
})
