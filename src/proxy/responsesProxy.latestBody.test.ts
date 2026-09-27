import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { ResponsesProxy } from './responsesProxy.js'

// agent-code#1336: Agent Code's debug bundle tails the newest 5 MiB of
// proxy-events.jsonl. On Codex the response chunks are the bulk, so after a
// long stream the request event and its body_b64 fall out of the tail and the
// bundle has no prompt (40 of 65 recorded files, review C of #1332). The
// Claude addon solved the same loss with `latest-request-body.json`, which
// Agent Code already appends for any provider. These drive REAL requests
// through the proxy to a local upstream and read what lands on disk.

// Literal on purpose, not imported: Agent Code's reader looks for this exact
// name, and the test must fail on a proxy that never writes it.
const LATEST_REQUEST_BODY_FILE_NAME = 'latest-request-body.json'
// The Claude addon's sidecar cap, mirrored.
const LATEST_REQUEST_BODY_CAP = 16 * 1024 * 1024

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function startProxy(): Promise<{ proxy: ResponsesProxy; eventsFile: string; sidecar: string }> {
  const upstream: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n')
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('upstream did not bind')
  const dir = mkdtempSync(join(tmpdir(), 'cxh-latest-body-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const eventsFile = join(dir, 'proxy-events.jsonl')
  const proxy = await ResponsesProxy.create({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    authMode: 'apikey',
    eventsFile,
  })
  cleanup.push(() => proxy.stop())
  return { proxy, eventsFile, sidecar: join(dir, LATEST_REQUEST_BODY_FILE_NAME) }
}

function send(proxy: ResponsesProxy, path: string, method: string, body?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(`${proxy.info.proxyBaseUrl}${path}`, { method, headers: { 'content-type': 'application/json' } }, res => {
      res.resume()
      res.on('end', () => resolve())
    })
    client.on('error', reject)
    client.end(body)
  })
}

const sidecarLine = (path: string) => JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>

it('keeps the newest Responses request body next to the events file', async () => {
  const { proxy, sidecar } = await startProxy()
  const first = Buffer.from(JSON.stringify({ model: 'gpt-5', input: [{ role: 'user', content: 'first prompt' }] }))
  const second = Buffer.from(JSON.stringify({ model: 'gpt-5', input: [{ role: 'user', content: 'second prompt' }] }))

  await send(proxy, '/responses', 'POST', first)
  await send(proxy, '/responses', 'POST', second)
  await proxy.flushMirror()

  const line = sidecarLine(sidecar)
  expect(line).toMatchObject({ kind: 'request-body-latest', requestId: 'req-2', endpoint: 'responses' })
  expect(Buffer.from(line.body_b64 as string, 'base64').equals(second)).toBe(true)
  // One line: the reader appends it verbatim to the events tail.
  expect(readFileSync(sidecar, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
})

it('is not replaced by a bodiless /models refresh', async () => {
  const { proxy, sidecar } = await startProxy()
  const prompt = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: 'the prompt' }] }))
  await send(proxy, '/responses', 'POST', prompt)
  await send(proxy, '/models', 'GET')
  await proxy.flushMirror()

  expect(Buffer.from(sidecarLine(sidecar).body_b64 as string, 'base64').equals(prompt)).toBe(true)
})

it('removes the sidecar rather than keep an older prompt when the newest body is over the cap', async () => {
  const { proxy, sidecar } = await startProxy()
  await send(proxy, '/responses', 'POST', Buffer.from('{"input":"older prompt"}'))
  await proxy.flushMirror()
  expect(existsSync(sidecar)).toBe(true)

  await send(proxy, '/responses', 'POST', Buffer.alloc(LATEST_REQUEST_BODY_CAP + 1, 0x20))
  await proxy.flushMirror()
  expect(existsSync(sidecar)).toBe(false)
})

// #70 review a. Codex 0.157 title generation runs an ephemeral thread whose
// request carries an output schema (tui `thread_title.rs` through
// codex-api `create_text_param_for_request`: text.format, name
// `codex_output_schema`). It must not replace the main prompt.
it('keeps the main prompt when a title-generation request follows it', async () => {
  const { proxy, sidecar } = await startProxy()
  const prompt = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: 'the main prompt' }], tools: [{ type: 'function' }] }))
  const title = Buffer.from(JSON.stringify({
    input: [{ role: 'user', content: 'Generate a concise, single-line task title' }],
    text: { format: { type: 'json_schema', strict: true, name: 'codex_output_schema', schema: {} } },
  }))
  await send(proxy, '/responses', 'POST', prompt)
  await send(proxy, '/responses', 'POST', title)
  await proxy.flushMirror()

  expect(Buffer.from(sidecarLine(sidecar).body_b64 as string, 'base64').equals(prompt)).toBe(true)
})

it('records a compaction request, which also carries the conversation', async () => {
  const { proxy, sidecar } = await startProxy()
  const compact = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: 'compact me' }] }))
  await send(proxy, '/responses/compact', 'POST', compact)
  await proxy.flushMirror()

  expect(sidecarLine(sidecar)).toMatchObject({ endpoint: 'responses/compact' })
})
