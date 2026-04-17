# codex-headless proxy testing harness

End-to-end CLI smoke test for the `ResponsesProxy` + `CodexResponsesAdapter` pair — the same pipeline cc-shell uses in production, isolated from the Electron UI.

## Why this exists

The proxy and adapter handle a narrow but load-bearing seam: every `/responses` SSE byte Codex receives passes through them before the renderer sees a semantic delta. A regression here is invisible until a live cc-shell session streams garbled text. This harness runs the same pipeline headlessly so you can bisect parser bugs in minutes instead of hours.

## Quick run

```bash
cd codex-headless
npx tsx src/testing/proxy-testing/run.ts "what is 2+2?"
```

What happens:

1. `ResponsesProxy.create()` binds 127.0.0.1 on a random port, reads `~/.codex/auth.json` to decide whether you're in `apikey` or `chatgpt` mode, and picks the matching upstream (`api.openai.com/v1` vs `chatgpt.com/backend-api/codex`).
2. `spawnCodexWithProxy` spawns the `codex` binary with `--config openai_base_url="http://127.0.0.1:PORT/v1"`. Every Responses API call now traverses the proxy.
3. `CodexHeadless` attaches to the PTY; `CodexResponsesAdapter` attaches to the proxy.
4. Streaming begins. stderr shows a live event log; `.proxy-testing/runs/<iso-timestamp>/` collects JSONL of every channel.

## Env knobs

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_PROXY_TEST_CWD` | `$PWD` | Working directory for the codex process |
| `CODEX_PROXY_TEST_BINARY` | `codex` | Binary name / path |
| `CODEX_PROXY_TEST_PROMPT` | argv[2] | Prompt text (also accepted positionally) |
| `CODEX_PROXY_TEST_DURATION_MS` | — | Auto-shutdown after N ms |
| `CODEX_PROXY_TEST_COLS` / `ROWS` | 120×40 | Terminal size |
| `CODEX_PROXY_TEST_DANGEROUS` | `0` | `1` passes `--dangerously-bypass-approvals-and-sandbox` |

## Output

Each run creates `.proxy-testing/runs/<iso>/`:

- `proxy-events.jsonl` — every HTTP event the proxy saw (`request`, `response`, `response-chunk` sans buffer bodies, `response-end`, `upgrade-rejected`, `server-error`).
- `semantic-events.jsonl` — every event on `CodexHeadless.semantic` (turn lifecycle, source changes, flow diagnostics, usage).
- `screen-events.jsonl` — terminal snapshots (byte lengths only — full plaintext is huge).
- `committed-events.jsonl` — rollout-sourced events from `CodexHeadless.committed`.
- `meta.json` — run metadata: auth mode, upstream URL, proxy URL, prompt, accumulated proxy text.

## What to verify

A healthy run shows this event order on stderr:

1. `proxy up on http://127.0.0.1:...` + `auth mode: apikey|chatgpt`.
2. `[screen] activity active=true status="working…"` once the prompt is sent.
3. `[semantic] flow_selected proxy-1 (POST /v1/responses)` — the adapter opened a flow.
4. `[semantic] turn_started src=proxy conf=high id=resp_…` — the first `response.created`/`response.in_progress` arrived.
5. A burst of `[semantic] turn_delta src=proxy +Nch …` lines — `output_text.delta` events streaming.
6. `[semantic] usage_updated turn=resp_… {input_tokens: …, output_tokens: …}` on `response.completed`.
7. `[semantic] turn_completed src=proxy conf=high` — the turn settled.

Watch for:

- `turn_delta src=screen` firing before any proxy delta arrives: means the rollout tail or screen fallback opened the turn first, and the proxy path didn't win the race. Not necessarily broken, but worth noting.
- `turn_delta` with empty `textDelta` but `fullText` that keeps growing: adapter is receiving frames but parsing is dropping deltas — check the raw `proxy-events.jsonl` for malformed SSE.
- No `flow_selected` at all: Codex is not routing through the proxy. Verify the `--config` arg is reaching the binary (check with `codex --print-config` at the same cwd).

## How it differs from Claude's `run.ts`

The claude-code-headless equivalent lives at `claude-code-headless/src/testing/proxy-testing/run.ts`. The differences all trace back to transport:

- No CA certificate — Codex speaks plain HTTP to 127.0.0.1; no mitmproxy TLS interception.
- No `HTTPS_PROXY` env — `--config openai_base_url` is the override path.
- Upstream is auth-mode-dependent — Claude always talks to `api.anthropic.com`; Codex might talk to chatgpt.com/backend-api/codex.
