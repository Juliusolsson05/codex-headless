import { watch } from 'chokidar'
import {
  closeSync,
  createReadStream,
  fstatSync,
  openSync,
  readSync,
  statSync,
  type ReadStream,
} from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { basename } from 'path'

// Node-only (chokidar + fs). Used by downstream applications that need
// to tail CC's transcript files. NOT importable from browser contexts.

/**
 * Watches a single JSONL file and emits parsed objects line-by-line as the
 * file grows. Append-only: it remembers a byte offset and reads everything
 * past it on the tick of a private polling timer.
 *
 * Partial trailing lines are buffered until the next read brings the
 * terminating newline.
 *
 * Why a private stat poll instead of chokidar/fs.watchFile:
 *   chokidar on macOS defaults to fs.watch-based change detection for
 *   single files, which is known to silently miss rapid appends from
 *   non-editor writers (append-only files that don't atomic-rename).
 *   Users saw it concretely: submit a prompt, CC writes
 *   the user entry + a bunch of attachments to the JSONL, and the
 *   feed wouldn't update until some unrelated later write nudged
 *   chokidar into re-reading. "The prompt didn't appear."
 *
 *   A direct timer polls stat() on an interval. Unlike fs.watchFile it has
 *   no hidden first-baseline registration phase, so an append during startup
 *   cannot become the baseline and disappear until a watchdog fires. At
 *   100ms interval the latency is imperceptible
 *   (~half a human reaction time), the CPU cost is trivial (one stat
 *   call every 100ms per tailer), and it's reliable on every fs/OS
 *   combination because it doesn't rely on kernel event delivery.
 *
 * Concurrency: `readNew()` can be triggered while a previous read is
 * still in flight — the fs.read stream is async, so its `end` handler
 * (where `offset` is advanced) runs on a future tick. Without
 * serialization a second trigger could read from a stale offset,
 * producing duplicate emits AND stomping `offset` backwards in the
 * first call's `end` handler. The `reading` / `pendingRead` flags
 * below form a simple "queue at most one re-entry" pattern: while a
 * read is in flight, subsequent triggers just set `pendingRead`; when
 * the in-flight read completes we immediately re-run if anything was
 * queued. This guarantees strict serialization with zero unbounded
 * queuing and zero concurrency.
 */
export class FileTailer<T> {
  private offset = 0
  private buffer = ''
  private closed = false
  // Poll interval for fs.watchFile in milliseconds. 100ms gives
  // reliable pickup with imperceptible latency and negligible CPU.
  // Tuning lower doesn't noticeably help humans; tuning higher
  // starts to show up as "typing feels sluggish" when submit →
  // feed-update takes noticeable wall time.
  private static readonly POLL_INTERVAL_MS = 100
  // Resume bootstrap intentionally reads a bounded tail slice instead
  // of the whole rollout. The goal is "show the recent context and
  // start following new appends", not "hydrate a megabyte-scale
  // historical archive before first paint". 512 KB is large enough to
  // hold the last few hundred normal JSONL lines even when some tool
  // outputs are chunky, while still capping startup cost.
  // (Doc back-ported from claude-code-headless's copy — the rationale
  // was written there after this file was forked. agent-code#394 §8.)
  private static readonly BOOTSTRAP_TAIL_BYTES = 512 * 1024
  private reading = false
  private pendingRead = false
  private poller: ReturnType<typeof setInterval> | null = null
  private fileIdentity: string | null = null
  private fileCtimeMs: number | null = null
  private activeStream: ReadStream | null = null
  private activeRead: Promise<void> | null = null

