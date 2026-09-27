import { createWriteStream, fstatSync, openSync, renameSync, type WriteStream } from 'fs'

// The on-disk JSONL mirror of every proxy event (agent-code#372).
//
// WHY this is its own module and not inline in ResponsesProxy.emit: the old
// inline mirror was one `appendFileSync` per event with no cap. On a real
// 3-hour Codex session that was 13,890 chunk appends (91% of a 103.5 MB file)
// and, benchmarked on the recorded median chunk, a p99 of 2 ms and a worst
// single append of 74 ms, all on the Electron main process before any
// listener ran. With ~15 sessions live the proxy directory grew by gigabytes
// a day. Bounding it needs state (bytes in the file, a queue, counters,
// rotation), which does not belong in an emit override.
//
// The three rules, and why each one:
//
// 1. ASYNC, ORDERED. One `fs.WriteStream` per file. A stream keeps write
//    order (forensic readback depends on it; the old comment on the sync
//    append said an async tap would let events race, which is true of
//    independent `appendFile` calls, not of one stream).
//
// 2. BOUNDED QUEUE, DROP AND COUNT. If the disk is slower than the stream
//    (a large burst, a slow volume), the stream's buffer would otherwise
//    grow without bound in memory, which is the pressure #369/#372 were
//    about. Past `maxQueuedBytes` a line is dropped, counted, and the gap
//    is marked in the file right before the next line that is written.
//
// 3. ROTATE, KEEPING ONE PREVIOUS FILE. When the next line would push the
//    file past `maxFileBytes`, the file becomes `<name>.1.jsonl` (replacing
//    any earlier one) and a fresh file starts. Disk per run is at most two
//    files. WHY rotate rather than omit payloads past a budget, as the
//    Claude addon does for request bodies (agent-code#1273): on Claude the
//    bodies are the bulk and the responses stay; on Codex the response
//    chunks ARE the bulk, so omitting them would drop exactly the recent
//    traffic a debug bundle is for (proxyEventsReader tails the newest
//    5 MiB). Rotation keeps the newest traffic complete.
//
// Everything here is best-effort: a mirror failure must never break the
// live proxy. Errors disable the mirror silently, as the old catch did.

export const DEFAULT_MIRROR_MAX_FILE_BYTES = 64 * 1024 * 1024
export const DEFAULT_MIRROR_MAX_QUEUED_BYTES = 16 * 1024 * 1024

export type EventsMirrorOptions = {
  /** Rotate once the file would grow past this many bytes. */
  maxFileBytes?: number
  /** Drop (and count) lines while this many bytes are queued unwritten. */
  maxQueuedBytes?: number
}

export type EventsMirrorStats = {
  droppedEvents: number
  droppedBytes: number
  rotations: number
}

/** `proxy-events.jsonl` → `proxy-events.1.jsonl`. Exported so readers
 *  (Agent Code's debug-bundle reader) derive the same name. */
