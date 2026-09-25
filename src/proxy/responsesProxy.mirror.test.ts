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

// The raw mirrored line, so size is measured on what reaches disk.
function mirrorLineOf(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cxh-mirror-'))
  dirs.push(dir)
  const file = join(dir, 'proxy-events.jsonl')
  const proxy = new ResponsesProxy({} as never, file)
  proxy.emit('event', payload)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n').filter(line => line.length > 0)
  expect(lines).toHaveLength(1)
  return lines[0]!
}

function mirrorOf(payload: unknown): Record<string, unknown> {
  return JSON.parse(mirrorLineOf(payload)) as Record<string, unknown>
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
})

// #53 review B: a size bound on a 24-byte chunk says nothing about the
// chunks that fill the file (987 of the first 1,000 recorded ones exceed
// 24 bytes; median 260, max 16,384). This recorded 2,865-byte chunk was a
// 10,692-byte line; base64 plus the event fields must stay near 4/3.
const models = JSON.parse(readFileSync(
  new URL('../../testing/fixtures/proxy-mirror/models-chunk-2865.json', import.meta.url),
  'utf8',
)) as { path: string; size: number; oldMirroredLineBytes: number; base64: string }

it('mirrors a recorded full-size chunk byte-exact at base64 size, measured on the line', () => {
  const bytes = Buffer.from(models.base64, 'base64')
  expect(bytes.length).toBe(models.size)
  const payload = { kind: 'response-chunk', requestId: 'req-2', path: models.path, size: models.size, chunk: bytes }
  const line = mirrorLineOf(payload)
  const chunk = (JSON.parse(line) as { chunk: { _buffer_b64: string } }).chunk
  expect(Buffer.from(chunk._buffer_b64, 'base64').equals(bytes)).toBe(true)
  const fields = JSON.stringify({ ...payload, chunk: { _buffer_b64: '' } }).length
  expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(fields + Math.ceil(bytes.length / 3) * 4 + 1)
  expect(Buffer.byteLength(line)).toBeLessThan(models.oldMirroredLineBytes / 2)
})

// #53 review A: the replacer handles a Buffer anywhere in an event, not only
// at `chunk` (API.md promises it for every Buffer payload).
it('inlines a nested Buffer too', () => {
  const line = mirrorOf({ kind: 'probe', body: { nested: [Buffer.from([0, 255])] } })
  expect((line.body as { nested: unknown[] }).nested[0]).toEqual({ _buffer_b64: 'AP8=' })
})

it('keeps a chunk that splits a UTF-8 character byte-exact', () => {
  // A network chunk boundary can fall inside a multi-byte character, which
  // is why the mirror stores bytes (base64) and not text.
  const bytes = Buffer.from('data: å\n', 'utf8').subarray(0, 7)
  const line = mirrorOf({ ...recorded(), size: bytes.length, chunk: bytes })
  expect(Buffer.from((line.chunk as { _buffer_b64: string })._buffer_b64, 'base64').equals(bytes)).toBe(true)
})

// #53 review C: every test above writes ONE event into a fresh file, so an
// overwrite instead of an append, a missing newline, a mirror of non-'event'
// emits, or a non-UTF-8 write would all pass. A real dump is thousands of
// events in order; this is the smallest session that pins that.
it('appends every event as its own UTF-8 line, in order, and mirrors only "event" emits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cxh-mirror-'))
  dirs.push(dir)
  const file = join(dir, 'proxy-events.jsonl')
  const proxy = new ResponsesProxy({} as never, file)
  proxy.on('other', () => undefined)
  proxy.emit('event', recorded())
  proxy.emit('other', { kind: 'must-not-be-mirrored' })
  proxy.emit('event', { kind: 'response-error', requestId: 'req-3', message: 'upstream said: överbelastad ✗' })
  const text = readFileSync(file, 'utf8')
  expect(text.endsWith('\n')).toBe(true)
  const lines = text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as { kind: string; message?: string })
  expect(lines.map(line => line.kind)).toEqual(['response-chunk', 'response-error'])
  expect(lines[1]!.message).toBe('upstream said: överbelastad ✗')
})

// #53 review C: the replacer must return stringify's own value for anything
// that is not a Buffer, so a value with its own toJSON (a Date) keeps it.
it('leaves values with their own toJSON as JSON renders them', () => {
  const at = new Date('2026-09-25T00:00:00.000Z')
  expect(mirrorOf({ kind: 'probe', at }).at).toBe('2026-09-25T00:00:00.000Z')
})
