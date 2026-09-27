import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { EventsMirror, rotatedMirrorPath } from './eventsMirror.js'
import { ResponsesProxy } from './responsesProxy.js'

// agent-code#372: the mirror was one synchronous append per event with no
// cap. A real 3 h Codex session wrote 103.5 MB, 91% of it chunk lines, and
// the recorded median chunk benchmarked at a worst single append of 74 ms on
// the main process. These pin the bounded, asynchronous replacement.
//
// Lines are built from a RECORDED chunk (Codex 0.157 `/v1/models`, 2,865
// bytes; testing/fixtures/proxy-mirror/models-chunk-2865.json) so sizes and
// caps are measured on what real events serialise to.
const models = JSON.parse(readFileSync(
  new URL('../../testing/fixtures/proxy-mirror/models-chunk-2865.json', import.meta.url),
  'utf8',
)) as { path: string; size: number; base64: string }
const chunk = Buffer.from(models.base64, 'base64')
const event = (n: number) => ({ kind: 'response-chunk', requestId: `req-${n}`, path: models.path, size: chunk.length, chunk })
// One recorded event's line on disk, newline included.
const LINE_BYTES = Buffer.byteLength(JSON.stringify({ ...event(0), chunk: { _buffer_b64: models.base64 } }) + '\n')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cxh-mirror-bound-'))
  dirs.push(dir)
  return join(dir, 'proxy-events.jsonl')
}
const linesOf = (path: string) => existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
  : []

// Red on main: the old mirror had the line on disk before emit returned.
it('does not write to disk on the emitting call', async () => {
  const file = tempFile()
  const proxy = new ResponsesProxy({} as never, file)
  proxy.emit('event', event(1))
  expect(existsSync(file) ? statSync(file).size : 0).toBe(0)
  await proxy.flushMirror()
  expect(linesOf(file).map(line => line.requestId)).toEqual(['req-1'])
})

// Red on main: nothing ever rotated, so one file grew without bound.
it('rotates to one previous file, keeping the newest events complete and in order', async () => {
  const file = tempFile()
  const cap = LINE_BYTES * 3
  const proxy = new ResponsesProxy({} as never, file, { eventsFileMaxBytes: cap })
  for (let n = 1; n <= 10; n += 1) {
    proxy.emit('event', event(n))
    // One event at a time, as a stream delivers them; also lets the first
    // open finish (a rotation waits for it).
    await proxy.flushMirror()
  }
  const previous = linesOf(rotatedMirrorPath(file))
  const current = linesOf(file)
  // Both files stay within the cap: disk per run is bounded at two files.
  expect(statSync(file).size).toBeLessThanOrEqual(cap)
  expect(statSync(rotatedMirrorPath(file)).size).toBeLessThanOrEqual(cap)
  // Each rotated-into file opens with a marker that counts the rotations.
  expect(current[0]).toMatchObject({ kind: 'mirror-rotated', droppedEvents: 0 })
  expect(previous[0]).toMatchObject({ kind: 'mirror-rotated' })
  const rotations = (current[0] as { rotations: number }).rotations
  expect(rotations).toBe((previous[0] as { rotations: number }).rotations + 1)
  // The events kept are the NEWEST ones, contiguous, ending with the last.
  const kept = [...previous, ...current].filter(line => line.kind === 'response-chunk').map(line => line.requestId)
  expect(kept.at(-1)).toBe('req-10')
  const first = Number(String(kept[0]).slice(4))
  expect(kept).toEqual(Array.from({ length: 10 - first + 1 }, (_, i) => `req-${first + i}`))
  // Every kept chunk is still byte-exact.
  for (const line of [...previous, ...current].filter(line => line.kind === 'response-chunk')) {
    expect(Buffer.from((line.chunk as { _buffer_b64: string })._buffer_b64, 'base64').equals(chunk)).toBe(true)
  }
})

// A burst faster than the disk: the queue is bounded, the excess is dropped
// and counted, and the gap is marked in the file where it happened.
it('drops and counts lines past the queue bound, and marks the gap before the next line', async () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxQueuedBytes: LINE_BYTES * 2 })
  for (let n = 1; n <= 6; n += 1) mirror.write(event(n))
  expect(mirror.stats()).toMatchObject({ droppedEvents: 4, droppedBytes: LINE_BYTES * 4 })
  await mirror.flush()
  mirror.write(event(7))
  await mirror.close()
  const lines = linesOf(file)
  expect(lines.map(line => line.kind === 'response-chunk' ? line.requestId : line.kind))
    .toEqual(['req-1', 'req-2', 'mirror-dropped', 'req-7'])
  expect(lines[2]).toMatchObject({ droppedEvents: 4, droppedBytes: LINE_BYTES * 4 })
})

// The old catch turned a failed append into "no on-disk record". The stream
// version must do the same: an unhandled 'error' would crash the main process.
it('turns itself off on an unwritable path without throwing or starving listeners', async () => {
  const file = join(tempFile(), 'missing-dir', 'proxy-events.jsonl')
  const proxy = new ResponsesProxy({} as never, file)
  const seen: unknown[] = []
  proxy.on('event', payload => seen.push(payload))
  expect(() => proxy.emit('event', event(1))).not.toThrow()
  await proxy.flushMirror()
  expect(() => proxy.emit('event', event(2))).not.toThrow()
  await proxy.flushMirror()
  expect(seen).toHaveLength(2)
  expect(existsSync(file)).toBe(false)
})

// The mirror is asynchronous, so a session teardown must wait for it or the
// last events of a run are lost.
it('has every event on disk once stop() resolves', async () => {
  const file = tempFile()
  const proxy = await ResponsesProxy.create({ eventsFile: file, authMode: 'apikey', upstreamBaseUrl: 'http://127.0.0.1:9' })
  for (let n = 1; n <= 20; n += 1) proxy.emit('event', event(n))
  await proxy.stop()
  expect(linesOf(file).map(line => line.requestId)).toEqual(Array.from({ length: 20 }, (_, i) => `req-${i + 1}`))
})

// A burst that passes the cap before the stream has even opened its file
// (the first events of a run). Renaming then would move a file the stream has
// not opened, or fail on one that does not exist yet, and lose the burst.
// The rotation waits for the open instead; the overshoot is bounded by the
// queue bound.
it('keeps a burst that passes the cap before the file is open', async () => {
  const file = tempFile()
  const proxy = new ResponsesProxy({} as never, file, { eventsFileMaxBytes: LINE_BYTES * 3 })
  for (let n = 1; n <= 10; n += 1) proxy.emit('event', event(n))
  await proxy.flushMirror()
  const kept = [...linesOf(rotatedMirrorPath(file)), ...linesOf(file)]
    .filter(line => line.kind === 'response-chunk').map(line => line.requestId)
  expect(kept).toEqual(Array.from({ length: 10 }, (_, i) => `req-${i + 1}`))
})
