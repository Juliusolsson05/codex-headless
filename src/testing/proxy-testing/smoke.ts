#!/usr/bin/env tsx
// Proxy-only smoke test — no codex spawn, no API calls, no credits burned.
//
// Verifies the non-network parts of the proxy stack:
//   1. ResponsesProxy.create() binds a port and resolves info cleanly.
//   2. detectAuthMode reads ~/.codex/auth.json without throwing.
//   3. The adapter attaches without crashing.
//   4. An unmapped /v1/ path responds with a forwarded request (we
//      hit the proxy with a curl-style fetch to a fake endpoint and
//      confirm the proxy emits a `request` event).
//   5. stop() tears down cleanly.
//
// Run: `npx tsx src/testing/proxy-testing/smoke.ts`
// Exit code is 0 on success, 1 on any failure.

import { CodexHeadless } from '../../CodexHeadless.js'
import { ResponsesProxy } from '../../proxy/responsesProxy.js'
import { CodexResponsesAdapter } from '../../proxy/CodexResponsesAdapter.js'
import { SemanticChannel } from '../../channels/SemanticChannel.js'

// Because we want to test attach() without spawning a real PTY, we
// construct a CodexHeadless-shaped duck with only the channels the
// adapter touches. The adapter never reads anything else off it —
// see CodexResponsesAdapter.attach / onProxyEvent.
function makeFakeHeadless(): CodexHeadless {
  const semantic = new SemanticChannel()
  return { semantic } as unknown as CodexHeadless
}

async function main(): Promise<void> {
  let ok = true

  process.stderr.write('[smoke] starting ResponsesProxy...\n')
  const proxy = await ResponsesProxy.create()
  process.stderr.write(
    `[smoke] proxy bound: ${proxy.info.proxyBaseUrl}\n` +
      `[smoke] auth mode: ${proxy.info.authMode}\n` +
      `[smoke] upstream:  ${proxy.info.upstreamBaseUrl}\n`,
  )

  // 1. Bind sanity
  if (!proxy.info.proxyBaseUrl.startsWith('http://127.0.0.1:')) {
    process.stderr.write(`[smoke] FAIL: proxy didn't bind loopback\n`)
    ok = false
  }

  // 2. Adapter attach
  const headless = makeFakeHeadless()
  const adapter = new CodexResponsesAdapter(proxy, headless)
  adapter.attach()
  process.stderr.write('[smoke] adapter attached\n')

  // 3. Trap proxy events so we can observe what happened.
  let sawRequestEvent = false
  let sawRejectedEvent = false
  proxy.on('event', ev => {
    if (ev.kind === 'request') sawRequestEvent = true
    if (ev.kind === 'rejected') sawRejectedEvent = true
  })

  // 4. Hit an invalid path — proxy should 404 with `rejected`.
  //    This tests the path-filter gate without touching upstream.
  const rejectRes = await fetch(`${proxy.info.proxyBaseUrl.replace('/v1', '')}/`, {
    method: 'GET',
  })
  process.stderr.write(`[smoke] GET / → ${rejectRes.status} (expected 404)\n`)
  if (rejectRes.status !== 404) {
    process.stderr.write(`[smoke] FAIL: root probe should 404\n`)
    ok = false
  }
  if (!sawRejectedEvent) {
    process.stderr.write(`[smoke] FAIL: proxy did not emit 'rejected' event\n`)
    ok = false
  }

  // 5. Hit a valid-shaped path (forwards upstream). We cancel the fetch
  //    immediately so we don't actually talk to OpenAI — we're only
  //    testing that the proxy accepted the path and emitted `request`.
  const controller = new AbortController()
  const forwardPromise = fetch(`${proxy.info.proxyBaseUrl}/fake-endpoint-for-smoke`, {
    method: 'POST',
    body: 'ignored',
    signal: controller.signal,
  }).catch(() => { /* expected — we aborted */ })
  // Give the proxy a few ms to register the request event, then abort.
  await new Promise(r => setTimeout(r, 100))
  controller.abort()
  await forwardPromise

  if (!sawRequestEvent) {
    process.stderr.write(`[smoke] FAIL: proxy did not emit 'request' event on valid path\n`)
    ok = false
  } else {
    process.stderr.write(`[smoke] saw 'request' event — path classifier works\n`)
  }

  // 6. Clean shutdown — must resolve quickly (no hanging SSE sockets).
  const stopStart = Date.now()
  adapter.detach()
  await proxy.stop()
  const stopMs = Date.now() - stopStart
  process.stderr.write(`[smoke] proxy.stop() returned in ${stopMs}ms\n`)
  if (stopMs > 2000) {
    process.stderr.write(`[smoke] FAIL: stop took too long (>2s)\n`)
    ok = false
  }

  if (ok) {
    process.stderr.write('[smoke] PASS\n')
    process.exit(0)
  } else {
    process.stderr.write('[smoke] FAIL\n')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('[smoke] fatal:', err)
  process.exit(1)
})
