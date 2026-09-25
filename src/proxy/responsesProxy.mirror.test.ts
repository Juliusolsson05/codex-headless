import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { ResponsesProxy } from './responsesProxy.js'

// agent-code#372: the on-disk mirror was meant to inline chunk bytes as
// `{ _buffer_b64 }` (API.md), but JSON.stringify calls Buffer#toJSON BEFORE
// the replacer, so the replacer never saw a Buffer and every chunk was
// written as `{"type":"Buffer","data":[123,34,…]}`. That is 3.65× the payload
// on the recorded 3.19 GB session file (2,266 MiB of chunk lines for 621 MiB
// of chunk bytes).

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function mirrorOf(payload: unknown): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'cxh-mirror-'))
  dirs.push(dir)
  const file = join(dir, 'proxy-events.jsonl')
  const proxy = new ResponsesProxy({} as never, file)
  proxy.emit('event', payload)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]!) as Record<string, unknown>
}

// A recorded event, field for field (Codex 0.157.0, 2026-09-25): 204 bytes
// on disk in the decimal-array form.
const recorded = () => ({
  kind: 'response-chunk',
  requestId: 'req-3',
  path: '/v1/responses',
  size: 24,
  chunk: Buffer.from('event: response.created\n', 'utf8'),
})

it('inlines a recorded chunk as base64 that round-trips its bytes', () => {
  const line = mirrorOf(recorded())
  const chunk = line.chunk as { _buffer_b64?: string }
  expect(chunk._buffer_b64).toBeDefined()
  expect(Buffer.from(chunk._buffer_b64!, 'base64').toString('utf8')).toBe('event: response.created\n')
  // base64 is 4/3 of the payload; the decimal array was about 3.65×.
  expect(JSON.stringify(chunk).length).toBeLessThan(24 * 4 / 3 + 20)
})

it('keeps a chunk that splits a UTF-8 character byte-exact', () => {
  // A network chunk boundary can fall inside a multi-byte character, which
  // is why the mirror stores bytes (base64) and not text.
  const bytes = Buffer.from('data: å\n', 'utf8').subarray(0, 7)
  const line = mirrorOf({ ...recorded(), size: bytes.length, chunk: bytes })
  expect(Buffer.from((line.chunk as { _buffer_b64: string })._buffer_b64, 'base64').equals(bytes)).toBe(true)
})
