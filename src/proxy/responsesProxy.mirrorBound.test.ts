import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
    // One event at a time, as a stream delivers them.
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
  // The marker records the size of the file it rotated away (#56 review B4),
  // which is now `.1`.
  expect((current[0] as { rotatedBytes: number }).rotatedBytes).toBe(statSync(rotatedMirrorPath(file)).size)
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
  // Off means off: once the directory exists, a later event must not start
  // a mirror that the run already gave up on (#56 review B).
  mkdirSync(dirname(file), { recursive: true })
  proxy.emit('event', event(3))
  await proxy.flushMirror()
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
  // A late event after stop (a socket torn down afterwards) is not written:
  // the mirror is closed, not merely flushed (#56 review B3).
  proxy.emit('event', event(21))
  await proxy.flushMirror()
  expect(linesOf(file)).toHaveLength(20)
})

// The first events of a run arrive as a burst, before any await. The file is
// opened synchronously, so even then each file stays within its cap and the
// newest events are kept in order (#56 review A3: deferring the rotation
// until an async open finished let the file pass its cap).
it('rotates a burst at the start of a run within the cap', async () => {
  const file = tempFile()
  const cap = LINE_BYTES * 3
  const proxy = new ResponsesProxy({} as never, file, { eventsFileMaxBytes: cap })
  for (let n = 1; n <= 10; n += 1) proxy.emit('event', event(n))
  await proxy.flushMirror()
  expect(statSync(file).size).toBeLessThanOrEqual(cap)
  expect(statSync(rotatedMirrorPath(file)).size).toBeLessThanOrEqual(cap)
  const kept = [...linesOf(rotatedMirrorPath(file)), ...linesOf(file)]
    .filter(line => line.kind === 'response-chunk').map(line => Number(String(line.requestId).slice(4)))
  expect(kept.at(-1)).toBe(10)
  expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => 10 - kept.length + 1 + i))
})

// #56 review A3: a restart appends to a run file that is already at its cap.
// The size is read from the opened fd, so the very first event rotates.
it('rotates on the first event when a restart finds the file at its cap', async () => {
  const file = tempFile()
  const cap = LINE_BYTES * 2
  writeFileSync(file, [1, 2].map(n => JSON.stringify({ ...event(n), chunk: { _buffer_b64: models.base64 } }) + '\n').join(''))
  expect(statSync(file).size).toBe(cap)
  const mirror = new EventsMirror(file, { maxFileBytes: cap })
  mirror.write(event(3))
  await mirror.close()
  expect(linesOf(rotatedMirrorPath(file)).map(line => line.requestId)).toEqual(['req-1', 'req-2'])
  expect(linesOf(file).map(line => line.kind === 'response-chunk' ? line.requestId : line.kind)).toEqual(['mirror-rotated', 'req-3'])
  expect(statSync(file).size).toBeLessThanOrEqual(cap)
})

// #56 review B2: a line that cannot fit in any file is dropped and counted,
// never written over the cap.
it('drops a line bigger than the whole file cap, and says so', async () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxFileBytes: 200 })
  mirror.write(event(1))
  await mirror.close()
  expect(mirror.stats()).toMatchObject({ droppedEvents: 1, droppedBytes: LINE_BYTES })
  expect(statSync(file).size).toBeLessThanOrEqual(200)
  expect(linesOf(file)).toEqual([{ kind: 'mirror-dropped', droppedEvents: 1, droppedBytes: LINE_BYTES }])
})

// #56 review B1: drops at the very end of a run have no next line to carry
// their marker; close() must write it, or the file looks complete.
it('marks drops at the end of a run on close', async () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxQueuedBytes: LINE_BYTES * 2 })
  for (let n = 1; n <= 6; n += 1) mirror.write(event(n))
  await mirror.close()
  expect(linesOf(file).map(line => line.kind === 'response-chunk' ? line.requestId : line.kind))
    .toEqual(['req-1', 'req-2', 'mirror-dropped'])
})

