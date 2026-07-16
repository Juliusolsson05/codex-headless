import { watch } from 'chokidar'
import {
  closeSync,
  createReadStream,
  openSync,
  readSync,
  statSync,
  unwatchFile,
  watchFile,
  type Stats,
} from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { basename } from 'path'

// Node-only (chokidar + fs). Used by downstream applications that need
// to tail CC's transcript files. NOT importable from browser contexts.

/**
 * Watches a single JSONL file and emits parsed objects line-by-line as the
 * file grows. Append-only: it remembers a byte offset and reads everything
 * past it on the tick of a polling-based stat watcher.
 *
 * Partial trailing lines are buffered until the next read brings the
 * terminating newline.
 *
 * Why fs.watchFile (poll) instead of chokidar's fs.watch path:
 *   chokidar on macOS defaults to fs.watch-based change detection for
 *   single files, which is known to silently miss rapid appends from
 *   non-editor writers (append-only files that don't atomic-rename).
 *   Users saw it concretely: submit a prompt, CC writes
 *   the user entry + a bunch of attachments to the JSONL, and the
 *   feed wouldn't update until some unrelated later write nudged
 *   chokidar into re-reading. "The prompt didn't appear."
 *
 *   fs.watchFile polls stat() on an interval and fires whenever
 *   size/mtime changes. At 100ms interval the latency is imperceptible
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
  // Stall watchdog window. 15s is ~150 missed polls — unambiguous death,
  // never a slow disk. Cheap: one stat per window per tailer.
  private static readonly WATCHDOG_MS = 15_000
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
  /**
   * The stat listener MUST be stored and passed to unwatchFile on close.
   * WHY: `unwatchFile(path)` with no listener removes EVERY stat-watcher
   * for that path in the whole process (Node semantics). agent-code's
   * replaceSession spawns the new session before killing the old one, and
   * on an in-place resume both tail the SAME rollout file — so the old
   * session's close was deterministically killing the new pane's watcher.
   * That was the root cause of the "dead committed channel" / "prompt
   * stuck in queue" bug family (agent-code residue plan 2026-07, P0):
   * prompts landed in the rollout 12ms after submit and were never
   * ingested because this tail was dead.
   */
  private statListener: ((curr: Stats, prev: Stats) => void) | null = null
  /** Wall-clock of the last successful readNew kick — feeds the stall
   *  watchdog below. */
  private lastPollAt = Date.now()
  private watchdog: ReturnType<typeof setInterval> | null = null

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
      /**
       * Stall-watchdog window override. Production default (15s) is
       * unambiguous watcher death; tests shrink it so the self-heal
       * path is exercisable in milliseconds. 0/undefined = default.
       */
      watchdogMs?: number
    },
  ) {
    const bootstrapTailLines = options?.bootstrapTailLines ?? 0
    if (bootstrapTailLines > 0) {
      this.bootstrapTail(bootstrapTailLines)
    } else {
      // Begin reading whatever is already in the file during construction —
      // CC often writes several entries before the watcher would tick. The
      // stream itself is asynchronous; the post-watch reconciliation below
      // is what makes its handoff to polling race-free.
      this.readNew()
    }

    this.statListener = (curr, prev) => {
      if (this.closed) return
      this.lastPollAt = Date.now()
      // Only act when the file has actually grown or its mtime
      // moved. stat returns size=0 when the file briefly
      // disappears (rare, but happens on some atomic-rename
      // writers); we let the next tick pick it back up.
      if (curr.size <= prev.size && curr.mtimeMs === prev.mtimeMs) {
        return
      }
      this.readNew()
    }
    watchFile(
      filePath,
      { interval: FileTailer.POLL_INTERVAL_MS, persistent: true },
      this.statListener,
    )
    // WHY reconcile once after registering the watcher: the initial read above is asynchronous
    // despite its historical comment. A writer can append after that read captures stat.size but
    // before watchFile establishes its first comparison baseline. In that narrow window the stream
    // stops at the old size and the watcher treats the new size as its starting point, so neither
    // path reports the append until the 15-second watchdog. A second serialized read bridges the
    // handoff: it becomes pending while bootstrap I/O is active and observes the latest EOF when
    // that read completes. Once this reconciliation drains, normal stat polling owns future growth.
    this.readNew()

    // Stall watchdog: if the file has grown past our offset but the stat
    // watcher hasn't ticked in a whole watchdog window, the watcher is
    // dead (the historical cause: another FileTailer on the same path
    // closed with an unscoped unwatchFile — fixed above, but ANY future
    // watcher-death recurrence self-heals here instead of silently
    // killing the committed channel). Re-arm and surface a diagnostic so
    // debug bundles show the event instead of an unexplained stale tail.
    const watchdogMs = options?.watchdogMs || FileTailer.WATCHDOG_MS
    this.watchdog = setInterval(() => {
      if (this.closed || this.statListener === null) return
      if (Date.now() - this.lastPollAt < watchdogMs) return
      let size = 0
      try {
        size = statSync(this.filePath).size
      } catch {
        return // file briefly missing — next tick
      }
      if (size <= this.offset) return
      unwatchFile(this.filePath, this.statListener)
      watchFile(
        this.filePath,
        { interval: FileTailer.POLL_INTERVAL_MS, persistent: true },
        this.statListener,
      )
      this.onError?.(new Error('tail-stalled: stat watcher dead with unread data; re-armed'))
      this.readNew()
    }, watchdogMs)
    // Never hold the process open just for the watchdog.
    this.watchdog.unref?.()
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
        this.onEntry(obj)
      } catch (err) {
        this.onError?.(err as Error)
      }
    }

    this.offset = stat.size
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

    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.filePath)
    } catch {
      // File temporarily missing — atomic-rename writers do this.
      // Skip and wait for the next poll tick.
      this.reading = false
      return
    }
    if (stat.size <= this.offset) {
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
      start: this.offset,
      end: stat.size - 1,
      encoding: 'utf8',
    })

    let chunk = ''
    stream.on('data', d => {
      chunk += d
    })
    stream.on('end', () => {
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
          this.onEntry(obj)
        } catch (err) {
          this.onError?.(err as Error)
        }
      }
      this.reading = false
      // Drain any queued re-run. This is the load-bearing bit for
      // serialization: when a write lands while we were reading the
      // previous chunk, the watcher sets pendingRead but can't do
      // anything else because reading was true. Now that we're done,
      // we kick off the next read ourselves.
      if (this.pendingRead) {
        this.pendingRead = false
        this.readNew()
      }
    })
    stream.on('error', err => {
      this.reading = false
      this.onError?.(err)
      // A failed read must not consume the one queued reconciliation above. The next read may
      // succeed after an atomic rename or transient filesystem error and is the only path that can
      // close the watcher-registration gap without waiting for the watchdog.
      if (this.pendingRead) {
        this.pendingRead = false
        this.readNew()
      }
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.watchdog !== null) clearInterval(this.watchdog)
    // Scoped unwatch — see statListener's WHY. Passing the listener is
    // the entire fix; do not "simplify" back to unwatchFile(path).
    if (this.statListener !== null) {
      unwatchFile(this.filePath, this.statListener)
      this.statListener = null
    }
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
