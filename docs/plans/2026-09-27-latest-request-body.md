# Keep the newest Responses request body beside the events file (agent-code#1336)

## Evidence
- **What the bundle carries.** Agent Code's debug bundle includes the last 5 MiB of `proxy-events.jsonl` (plus `.1`).
- **Why the prompt falls out.** On Codex the response chunks are the bulk of that file. So after a long stream, or a run of `/v1/models` refreshes, the `request` event with its `body_b64` is no longer in the tail, and the bundle has no prompt.
- **Measured.** Review C of agent-code#1332 found the last inline body more than 5 MiB before EOF in 40 of 65 Codex files: 10 of 65 after the base64 fix (#53).
- **The Claude precedent.** Claude solved the same loss with `latest-request-body.json` (claude-code-headless#62, agent-code#1273). Agent Code's `readLatestRequestBody` already appends `<runDir>/latest-request-body.json` for any provider. Codex never writes one.

## Change
- **New module, `src/proxy/latestRequestBody.ts`:** `LatestRequestBodySidecar`. For each `responses*` request with a body, it replaces the sidecar with `{kind:'request-body-latest', requestId, endpoint, body_b64}`.
  - **Ordered writes.** One ordered chain of async writes (temp file plus rename): no sync I/O on the main process, and an older body can never rename over a newer one.
  - **Removal instead of staleness.** It removes the sidecar when the newest body is over 16 MiB (the Claude cap) or a write fails, so it never shows an older prompt as current.
  - **Bodiless requests are skipped.** `/models` GETs never touch it.
- **Wiring in `ResponsesProxy`.** It is created with the mirror (same `eventsFile` opt-in) and recorded right after the `request` event. `flushMirror()` and `stop()` also wait for it.
- **Docs.** `API.md` and `SECURITY.md` document the file, including that it holds prompt text.

## Invariant, and how it differs from Claude
Claude's sidecar holds the newest body that is NOT in its log, because that log omits bodies past a budget. Codex never omits bodies up to 2 MiB; the loss is in the bundle's tail, which the proxy cannot see. So this sidecar always holds the newest Responses body, even when the log also has it. The cost is at most one body appearing twice in a bundle.

## Tests (`responsesProxy.latestBody.test.ts`, real requests through the proxy to a local upstream)
1. After two POSTs, the sidecar holds the second body, with its `requestId`, as one line.
2. A `/models` GET after a prompt leaves the prompt in place.
3. A body over 16 MiB removes an existing sidecar.

All three are red with the wiring removed.

## Then
The app bump carries this to Agent Code. Its reader's WHY comment, which describes only the Claude invariant, gets the Codex one.

## Review a (round 1)
- **Stale "latest"**, after a crash between write and rename, a failed removal, or a read while a newer write was queued. Fixed with three rules (see the module header):
  - `record()` unlinks the real-name file synchronously;
  - a superseded write never renames: the generation check and `renameSync` run in one synchronous turn (steering q96: an awaited async rename after the check let `record(B)` unlink the file and A's late rename restore it);
  - only the newest pending body is kept.
  If the directory refuses the unlink, nothing can make the file current; that stays unreported, like every mirror failure.
- **Title generation replaced the main prompt.** Codex 0.157 title turns carry an output schema (`text.format`, `codex_output_schema`). `request_shape` gains `has_output_schema`, and such requests are skipped. A body whose shape cannot be read is still kept.
- **Main-process cost.** Base64 is encoded in 768 KiB slices, one per turn after a drain, instead of 21 MiB in one call. At most one body is pending.
- **SECURITY.md accuracy.** Bodies between 2 MiB and 16 MiB are persisted only in the sidecar.
- **Fresh sessions never reach the file (P1).** This is an app-side selection bug, not a package bug: the bundle asks for `resume-<providerSessionId>` while a fresh run lives under `shell-<paneId>`. It is fixed in the app PR that bumps this package, where it is reachable and testable.
- **Tests:** compaction is recorded, the title turn is skipped, a newer record removes the file at once, a superseded write cannot resurrect an older body, and a multi-slice body round-trips.
  - Mutations killed: the endpoint narrowing, the schema check, the generation check and the unlink.

## Steering q96
- **A late async rename restored an older body.** The first round checked the generation, then awaited an async `rename`. A `record(B)` in that gap unlinked the public file, and A's rename then restored A while B was still being written.
- **Fix: commit in one turn.** The commit is now `renameSync` in the same turn as the check. It is one metadata call; body bytes are still written asynchronously in slices.
- **Test: `latestRequestBody.commitFence.test.ts`.** It holds every async `fs/promises` rename at a gate and spies `renameSync`. It records B while A's commit is pending, releases A, and reads the public file before B commits: the file is absent or B, never A. It was red on `a54cfe7` (A restored).

## Review b (round 1)
- **Subagent calls replaced the main prompt.** Codex tags every non-main Responses call with `x-openai-subagent` (codex-api `requests/headers.rs`: `review`, `compact`, `thread_spawn`, `memory_consolidation`, or a label). They are now skipped, except `compact`, which carries the main conversation. There are tests for `thread_spawn` and `review`, and for a kept `compact`.
- **16 MiB cap untested.** A body of exactly 16 MiB is now kept, so lowering the cap fails a test.
- **Crash-left temp copies.** They are now listed in `SECURITY.md`.
- **P1 (the app side), no package change.** Covered by agent-code#1399, plus a bump that follows #1366. This PR is "For", not "Fixes", #1336.