  constructor(
    private readonly filePath: string,
    private readonly onEntry: (entry: T) => void,
    private readonly onError?: (err: Error) => void,
    options?: {
      /**
       * When set, do NOT replay the whole file from byte 0 on startup.
       * Instead, synchronously parse only the most recent N complete
       * JSONL lines, then begin tailing from EOF for future appends.
       *
       * Used by resume flows so long rollouts open at the current end
       * of the conversation instead of making the renderer watch
       * thousands of historical entries stream by.
       */
      bootstrapTailLines?: number
      /** @deprecated Direct private polling no longer needs a watcher-stall watchdog. */
      watchdogMs?: number
    },
  ) {
    const bootstrapTailLines = options?.bootstrapTailLines ?? 0
    if (bootstrapTailLines > 0) {
      this.bootstrapTail(bootstrapTailLines)
    } else {
      // Begin reading whatever is already in the file during construction —
      // CC often writes several entries before the watcher would tick. The
      // stream itself is asynchronous; serialized timer ticks reconcile any
      // append that lands while that initial stream is in flight.
      this.readNew()
    }
    // WHY each tailer owns its timer: closing one session can never unregister another session's
    // observer for the same rollout path, and there is no watcher-baseline handoff in which a write
    // can disappear. The read serializer coalesces ticks while disk I/O is active.
    this.poller = setInterval(() => this.readNew(), FileTailer.POLL_INTERVAL_MS)
    this.poller.unref?.()
  }

  private bootstrapTail(maxLines: number): void {
    if (this.closed || maxLines <= 0) return

    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.filePath)
    } catch {
      return
    }
    if (stat.size <= 0) {
      this.offset = 0
      this.fileIdentity = `${stat.dev}:${stat.ino}`
      this.fileCtimeMs = stat.ctimeMs
      return
    }

    const bytesToRead = Math.min(FileTailer.BOOTSTRAP_TAIL_BYTES, stat.size)
    const start = Math.max(0, stat.size - bytesToRead)
    const buf = Buffer.alloc(bytesToRead)

    let fd: number | null = null
    try {
      fd = openSync(this.filePath, 'r')
      readSync(fd, buf, 0, bytesToRead, start)
    } catch (err) {
      this.onError?.(err as Error)
      if (fd !== null) {
        try { closeSync(fd) } catch { /* best-effort */ }
      }
      return
    }
    try {
      closeSync(fd)
    } catch {
      // best-effort close
    }

    let text = buf.toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
    }

    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)

    const recent = lines.slice(-maxLines)
    for (const line of recent) {
      try {
        const obj = JSON.parse(line) as T
        this.emitEntry(obj)
      } catch (err) {
        this.emitError(err as Error)
      }
    }

    this.offset = stat.size
    this.fileIdentity = `${stat.dev}:${stat.ino}`
    this.fileCtimeMs = stat.ctimeMs
    this.buffer = ''
  }

  private readNew(): void {
    if (this.closed) return
    if (this.reading) {
      // A read is in flight; queue a re-run instead of starting a
      // concurrent stream. See the class block comment for why
      // concurrent reads are unsafe.
      this.pendingRead = true
      return
    }
    this.reading = true

    let fd: number | null = null
    let stat: ReturnType<typeof fstatSync>
    try {
      // Open before fstat and give that same descriptor to the stream. An atomic rename between a
      // path stat and createReadStream would otherwise let offset/identity describe the old inode
      // while bytes came from the replacement.
      fd = openSync(this.filePath, 'r')
      stat = fstatSync(fd)
    } catch {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* best-effort */ }
      }
      // File temporarily missing — atomic-rename writers do this.
      // Skip and wait for the next poll tick.
      this.reading = false
      return
    }
    const identity = `${stat.dev}:${stat.ino}`
    if (
      this.fileIdentity !== null &&
      (
        identity !== this.fileIdentity ||
        stat.size < this.offset ||
        // truncate+rewrite can return to exactly the old byte length between two polls. ctime is
        // the only remaining evidence that the inode's contents changed at a non-growing offset.
        (stat.size === this.offset && this.fileCtimeMs !== null && stat.ctimeMs !== this.fileCtimeMs)
      )
    ) {
      // Rollouts are usually append-only, but log rotation and truncate-in-place both occur in real
      // tooling. Offsets belong to one inode generation; carrying either the byte position or an
      // unterminated fragment into the next generation silently skips or corrupts its first event.
      this.offset = 0
      this.buffer = ''
    }
    this.fileIdentity = identity
    this.fileCtimeMs = stat.ctimeMs
    if (stat.size <= this.offset) {
      closeSync(fd)
      this.reading = false
      // If a re-run was queued while we were between the guard and
      // here, we still need to honor it even though this stat was a
      // no-op — the file may have grown between the two stats.
      if (this.pendingRead) {
        this.pendingRead = false
        this.readNew()
      }
      return
    }

    const stream = createReadStream(this.filePath, {
      fd,
      autoClose: true,
      start: this.offset,
      end: stat.size - 1,
      encoding: 'utf8',
    })
    this.activeStream = stream
    let settleActiveRead!: () => void
    this.activeRead = new Promise<void>((resolve) => { settleActiveRead = resolve })

    let chunk = ''
    stream.on('data', d => {
      if (!this.closed) chunk += d
    })
    stream.on('end', () => {
      if (this.closed) return
      this.offset = stat.size
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      // Last element is either '' (clean newline) or a partial line.
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed) as T
          this.emitEntry(obj)
        } catch (err) {
          this.emitError(err as Error)
        }
      }
    })
    stream.on('error', err => {
      if (!this.closed) this.emitError(err)
    })
    stream.on('close', () => {
      this.reading = false
      this.activeStream = null
      this.activeRead = null
      settleActiveRead()
      if (!this.closed && this.pendingRead) {
        this.pendingRead = false
        this.readNew()
      }
    })
  }

  private emitEntry(entry: T): void {
    try {
      this.onEntry(entry)
    } catch (error) {
      this.emitError(error as Error)
    }
  }

  private emitError(error: Error): void {
    try {
      this.onError?.(error)
    } catch {
      // Consumer diagnostics must not strand `reading=true`; tail ownership remains ours.
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.activeRead
      return
    }
    this.closed = true
    if (this.poller !== null) clearInterval(this.poller)
    this.poller = null
    const activeRead = this.activeRead
    this.activeStream?.destroy()
    // WHY close awaits the stream boundary: callers replace sessions by closing the old tailer and
    // then trusting that no old callback can mutate the new session. Merely destroying the stream
    // schedules close asynchronously and leaves a post-close callback race.
    await activeRead
  }
}

