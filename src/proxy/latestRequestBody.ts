import { readdir, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'

// The newest Responses request body, kept in a sidecar next to the proxy
// events file (agent-code#1336).
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
//
// The INVARIANT differs from Claude's, on purpose. Claude's sidecar holds the
// newest body that is NOT in the log (its log omits bodies past a budget).
// Codex never omits bodies up to the 2 MiB inline cap, and the loss here is
// the bundle's tail, which the proxy cannot see. So this sidecar always holds
// the newest Responses request body, even when the log also has it. The cost
// is at most one body (bounded below) appearing twice in a bundle.
//
// WHY only `responses*` endpoints: they carry the prompt (the main turn,
// `responses/compact`). `/v1/models` is a GET with no body. A turn's later
// requests (tool results) resend the whole input, so "newest" still holds
// every prompt so far. A title side request (0.157 `thread_title.rs`) is a
// Responses request too, so the sidecar can briefly hold one; it carries the
// same user prompt, and the next main-turn request replaces it.
//
// WHY one ordered chain of async writes: the proxy runs on Agent Code's main
// process, where the old synchronous mirror appends were the problem
// (agent-code#372), so no sync I/O. But independent async writes can finish
// out of order and rename an OLDER body over a newer one. Chaining them keeps
// "latest" true. A failed write removes the sidecar, so a reader never sees a
// stale prompt as the current one. Best-effort throughout: forensics must
// never disturb the live proxy.

export const LATEST_REQUEST_BODY_FILE_NAME = 'latest-request-body.json'

// Same cap as the Claude addon's sidecar (`_LATEST_BODY_CAP`). Larger than the
// 2 MiB inline cap on purpose: a body too big to inline is exactly the one the
// events file cannot show at all.
export const LATEST_REQUEST_BODY_CAP = 16 * 1024 * 1024

export class LatestRequestBodySidecar {
  readonly path: string
  private chain: Promise<void> = Promise.resolve()
  private writes = 0

  constructor(eventsFile: string) {
    this.path = join(dirname(eventsFile), LATEST_REQUEST_BODY_FILE_NAME)
  }

  record(requestId: string, endpoint: string, body: Buffer | undefined): void {
    if (!endpoint.startsWith('responses') || !body || body.length === 0) return
    const write = this.writes++
    const line = body.length > LATEST_REQUEST_BODY_CAP
      ? null
      : JSON.stringify({ kind: 'request-body-latest', requestId, endpoint, body_b64: body.toString('base64') }) + '\n'
    this.chain = this.chain.then(() => (line === null ? this.remove() : this.replace(line, write)))
  }

  /** Resolves once every recorded body has been written or removed. */
  flush(): Promise<void> {
    return this.chain
  }

  private async replace(line: string, write: number): Promise<void> {
    // A per-write temp name, so a crash mid-write never leaves a half body
    // under the real name.
    const temp = `${this.path}.${process.pid}.${write}.tmp`
    try {
      await writeFile(temp, line, 'utf-8')
      await rename(temp, this.path)
    } catch {
      await rm(temp, { force: true }).catch(() => {})
      await this.remove()
    }
  }

  private async remove(): Promise<void> {
    await rm(this.path, { force: true }).catch(() => {})
    // Temp files a crash between write and rename left behind.
    try {
      const prefix = `${basename(this.path)}.`
      for (const name of await readdir(dirname(this.path))) {
        if (name.startsWith(prefix) && name.endsWith('.tmp')) await rm(join(dirname(this.path), name), { force: true }).catch(() => {})
      }
    } catch { /* directory gone: nothing to clean */ }
  }
}