export function rotatedMirrorPath(path: string): string {
  return path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.1.jsonl` : `${path}.1`
}

// One file's stream plus what is still unwritten on it. Accounting is per
// stream because a rotated-out stream can still be flushing, or fail, while
// the next one takes writes (#56 review A1: a shared counter zeroed by an old
// stream's error went negative and hung flush() and stop() forever).
type Sink = { stream: WriteStream; pendingWrites: number; queuedBytes: number; dead: boolean }

export class EventsMirror {
  private readonly path: string
  private readonly maxFileBytes: number
  private readonly maxQueuedBytes: number
  private sink: Sink | null = null
  private fileBytes = 0
  private disabled = false
  private droppedEvents = 0
  private droppedBytes = 0
  // Drops already reported in the file, so each marker is written once per
  // new gap rather than before every line.
  private reportedDrops = 0
  private rotations = 0
  // Totals over every live sink, current and rotated-out. The queue bound is
  // on the TOTAL (#56 review A2): a slow disk with a rotation in between
  // must not hold one queue per generation.
  private pendingWrites = 0
  private queuedBytes = 0
  private idleWaiters: Array<() => void> = []
  private readonly closes = new Set<Promise<void>>()

  constructor(path: string, options: EventsMirrorOptions = {}) {
    this.path = path
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MIRROR_MAX_FILE_BYTES
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MIRROR_MAX_QUEUED_BYTES
  }

  write(payload: unknown): void {
    if (this.disabled) return
    let line: string
    try {
      line = serialiseMirrorEvent(payload) + '\n'
    } catch {
      // An unserialisable payload (a cycle, a throwing getter) was dropped by
      // the old catch too. It is not a disk-pressure drop, so not counted.
      return
    }
    this.append(line)
  }

  /** Resolves once every accepted line has reached the OS. */
  flush(): Promise<void> {
    if (this.pendingWrites === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  /** Marks any unreported drops, flushes, closes every stream, and refuses
   *  later writes. */
  async close(): Promise<void> {
    if (!this.disabled) {
      // #56 review B1: drops at the very end of a run have no "next line" to
      // carry their marker, so without this the file would look complete.
      // Drained FIRST (#56 round-3 review A/C): a marker-only write has no line
      // bytes to check against the queue, so writing it onto a full queue put
      // one marker over the bound. On an empty queue it is the only thing
      // queued.
      await this.flush()
      if (this.droppedEvents > this.reportedDrops) this.append('')
      await this.flush()
      this.disabled = true
      const sink = this.sink
      this.sink = null
      if (sink) this.retire(sink)
    }
    await Promise.all([...this.closes])
  }

  stats(): EventsMirrorStats {
    return { droppedEvents: this.droppedEvents, droppedBytes: this.droppedBytes, rotations: this.rotations }
  }

  /**
   * Writes `line` (possibly empty, to write only a pending drop marker) so
   * that EVERY file stays within `maxFileBytes`, markers included, and the
   * unwritten total, markers included, stays within `maxQueuedBytes`.
   * Anything that cannot fit is dropped and counted; there is no "overshoot
   * a little" exception (#56 reviews A3, A4, B2 each found one, and each
   * made the advertised bound false).
   *
   * WHY every decision is made BEFORE rotating (#56 round-2 review C1): a
   * rotation replaces the previous `.1`. Rotating first and only then
   * finding that the line cannot fit even a fresh file evicted accepted
   * events for a line that was dropped anyway: with a cap of one line,
   * three rejected events rotated three times and left only markers. The
   * rotation marker is deterministic (its counts are known now), so the
   * fresh file's first write can be measured before anything is renamed.
   */
  private append(line: string): void {
    const bytes = Buffer.byteLength(line)
    const sink = this.open()
    if (!sink) return
    let prefix = this.dropMarker()
    let rotate = false
    if (this.fileBytes + Buffer.byteLength(prefix) + bytes > this.maxFileBytes) {
      const marker = this.rotationMarker()
      if (this.fileBytes === 0 || Buffer.byteLength(marker) + bytes > this.maxFileBytes) {
        // It fits no file: drop it without touching what is already kept.
        // The drop is reported by the next marker that fits (or at close).
        if (bytes > 0) {
          this.drop(bytes)
          return
        }
        // A marker-only write (close) that does not fit the current file:
        // rotate for it if it fits a fresh one, else give up on it.
        if (this.fileBytes === 0 || Buffer.byteLength(marker) > this.maxFileBytes) return
      }
      prefix = marker
      rotate = true
    }
    // The marker counts against the queue too (#56 round-2 review A2). A
    // line bigger than the whole queue budget is dropped here as well.
    const total = Buffer.byteLength(prefix) + bytes
    if (bytes > 0 && this.queuedBytes + total > this.maxQueuedBytes) {
      this.drop(bytes)
      return
    }
    if (rotate && this.rotate() === null) return
    this.reportedDrops = this.droppedEvents
    if (total > 0) this.put(this.sink!, prefix + line)
  }

  /** The first line of the file a rotation would start now. */
  private rotationMarker(): string {
    return JSON.stringify({
      kind: 'mirror-rotated',
      rotatedBytes: this.fileBytes,
      rotations: this.rotations + 1,
      droppedEvents: this.droppedEvents,
      droppedBytes: this.droppedBytes,
    }) + '\n'
  }

  private dropMarker(): string {
    if (this.droppedEvents <= this.reportedDrops) return ''
    return JSON.stringify({
      kind: 'mirror-dropped',
      droppedEvents: this.droppedEvents,
      droppedBytes: this.droppedBytes,
    }) + '\n'
  }

  private drop(bytes: number): void {
    this.droppedEvents += 1
    this.droppedBytes += bytes
  }

  private open(): Sink | null {
    if (this.sink) return this.sink
    try {
      // WHY a synchronous open (one syscall per file, so once per 64 MiB):
      // with the stream's own async open, the stream is "pending" for a
      // while, and a rename in that window moves a file the stream has not
      // opened yet, so it would create a second file under the old name.
      // The first version deferred rotation until the open finished, which
      // let a startup burst, or a restart onto a file already at its cap,
      // leave the file over its cap (#56 review A3). With the fd in hand the
      // stream is never pending, and the size comes from that same fd.
      const fd = openSync(this.path, 'a')
      this.fileBytes = fstatSync(fd).size
      const stream = createWriteStream(this.path, { fd })
      const sink: Sink = { stream, pendingWrites: 0, queuedBytes: 0, dead: false }
      // WITHOUT this listener an open or write failure (disk full,
      // permissions) is an unhandled 'error' and crashes the main process.
      stream.on('error', () => this.fail(sink))
      this.sink = sink
      return sink
    } catch {
      this.disabled = true
      return null
    }
  }

  /** Renames the current file to `.1` and opens a fresh one. Returns the
   *  rotated file's size, or null when the mirror had to turn itself off. */
  private rotate(): number | null {
    const old = this.sink!
    this.sink = null
    const rotatedBytes = this.fileBytes
    this.retire(old)
    try {
      // The old stream keeps its fd, so lines still queued on it land in
      // the renamed file, which is where they belong. POSIX renames an open
      // file; libuv opens with FILE_SHARE_DELETE on Windows, so it works
      // there too. The rename replaces any earlier `.1`.
      renameSync(this.path, rotatedMirrorPath(this.path))
    } catch {
      // Cannot rotate, so the file could only grow past its cap. Stop
      // mirroring rather than break the bound.
      this.disabled = true
      return null
    }
    this.rotations += 1
    return this.open() ? rotatedBytes : null
  }

  private put(sink: Sink, text: string): void {
    const bytes = Buffer.byteLength(text)
    this.fileBytes += bytes
    sink.pendingWrites += 1
    sink.queuedBytes += bytes
    this.pendingWrites += 1
    this.queuedBytes += bytes
    sink.stream.write(text, () => {
      // A failed sink already gave back everything it held (fail()).
      if (sink.dead) return
      sink.pendingWrites -= 1
      sink.queuedBytes -= bytes
      this.pendingWrites -= 1
      this.queuedBytes -= bytes
      this.wakeIfIdle()
    })
  }

  private retire(sink: Sink): void {
    const closed = endStream(sink.stream).finally(() => this.closes.delete(closed))
    this.closes.add(closed)
  }

  private fail(sink: Sink): void {
    if (sink.dead) return
    sink.dead = true
    // Its remaining writes will never complete; give their share back so
    // flush() can settle. Only THIS sink's share: another sink's writes are
    // still real (#56 review A1).
    this.pendingWrites -= sink.pendingWrites
    this.queuedBytes -= sink.queuedBytes
    sink.pendingWrites = 0
    sink.queuedBytes = 0
    // Only the current file failing turns the mirror off. A rotated-out one
    // failing loses its own tail, but the live file is still healthy.
    if (this.sink === sink) {
      this.disabled = true
      this.sink = null
    }
    try { sink.stream.destroy() } catch { /* already gone */ }
    this.wakeIfIdle()
  }

  private wakeIfIdle(): void {
    if (this.pendingWrites === 0) for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise(resolve => {
    if (stream.destroyed) return resolve()
    stream.once('close', () => resolve())
    stream.once('error', () => resolve())
    stream.end()
  })
}

/**
 * One event as a JSON line, with every Buffer inlined as `{ _buffer_b64 }`.
 *
 * WHY the replacer reads `this[key]` and not `value` (agent-code#372):
 * JSON.stringify calls a value's toJSON BEFORE the replacer, and Buffer has
 * one, so `value` is already {type:'Buffer',data:[…]} and an instanceof check
 * on it never matches. The first version of this replacer was written that
 * way and never fired: every chunk ever mirrored was a decimal byte array,
 * 3.65× its payload (2,266 MiB of chunk lines for 621 MiB of bytes in one
 * 3.19 GB session file). The holder still has the raw Buffer. A regular
 * function, not an arrow, so `this` is that holder. Cost (#53 review C):
 * `this[key]` reads each property a second time, so a getter runs twice;
 * event payloads are plain literals today. A throwing getter drops the whole
 * event, so keep getters out of mirrored payloads.
 */
export function serialiseMirrorEvent(payload: unknown): string {
  return JSON.stringify(payload, function (this: Record<string, unknown>, key, value) {
    const raw = this[key]
    if (Buffer.isBuffer(raw)) return { _buffer_b64: raw.toString('base64') }
    return value
  })
}