// #56 round-3 review A/C: close() writes its drop marker only after the
// queue has drained, so the marker never sits on top of a full queue.
it('keeps the close-time drop marker within the queue bound', async () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxQueuedBytes: LINE_BYTES })
  const internals = mirror as unknown as { queuedBytes: number; put(sink: unknown, text: string): void }
  let peak = 0
  const put = internals.put.bind(mirror)
  internals.put = (sink, text) => { put(sink, text); peak = Math.max(peak, internals.queuedBytes) }
  mirror.write(event(1))
  mirror.write(event(2))
  await mirror.close()
  expect(peak).toBeLessThanOrEqual(LINE_BYTES)
  expect(linesOf(file).map(line => line.kind === 'response-chunk' ? line.requestId : line.kind)).toEqual(['req-1', 'mirror-dropped'])
})

// Steering q62: a queue cap smaller than a marker line. Nothing may exceed it,
// markers included: the event is dropped, the marker cannot be written, and
// the drop is still counted.
it('never exceeds a queue cap smaller than a marker', async () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxQueuedBytes: 1 })
  const internals = mirror as unknown as { queuedBytes: number; put(sink: unknown, text: string): void }
  let peak = 0
  const put = internals.put.bind(mirror)
  internals.put = (sink, text) => { put(sink, text); peak = Math.max(peak, internals.queuedBytes) }
  mirror.write(event(1))
  await mirror.close()
  expect(peak).toBeLessThanOrEqual(1)
  expect(mirror.stats()).toMatchObject({ droppedEvents: 1, droppedBytes: LINE_BYTES })
  expect(linesOf(file)).toEqual([])
})

// #56 review A2: the queue bound is on everything unwritten, across a
// rotation. Before, the fresh stream had an empty queue of its own and took
// more while the old one still held its lines.
it('bounds the queue across a rotation', () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxFileBytes: LINE_BYTES * 2 + 200, maxQueuedBytes: LINE_BYTES * 3 + 400 })
  for (let n = 1; n <= 6; n += 1) mirror.write(event(n))
  // 1-2 fill the first file, 3 rotates (its marker and line are queued), and
  // 4-6 would push the total past the bound.
  expect(mirror.stats()).toMatchObject({ rotations: 1, droppedEvents: 3 })
  return mirror.close()
})

// #56 review A1: a rotated-out stream that fails must not hang flush() or
// close(), and must not take the healthy live file down with it.
it('settles flush and close when a rotated-out stream fails', async () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxFileBytes: LINE_BYTES * 2 + 200 })
  mirror.write(event(1))
  mirror.write(event(2))
  // The reviewer's sequence: the old file is fully written, then it rotates
  // and fails while the NEW file's writes are still in flight.
  await mirror.flush()
  const old = (mirror as unknown as { sink: { stream: { destroy(error: Error): void } } }).sink.stream
  mirror.write(event(3))
  old.destroy(new Error('old stream failed'))
  mirror.write(event(4))
  const settled = await Promise.race([
    mirror.flush().then(() => mirror.close()).then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 2000)),
  ])
  expect(settled).toBe('settled')
  expect(linesOf(file).map(line => line.kind === 'response-chunk' ? line.requestId : line.kind)).toEqual(['mirror-rotated', 'req-3', 'req-4'])
})

// #56 round-2 review A1: the test above cannot control WHEN Node delivers the
// old stream's error, so it did not pin the accounting. Here the failure is
// delivered synchronously while the live file's write is certainly pending:
// only the failed stream's share may be given back, or flush() reports idle
// while the live write is still in flight (and later goes negative).
it('gives back only the failed stream\'s share of pending writes', async () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxFileBytes: LINE_BYTES * 2 + 200 })
  type Internals = { sink: object; pendingWrites: number; fail(sink: object): void }
  const internals = mirror as unknown as Internals
  mirror.write(event(1))
  mirror.write(event(2))
  await mirror.flush()
  const oldSink = internals.sink
  mirror.write(event(3))
  expect(internals.sink).not.toBe(oldSink)
  const pendingOnLive = internals.pendingWrites
  expect(pendingOnLive).toBeGreaterThan(0)
  internals.fail(oldSink)
  expect(internals.pendingWrites).toBe(pendingOnLive)
  await mirror.close()
  expect(internals.pendingWrites).toBe(0)
  expect(linesOf(file).map(line => line.kind === 'response-chunk' ? line.requestId : line.kind)).toEqual(['mirror-rotated', 'req-3'])
})

