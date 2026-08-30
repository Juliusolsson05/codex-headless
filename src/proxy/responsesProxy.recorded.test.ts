import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { ResponsesProxy } from './responsesProxy.js'

type ProxyIdentityFixture = {
  event: {
    body_b64: string
    headers: Record<string, string>
  }
  expected: {
    threadId: string
    sessionId: string
    rootTurnId: string
  }
}

const fixturePath = fileURLToPath(new URL(
  '../../../../testing/fixtures/worktree-live-attribution/' +
    'codex-proxy-exact-identity-zstd.json',
  import.meta.url,
))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as
  ProxyIdentityFixture
const openServers: Server[] = []
const openProxies: ResponsesProxy[] = []

afterEach(async () => {
  await Promise.all(openProxies.splice(0).map(proxy => proxy.stop()))
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
  })))
})

async function listenUpstream(): Promise<string> {
  const server = createServer((request, response) => {
    request.resume()
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream')
    response.end()
  })
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('recorded proxy upstream did not bind')
  }
  return `http://127.0.0.1:${address.port}/v1`
}

describe('recorded Codex proxy request identity', () => {
  it('extracts exact provider identity from the recorded zstd body', async () => {
    const proxy = await ResponsesProxy.create({
      upstreamBaseUrl: await listenUpstream(),
      authMode: 'apikey',
    })
    openProxies.push(proxy)
    const events: Array<Record<string, unknown>> = []
    proxy.on('event', event => events.push(event))

    const response = await fetch(`${proxy.info.proxyBaseUrl}/responses`, {
      method: 'POST',
      headers: fixture.event.headers,
      body: Buffer.from(fixture.event.body_b64, 'base64'),
    })
    expect(response.status).toBe(200)

    const request = events.find(event => event.kind === 'request')
    // WHY the expectation comes from the independently round-tripped corpus:
    // all complaint-time requests had this nesting and compression. Parsing a
    // convenient uncompressed literal would leave the real broken boundary
    // untested and recreate the false confidence behind the current shape.
    expect(request?.request_shape).toMatchObject({
      provider_session_id: fixture.expected.threadId,
      client_metadata: {
        thread_id: fixture.expected.threadId,
        session_id: fixture.expected.sessionId,
        root_turn_id: fixture.expected.rootTurnId,
      },
    })
  })
})
