import { createWriteStream, renameSync, unlinkSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { basename, dirname, join } from 'path'

// The newest main-turn Responses request body, kept in a sidecar next to the
// proxy events file (agent-code#1336).
//
// WHY a sidecar at all: Agent Code's debug bundle carries the last 5 MiB of
// `proxy-events.jsonl` (plus the rotated `.1`). On Codex the response chunks
// are the bulk of that file, so a turn that streams more than 5 MiB, or a run
// of `/v1/models` refreshes, pushes the request event (and its `body_b64`)
// out of the tail. The bundle then holds recent chunks and no prompt, which
// is the one thing a bug report needs. Measured on the live corpus (review C
// of agent-code#1332): the last inline body lay more than 5 MiB before EOF in
// 40 of 65 Codex files (10 of 65 once chunks are base64). Rotation cannot
// help, because the problem is the tail, not the file size.
//
// WHY this name and line shape: it is the Claude addon's sidecar
// (claude-code-headless `mitmAddon.py`, agent-code#1273), and Agent Code's
// `readLatestRequestBody` already appends `<runDir>/latest-request-body.json`
// to the bundle's proxy section for ANY provider. One JSON line with its own
// `kind`, so nothing that replays the events file mistakes it for a request.
// The body is the raw on-wire bytes, exactly as the `request` event's
// `body_b64` (zstd-compressed on current Codex; readers detect the frame).
//
// The INVARIANT differs from Claude's, on purpose. Claude's sidecar holds the
// newest body that is NOT in the log (its log omits bodies past a budget).
// Codex never omits bodies up to the 2 MiB inline cap, and the loss here is
// the bundle's tail, which the proxy cannot see. So this sidecar holds the
// newest main-turn body, even when the log also has it (at most one body
// appears twice in a bundle).
//
// WHICH requests (the caller decides, see ResponsesProxy): `responses*`
// endpoints with a body, excluding temporary structured turns. Codex 0.157's
// title generation (tui `thread_title.rs`) runs an ephemeral thread whose
// request carries an output schema (`text.format`, name
// `codex_output_schema`); ordinary TUI turns never do. Letting it in replaced
// the main prompt with a 960-byte title prompt (#70 review a). A body whose
// shape cannot be read (not JSON, or a zstd frame over the decode bound) is
// still recorded: an unclassified prompt is better evidence than none.
//
// "NEVER AN OLDER PROMPT" (#70 review a): three rules make it hold at every
// instant a reader can look, not only after writes settle.
//  1. A newer body removes the real-name file SYNCHRONOUSLY when it is
//     recorded. `unlinkSync` is one metadata call, not a data write. From then
//     on a reader sees either nothing or the newer body, including after a
//     crash anywhere in the write.
//  2. A write that has been superseded by a newer record never renames: it
//     checks its generation and publishes with `renameSync` in the same
//     synchronous turn, so no record() can slip between check and commit
//     (steering q96), and a superseded write discards its temp file.
//  3. Only the newest pending body is kept. Older pending bodies are dropped
//     unwritten, so memory holds at most one body in flight and one pending.
// If the directory refuses the unlink (permissions), nothing here can make the
// file current; that failure is not reported, as for every mirror failure.
//
// MAIN-PROCESS COST (#70 review a): the proxy runs on Agent Code's main
// process. The only synchronous calls are two metadata operations (the
// unlink in record, the rename at commit); every data byte is written
// asynchronously. A 16 MiB body is 21.3 MiB of base64, measured at up to 376 ms when
// encoded in one call. It is encoded in slices of ENCODE_SLICE_BYTES, each in
// its own turn after the stream drains, so no single turn does more than a
// slice.

export const LATEST_REQUEST_BODY_FILE_NAME = 'latest-request-body.json'

// Same cap as the Claude addon's sidecar (`_LATEST_BODY_CAP`). Larger than the
// 2 MiB inline cap on purpose: a body too big to inline is exactly the one the
// events file cannot show at all. Such bodies are persisted ONLY here
// (SECURITY.md says so).
export const LATEST_REQUEST_BODY_CAP = 16 * 1024 * 1024

// A multiple of 3, so every slice but the last encodes to base64 without
// padding and the slices concatenate into one valid base64 string.
const ENCODE_SLICE_BYTES = 3 * 256 * 1024

type Pending = { generation: number; requestId: string; endpoint: string; body: Buffer }

export class LatestRequestBodySidecar {
  readonly path: string
  private generation = 0
  private pending: Pending | null = null
  private inFlight: Promise<void> | null = null
  private idleWaiters: Array<() => void> = []

  constructor(eventsFile: string) {
    this.path = join(dirname(eventsFile), LATEST_REQUEST_BODY_FILE_NAME)
  }

  record(requestId: string, endpoint: string, body: Buffer): void {
    this.generation += 1
    // Rule 1: from now on the old body is not "latest", on disk too.
    try { unlinkSync(this.path) } catch { /* absent, or the directory refuses */ }
    this.pending = body.length > LATEST_REQUEST_BODY_CAP
      ? null
      : { generation: this.generation, requestId, endpoint, body }
    this.kick()
  }

  /** Resolves once every recorded body has been written, or dropped. */
  flush(): Promise<void> {
    if (!this.inFlight && !this.pending) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  private kick(): void {
    if (this.inFlight) return
    const next = this.pending
    this.pending = null
    if (!next) {
      for (const resolve of this.idleWaiters.splice(0)) resolve()
      return
    }
    this.inFlight = this.write(next).finally(() => {
      this.inFlight = null
      this.kick()
    })
  }

  private async write(entry: Pending): Promise<void> {
    // A per-write temp name, so a crash mid-write never leaves a half body
    // under the real name.
    const temp = `${this.path}.${process.pid}.${entry.generation}.tmp`
    try {
      await writeEncoded(temp, entry)
      // Rule 2, enforced AT the commit (steering q96). The generation check
      // and the publish run in ONE synchronous turn, so no `record()` can run
      // between them. The first version checked, then awaited an async
      // `rename`: a `record(B)` in that gap unlinked the public file, and A's
      // rename then landed and restored A as "latest" while B was still being
      // written. `renameSync` is one metadata call (like the `unlinkSync` in
      // record), not a data write; the body itself is still written
      // asynchronously in slices above, so a large body never blocks a turn.
      if (entry.generation !== this.generation) {
        await rm(temp, { force: true })
        return
      }
      renameSync(temp, this.path)
    } catch {
      await rm(temp, { force: true }).catch(() => {})
      await this.removeTempFiles()
    }
  }

  private async removeTempFiles(): Promise<void> {
    // Temp files a crash between write and rename left behind.
    try {
      const prefix = `${basename(this.path)}.`
      for (const name of await readdir(dirname(this.path))) {
        if (name.startsWith(prefix) && name.endsWith('.tmp')) await rm(join(dirname(this.path), name), { force: true }).catch(() => {})
      }
    } catch { /* directory gone: nothing to clean */ }
  }
}

async function writeEncoded(path: string, entry: Pending): Promise<void> {
  const stream = createWriteStream(path, { encoding: 'utf-8' })
  const done = new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.once('finish', resolve)
  })
  // Observed here so an error while a slice is still being encoded is not an
  // unhandled rejection; it is re-raised by the race below and the final await.
  done.catch(() => {})
  const put = async (text: string): Promise<void> => {
    // Raced with `done`: a stream that errors never emits 'drain'.
    if (!stream.write(text)) await Promise.race([new Promise<void>(resolve => stream.once('drain', resolve)), done])
    // Yield so the next slice's encoding runs in its own turn.
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  try {
    const head = JSON.stringify({ kind: 'request-body-latest', requestId: entry.requestId, endpoint: entry.endpoint })
    await put(`${head.slice(0, -1)},"body_b64":"`)
    for (let offset = 0; offset < entry.body.length; offset += ENCODE_SLICE_BYTES) {
      await put(entry.body.subarray(offset, offset + ENCODE_SLICE_BYTES).toString('base64'))
    }
    stream.end('"}\n')
  } catch (error) {
    stream.destroy()
    throw error
  }
  await done
}