// #56 round-2 review C1: a line that fits no file (the rotation marker plus
// the line exceed the cap) is dropped WITHOUT rotating. Rotating first
// evicted the accepted event 1 for three events that were dropped anyway.
it('never evicts kept events to make room for a line that cannot fit', async () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxFileBytes: LINE_BYTES })
  for (let n = 1; n <= 4; n += 1) {
    mirror.write(event(n))
    await mirror.flush()
  }
  await mirror.close()
  expect(mirror.stats()).toMatchObject({ droppedEvents: 3, rotations: expect.any(Number) })
  const kept = [...linesOf(rotatedMirrorPath(file)), ...linesOf(file)]
  expect(kept.filter(line => line.kind === 'response-chunk').map(line => line.requestId)).toEqual(['req-1'])
  expect(statSync(file).size).toBeLessThanOrEqual(LINE_BYTES)
})

// #56 round-2 review A3 (and C's surviving mutant): the cap counts the
// rotation marker. A line that fits alone but not with the marker in front
// of it cannot start a fresh file, so it is dropped rather than written over
// the cap.
it('counts the rotation marker against the file cap', async () => {
  const file = tempFile()
  const cap = LINE_BYTES + 50
  const mirror = new EventsMirror(file, { maxFileBytes: cap })
  mirror.write(event(1))
  await mirror.flush()
  mirror.write(event(2))
  await mirror.close()
  expect(mirror.stats()).toMatchObject({ droppedEvents: 1 })
  for (const path of [file, rotatedMirrorPath(file)]) {
    if (existsSync(path)) expect(statSync(path).size).toBeLessThanOrEqual(cap)
  }
  const kept = [...linesOf(rotatedMirrorPath(file)), ...linesOf(file)]
  expect(kept.filter(line => line.kind === 'response-chunk').map(line => line.requestId)).toEqual(['req-1'])
})

// #56 round-2 review A2: the queue bound counts marker bytes too. Two lines
// that fit the queue alone do not fit it once the second one's rotation
// marker is added.
it('counts the rotation marker against the queue', () => {
  const file = tempFile()
  const mirror = new EventsMirror(file, { maxFileBytes: LINE_BYTES + 200, maxQueuedBytes: LINE_BYTES * 2 + 10 })
  mirror.write(event(1))
  mirror.write(event(2))
  expect(mirror.stats()).toMatchObject({ droppedEvents: 1, rotations: 0 })
  expect((mirror as unknown as { queuedBytes: number }).queuedBytes).toBeLessThanOrEqual(LINE_BYTES * 2 + 10)
  return mirror.close()
})

// #56 review B3: the 64 MiB default is the documented bound. The run file is
// pre-sized (sparse, so no 64 MB is written; an earlier version wrote ~70 MB
// of real events and timed out under load) to just under the default, as a
// restart would find it; one recorded event must then rotate it, and one
// event less must not.
it('rotates at the 64 MiB default', async () => {
  const DEFAULT = 64 * 1024 * 1024
  const fits = tempFile()
  writeFileSync(fits, '')
  truncateSync(fits, DEFAULT - LINE_BYTES)
  const underCap = new ResponsesProxy({} as never, fits)
  underCap.emit('event', event(1))
  await underCap.stop()
  expect(existsSync(rotatedMirrorPath(fits))).toBe(false)
  expect(statSync(fits).size).toBe(DEFAULT)

  const over = tempFile()
  writeFileSync(over, '')
  truncateSync(over, DEFAULT - LINE_BYTES + 1)
  const atCap = new ResponsesProxy({} as never, over)
  atCap.emit('event', event(1))
  await atCap.stop()
  expect(statSync(rotatedMirrorPath(over)).size).toBe(DEFAULT - LINE_BYTES + 1)
  expect(linesOf(over).map(line => line.kind === 'response-chunk' ? line.requestId : line.kind)).toEqual(['mirror-rotated', 'req-1'])
})
