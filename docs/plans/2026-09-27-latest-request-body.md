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
