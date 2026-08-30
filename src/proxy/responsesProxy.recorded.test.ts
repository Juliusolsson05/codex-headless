import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { ResponsesProxy } from './responsesProxy.js'
import { decompressZstdBounded } from './zstd.js'

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
  '../../testing/fixtures/worktree-live-attribution/' +
    'codex-proxy-exact-identity-zstd.json',
  import.meta.url,
))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as
  ProxyIdentityFixture
const openServers: Server[] = []
const openProxies: ResponsesProxy[] = []
const zstd = zlib as typeof zlib & {
  zstdCompressSync?: (input: ArrayBufferView) => Buffer
  zstdDecompressSync?: (input: ArrayBufferView) => Buffer
}
const hasNativeZstd = typeof zstd.zstdCompressSync === 'function' &&
  typeof zstd.zstdDecompressSync === 'function'

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
  it('rejects bytes after the one recorded frame on every decoder path', () => {
    const recorded = Buffer.from(fixture.event.body_b64, 'base64')

    // WHY exercise the decoder directly: ResponsesProxy deliberately forwards
    // malformed optional telemetry, so proxy-level assertions only prove that
    // identity was omitted. These mutations pin the stricter invariant that
    // neither native Node nor the portable fallback accepts a valid prefix.
    expect(() => decompressZstdBounded(
      Buffer.concat([recorded, recorded]),
      16 * 1024 * 1024,
    )).toThrow('trailing or concatenated')
    expect(() => decompressZstdBounded(
      Buffer.concat([recorded, Buffer.of(0)]),
      16 * 1024 * 1024,
    )).toThrow('trailing or concatenated')
  })

  it('never trusts a corrupted checksum-bearing form of the recorded frame', () => {
    const recorded = Buffer.from(fixture.event.body_b64, 'base64')
    const checksummed = Buffer.concat([recorded, Buffer.alloc(4)])
    checksummed[4] = checksummed[4]! | 0x04

    // On Node 20/early 22 this proves the pure-JS path refuses checksums it
    // cannot verify. On native-zstd Node it proves checksum verification is
    // still delegated to the decoder after our structural boundary check.
    expect(() => decompressZstdBounded(checksummed, 16 * 1024 * 1024))
      .toThrow()
  })

  it('rejects blocks that expand beyond the frame-declared output size', () => {
    const recorded = Buffer.from(fixture.event.body_b64, 'base64')
    const nonFinalRecorded = Buffer.from(recorded)
    nonFinalRecorded[6] = nonFinalRecorded[6]! & 0xfe
    const overExpanding = Buffer.concat([
      nonFinalRecorded,
      // Final one-byte RLE block: the frame still declares the recorded 178
      // bytes, but a conforming decoder emits 179. fzstd's fixed-output API
      // used to truncate this byte and make the malformed identity look valid.
      Buffer.from([0x0b, 0x00, 0x00, 0x20]),
    ])

    expect(() => decompressZstdBounded(overExpanding, 16 * 1024 * 1024))
      .toThrow()
  })

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

  it('forwards a truncated recorded zstd request without projecting identity', async () => {
    const proxy = await ResponsesProxy.create({
      upstreamBaseUrl: await listenUpstream(),
      authMode: 'apikey',
    })
    openProxies.push(proxy)
    const events: Array<Record<string, unknown>> = []
    proxy.on('event', event => events.push(event))
    const recorded = Buffer.from(fixture.event.body_b64, 'base64')

    const response = await fetch(`${proxy.info.proxyBaseUrl}/responses`, {
      method: 'POST',
      headers: fixture.event.headers,
      body: recorded.subarray(0, recorded.length - 3),
    })

    expect(response.status).toBe(200)
    expect(events.find(event => event.kind === 'request'))
      .not.toHaveProperty('request_shape')
  })

  it.skipIf(!hasNativeZstd)(
    'retains unequal recorded metadata but emits no exact identity candidate',
    async () => {
      const proxy = await ResponsesProxy.create({
        upstreamBaseUrl: await listenUpstream(),
        authMode: 'apikey',
      })
      openProxies.push(proxy)
      const events: Array<Record<string, unknown>> = []
      proxy.on('event', event => events.push(event))
      const recorded = Buffer.from(fixture.event.body_b64, 'base64')
      const parsed = JSON.parse(
        zstd.zstdDecompressSync!(recorded).toString('utf8'),
      ) as { client_metadata: { session_id: string } }
      parsed.client_metadata.session_id = `${fixture.expected.sessionId}-changed`

      await fetch(`${proxy.info.proxyBaseUrl}/responses`, {
        method: 'POST',
        headers: fixture.event.headers,
        body: new Uint8Array(
          zstd.zstdCompressSync!(Buffer.from(JSON.stringify(parsed))),
        ),
      })

      const request = events.find(event => event.kind === 'request')
      expect(request?.request_shape).toMatchObject({
        provider_session_id: null,
        client_metadata: {
          thread_id: fixture.expected.threadId,
          session_id: `${fixture.expected.sessionId}-changed`,
        },
      })
    },
  )

  it.skipIf(!hasNativeZstd)(
    'does not decompress a mechanically expanded request beyond the cap',
    async () => {
      const proxy = await ResponsesProxy.create({
        upstreamBaseUrl: await listenUpstream(),
        authMode: 'apikey',
      })
      openProxies.push(proxy)
      const events: Array<Record<string, unknown>> = []
      proxy.on('event', event => events.push(event))
      const recorded = Buffer.from(fixture.event.body_b64, 'base64')
      const parsed = JSON.parse(
        zstd.zstdDecompressSync!(recorded).toString('utf8'),
      ) as Record<string, unknown>
      // This is a negative mutation of the recorded envelope, not a claimed live
      // case. It proves the parser cap itself: highly compressible filler must not
      // turn the private proxy into an unbounded main-process allocator.
      parsed.padding = 'x'.repeat(16 * 1024 * 1024)

      const response = await fetch(`${proxy.info.proxyBaseUrl}/responses`, {
        method: 'POST',
        headers: fixture.event.headers,
        body: new Uint8Array(
          zstd.zstdCompressSync!(Buffer.from(JSON.stringify(parsed))),
        ),
      })

      expect(response.status).toBe(200)
      expect(events.find(event => event.kind === 'request'))
        .not.toHaveProperty('request_shape')
    },
  )
})
