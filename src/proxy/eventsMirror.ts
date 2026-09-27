import { createWriteStream, renameSync, statSync, type WriteStream } from 'fs'

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

export class EventsMirror {
  private readonly path: string
  private readonly maxFileBytes: number
  private readonly maxQueuedBytes: number
  private stream: WriteStream | null = null
  private fileBytes = 0
  private disabled = false
  private droppedEvents = 0
  private droppedBytes = 0
  // Drops already reported in the file, so each marker is written once per
  // new gap rather than before every line.
  private reportedDrops = 0
  private rotations = 0
  // Writes handed to a stream whose callback has not fired yet, across the
  // current and any rotated-out stream. flush() waits for this to reach 0.
  private inFlight = 0
  private idleWaiters: Array<() => void> = []
  private closes: Promise<void>[] = []

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
    const bytes = Buffer.byteLength(line)
    const stream = this.open()
    if (!stream) return

    // WHY `writableLength > 0` in the condition: a single line bigger than
    // the whole queue budget (a 2 MiB request body under a tiny test budget)
    // is still written when nothing else is waiting, so the bound is "the
    // queue never holds more than one oversized line", never "this event can
    // never be mirrored".
    if (stream.writableLength > 0 && stream.writableLength + bytes > this.maxQueuedBytes) {
      this.droppedEvents += 1
      this.droppedBytes += bytes
      return
    }

    // WHY `!stream.pending`: until the stream has opened its fd, renaming
    // the path would move the file out from under a stream that has not
    // opened it yet, and the stream would then create a NEW file at the old
    // name, interleaving with the fresh one. Deferring the rotation to a
    // later write lets the file overshoot the cap by what arrives during one
    // open (milliseconds), which keeps the bound in practice.
    if (this.fileBytes > 0 && this.fileBytes + bytes > this.maxFileBytes && !stream.pending) {
      if (!this.rotate()) return
    }

    const current = this.stream!
    if (this.droppedEvents > this.reportedDrops) {
      this.put(current, JSON.stringify({
        kind: 'mirror-dropped',
        droppedEvents: this.droppedEvents,
        droppedBytes: this.droppedBytes,
      }) + '\n')
      this.reportedDrops = this.droppedEvents
    }
    this.put(current, line)
  }

  /** Resolves once every accepted line has reached the OS. */
  flush(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  /** Flushes, closes every stream, and refuses later writes. */
  async close(): Promise<void> {
    if (this.disabled && !this.stream) {
      await Promise.all(this.closes)
      return
    }
    await this.flush()
    this.disabled = true
    const stream = this.stream
    this.stream = null
    if (stream) this.closes.push(endStream(stream))
    await Promise.all(this.closes)
  }

  stats(): EventsMirrorStats {
    return { droppedEvents: this.droppedEvents, droppedBytes: this.droppedBytes, rotations: this.rotations }
  }

  private open(): WriteStream | null {
    if (this.stream) return this.stream
    try {
      // The size survives a restart that appends to the same run file, so
      // the cap counts what is already there.
      try { this.fileBytes = statSync(this.path).size } catch { this.fileBytes = 0 }
      const stream = createWriteStream(this.path, { flags: 'a' })
      // WITHOUT this listener an open or write failure (missing directory,
      // disk full, permissions) is an unhandled 'error' and crashes the main
      // process. With it, the mirror turns itself off and the proxy carries on.
      stream.on('error', () => this.disable(stream))
      this.stream = stream
      return stream
    } catch {
      this.disabled = true
      return null
    }
  }

  private rotate(): boolean {
    const old = this.stream!
    this.stream = null
    this.closes.push(endStream(old))
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
      return false
    }
    const rotatedBytes = this.fileBytes
    this.rotations += 1
    const fresh = this.open()
    if (!fresh) return false
    // The marker carries the cumulative drops, so it also reports any gap
    // not yet marked.
    this.put(fresh, JSON.stringify({
      kind: 'mirror-rotated',
      rotatedBytes,
      rotations: this.rotations,
      droppedEvents: this.droppedEvents,
      droppedBytes: this.droppedBytes,
    }) + '\n')
    this.reportedDrops = this.droppedEvents
    return true
  }

  private put(stream: WriteStream, text: string): void {
    this.fileBytes += Buffer.byteLength(text)
    this.inFlight += 1
    stream.write(text, () => {
      this.inFlight -= 1
      if (this.inFlight === 0) for (const resolve of this.idleWaiters.splice(0)) resolve()
    })
  }

  private disable(stream: WriteStream): void {
    this.disabled = true
    if (this.stream === stream) this.stream = null
    // A failed stream never calls its pending write callbacks, so release
    // anyone waiting on flush(); there is nothing left to wait for.
    this.inFlight = 0
    for (const resolve of this.idleWaiters.splice(0)) resolve()
    try { stream.destroy() } catch { /* already gone */ }
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