export type JsonlEntry = Record<string, unknown>

/**
 * Watches a CC project directory for the JSONL file CC creates when the
 * session starts, then tails it. Use case:
 *
 *   1. The consumer spawns `claude` with cwd=X
 *   2. Before/right after spawn, we call `tailNewSessionFile(projectDir, ...)`
 *   3. CC creates ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
 *   4. The tailer notices the new .jsonl, opens it, and starts emitting entries
 *
 * Returns a stop() function that tears down both the directory watcher
 * and the file tailer.
 */
export async function tailNewSessionFile(
  projectDir: string,
  onEntry: (entry: JsonlEntry, file: string) => void,
  onError?: (err: Error) => void,
): Promise<() => Promise<void>> {
  // Ensure the directory exists. CC creates it on first write but we want
  // to attach the watcher BEFORE CC is spawned so we can't miss the create
  // event. mkdir -p is harmless if it already exists.
  await mkdir(projectDir, { recursive: true })

  // Snapshot the existing files so we can ignore them and only pick up
  // a NEW jsonl produced by the session we're about to start.
  const existing = new Set<string>()
  try {
    for (const name of await readdir(projectDir)) {
      if (name.endsWith('.jsonl')) existing.add(name)
    }
  } catch (err) {
    onError?.(err as Error)
  }

  let tailer: FileTailer<JsonlEntry> | null = null

  const dirWatcher = watch(projectDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: false,
  })

  dirWatcher.on('add', filePath => {
    const name = basename(filePath)
    if (!name.endsWith('.jsonl')) return
    if (existing.has(name)) return
    if (tailer) return // Already tailing the first new session file
    tailer = new FileTailer<JsonlEntry>(
      filePath,
      entry => onEntry(entry, filePath),
      onError,
    )
  })

  dirWatcher.on('error', err => onError?.(err as Error))

  return async () => {
    await dirWatcher.close()
    if (tailer) await tailer.close()
  }
}

/**
 * Convenience for tailing a specific session file by absolute path
 * (when the file is already known).
 */
export function tailSessionFile<T extends JsonlEntry = JsonlEntry>(
  filePath: string,
  onEntry: (entry: T) => void,
  onError?: (err: Error) => void,
  options?: {
    bootstrapTailLines?: number
  },
): () => Promise<void> {
  const tailer = new FileTailer<T>(filePath, onEntry, onError, options)
  return async () => {
    await tailer.close()
  }
}
