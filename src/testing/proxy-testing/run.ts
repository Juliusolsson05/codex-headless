#!/usr/bin/env tsx
// End-to-end Codex proxy harness.
//
// Exercises the SAME pipeline cc-shell uses in production:
//   1. Start a local ResponsesProxy on 127.0.0.1:random.
//   2. Spawn `codex` with `--config openai_base_url=<proxy>` so every
//      Responses API call routes through the proxy.
//   3. Attach CodexHeadless to the PTY and CodexResponsesAdapter to
//      the proxy — the adapter publishes parsed SSE into
//      CodexHeadless.semantic with `source: 'proxy', confidence: 'high'`.
//   4. Subscribe to the semantic channel + raw proxy events and
//      print both to stderr while also writing JSONL logs to disk.
//
// Why this exists:
//   The proxy + adapter pair lived in cc-shell for a while, with no
//   dedicated test surface. Regressions were caught (or not caught)
//   by running cc-shell end-to-end, which is expensive and buries the
//   signal under UI state. A CLI harness that speaks the same wire
//   lets you bisect parser bugs, confirm header timeouts, and verify
//   auth-mode detection in isolation.
//
// Usage:
//   npx tsx src/testing/proxy-testing/run.ts "what is 2+2?"
//   CODEX_PROXY_TEST_DURATION_MS=20000 npx tsx ... "hello"
//
// Env knobs (all optional):
//   CODEX_PROXY_TEST_CWD        — cwd to spawn codex in (default: $PWD)
//   CODEX_PROXY_TEST_BINARY     — codex binary name/path (default: "codex")
//   CODEX_PROXY_TEST_PROMPT     — prompt text (alternatively pass as argv[2])
//   CODEX_PROXY_TEST_DURATION_MS — auto-shutdown after N ms
//   CODEX_PROXY_TEST_COLS/ROWS  — terminal dimensions
//   CODEX_PROXY_TEST_DANGEROUS  — "1" passes --dangerously-bypass-...
//
// Outputs:
//   Run artifacts land under ./.proxy-testing/runs/<iso-timestamp>/:
//     - proxy-events.jsonl     — every raw HTTP event the proxy saw
//     - semantic-events.jsonl  — every SemanticChannel event emitted
//     - screen-events.jsonl    — every terminal snapshot
//     - committed-events.jsonl — every rollout-sourced committed event
//     - meta.json              — run metadata (auth mode, upstream, prompt)

import { mkdir, writeFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'

import { CodexHeadless } from '../../CodexHeadless.js'
import { ResponsesProxy } from '../../proxy/responsesProxy.js'
import { CodexResponsesAdapter } from '../../proxy/CodexResponsesAdapter.js'
import { spawnCodexWithProxy } from './spawnCodexWithProxy.js'

async function main(): Promise<void> {
  const cwd = process.env.CODEX_PROXY_TEST_CWD ?? process.cwd()
  const binary = process.env.CODEX_PROXY_TEST_BINARY ?? 'codex'
  const prompt = process.argv[2] ?? process.env.CODEX_PROXY_TEST_PROMPT
  const durationMs = process.env.CODEX_PROXY_TEST_DURATION_MS
    ? Number(process.env.CODEX_PROXY_TEST_DURATION_MS)
    : null
  const cols = process.env.CODEX_PROXY_TEST_COLS
    ? Number(process.env.CODEX_PROXY_TEST_COLS)
    : 120
  const rows = process.env.CODEX_PROXY_TEST_ROWS
    ? Number(process.env.CODEX_PROXY_TEST_ROWS)
    : 40
  const dangerousMode = process.env.CODEX_PROXY_TEST_DANGEROUS === '1'

  const runDir = join(
    process.cwd(),
    '.proxy-testing',
    'runs',
    new Date().toISOString().replace(/[:.]/g, '-'),
  )
  await mkdir(runDir, { recursive: true })

  // --- Start the proxy first so we know its bound port. -----------------
  // ResponsesProxy auto-detects auth mode from ~/.codex/auth.json and
  // picks the upstream (api.openai.com/v1 vs chatgpt.com/backend-api/codex)
  // accordingly. The info block returned tells us which path we're on
  // so the summary at the bottom of this run can log it.
  const proxy = await ResponsesProxy.create()
  process.stderr.write(
    `[codex-proxy-test] proxy up on ${proxy.info.proxyBaseUrl}\n` +
      `[codex-proxy-test] auth mode: ${proxy.info.authMode}\n` +
      `[codex-proxy-test] upstream:  ${proxy.info.upstreamBaseUrl}\n`,
  )

  // --- Spawn codex pointed at the proxy. --------------------------------
  const pty = spawnCodexWithProxy({
    cwd,
    cols,
    rows,
    binary,
    proxyBaseUrl: proxy.info.proxyBaseUrl,
    dangerousMode,
  })

  const headless = new CodexHeadless({
    pty,
    cwd,
    cols,
    rows,
    snapshotIntervalMs: 16,
  })

  const adapter = new CodexResponsesAdapter(proxy, headless)
  adapter.attach()

  // --- Log sinks --------------------------------------------------------
  const proxyLog = createWriteStream(join(runDir, 'proxy-events.jsonl'), { flags: 'a' })
  const semanticLog = createWriteStream(join(runDir, 'semantic-events.jsonl'), { flags: 'a' })
  const screenLog = createWriteStream(join(runDir, 'screen-events.jsonl'), { flags: 'a' })
  const committedLog = createWriteStream(join(runDir, 'committed-events.jsonl'), { flags: 'a' })

  // Running assistant-text accumulator from proxy-sourced deltas. Useful
  // for comparing proxy output against what eventually lands in the
  // rollout-sourced committed text — a divergence usually signals either
  // an SSE framing bug or a CRLF-corrupted upstream path.
  let proxyText = ''

  // --- Proxy transport events ------------------------------------------
  // `Buffer` chunks can't be JSON-stringified directly (they serialize
  // as `{"type":"Buffer","data":[…]}` which is huge and unreadable).
  // Replace them with a byte length summary for the log; the adapter
  // already consumed the raw chunk via its own subscription.
  proxy.on('event', event => {
    const loggable: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(event)) {
      if (Buffer.isBuffer(v)) {
        loggable[k] = `<Buffer len=${v.length}>`
      } else {
        loggable[k] = v
      }
    }
    proxyLog.write(JSON.stringify({ ts: Date.now(), ...loggable }) + '\n')
  })

  // --- Semantic channel: the new source of truth ------------------------
  headless.semantic.on('event', ev => {
    semanticLog.write(JSON.stringify(ev) + '\n')
  })
  headless.semantic.on('turn_started', ev => {
    process.stderr.write(
      `[semantic] turn_started src=${ev.source} conf=${ev.confidence} id=${ev.turnId}\n`,
    )
  })
  headless.semantic.on('turn_delta', ev => {
    if (ev.source === 'proxy' && ev.textDelta) proxyText += ev.textDelta
    // One line per delta gets noisy fast; only log a terse preview.
    const preview = (ev.textDelta ?? '').slice(0, 60).replace(/\n/g, '\\n')
    process.stderr.write(
      `[semantic] turn_delta src=${ev.source} +${preview.length}ch "${preview}"\n`,
    )
  })
  headless.semantic.on('turn_completed', ev => {
    process.stderr.write(
      `[semantic] turn_completed src=${ev.source} conf=${ev.confidence}\n`,
    )
  })
  headless.semantic.on('source_changed', ev => {
    process.stderr.write(
      `[semantic] source_changed ${ev.previousSource ?? '(none)'} → ${ev.source}\n`,
    )
  })
  headless.semantic.on('flow_selected', ev => {
    process.stderr.write(`[semantic] flow_selected ${ev.flowId} (${ev.reason})\n`)
  })
  headless.semantic.on('flow_ignored', ev => {
    process.stderr.write(`[semantic] flow_ignored ${ev.flowId} (${ev.reason})\n`)
  })
  headless.semantic.on('usage_updated', ev => {
    process.stderr.write(
      `[semantic] usage_updated turn=${ev.turnId} ${JSON.stringify(ev.usage)}\n`,
    )
  })

  // --- Screen channel: mirror of terminal state -------------------------
  // Keep the plain content for diagnostics — without it we can't tell
  // whether the session stalled on a trust dialog, an approval overlay,
  // or the prompt line never took input.
  let lastScreenPlain = ''
  headless.screen.on('snapshot', snap => {
    lastScreenPlain = snap.plain
    screenLog.write(
      JSON.stringify({ ts: snap.ts, plainBytes: snap.plain.length, plain: snap.plain }) + '\n',
    )
  })
  headless.screen.on('activity', ev => {
    process.stderr.write(
      `[screen] activity active=${ev.active} status=${ev.status ?? '(null)'}\n`,
    )
  })
  headless.screen.on('trust_dialog', ev => {
    process.stderr.write(
      `[screen] trust_dialog visible=${ev.state.visible}` +
        (ev.state.visible ? ` workspace=${ev.state.workspace ?? '?'}` : '') +
        '\n',
    )
  })

  // --- Committed channel: rollout-sourced durable events ----------------
  headless.committed.on('event', ev => {
    committedLog.write(JSON.stringify(ev) + '\n')
  })

  headless.on('exit', ({ exitCode, signal }) => {
    process.stderr.write(
      `[codex-proxy-test] codex exited (code=${exitCode}, signal=${signal ?? '-'})\n`,
    )
    void shutdown(exitCode ?? 0)
  })

  let shuttingDown = false
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    try { adapter.detach() } catch { /* best-effort */ }
    try { pty.kill() } catch { /* already gone */ }
    try { await headless.stop() } catch { /* best-effort */ }
    try { await proxy.stop() } catch { /* best-effort */ }
    proxyLog.end()
    semanticLog.end()
    screenLog.end()
    committedLog.end()

    await writeFile(
      join(runDir, 'meta.json'),
      JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          cwd,
          binary,
          authMode: proxy.info.authMode,
          upstreamBaseUrl: proxy.info.upstreamBaseUrl,
          proxyBaseUrl: proxy.info.proxyBaseUrl,
          prompt: prompt ?? null,
          proxyTextLength: proxyText.length,
          proxyTextPreview: proxyText.slice(0, 400),
        },
        null,
        2,
      ),
    )
    // Final TUI snapshot — the single most useful artifact for
    // diagnosing "why didn't a turn fire". Trust dialogs, approval
    // overlays, and prompt-line render issues all show up here.
    await writeFile(join(runDir, 'last-screen.txt'), lastScreenPlain)
    process.stderr.write(`[codex-proxy-test] run artifacts: ${runDir}\n`)
    process.exit(code)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  const { sessionsDir } = await headless.start()
  process.stderr.write(`[codex-proxy-test] sessions dir: ${sessionsDir}\n`)

  if (prompt) {
    // Give Codex's TUI time to finish its initial render + push kitty
    // keyboard flags before we start typing.
    setTimeout(async () => {
      process.stderr.write(`[codex-proxy-test] typing prompt character-by-character\n`)

      // IMPORTANT: codex runs a paste-burst heuristic in
      // bottom_pane/paste_burst.rs. When chars arrive with <8ms gap
      // between them (<30ms on Windows) they're classified as a paste.
      // Within 120ms after a paste ends, a subsequent Enter is
      // SUPPRESSED (PASTE_ENTER_SUPPRESS_WINDOW) — the bytes reach the
      // composer but never trigger submission. That's the exact symptom
      // we were seeing: prompt lands in the box, Enter silently dropped.
      //
      // paste_burst exposes `recommended_flush_delay()` =
      // PASTE_BURST_CHAR_INTERVAL + 1ms = 9ms on non-Windows. We use
      // 20ms to leave comfortable margin and account for pty write
      // coalescing on macOS.
      for (const ch of prompt) {
        headless.write(ch)
        await new Promise(r => setTimeout(r, 20))
      }

      // After typing finishes, wait well past PASTE_ENTER_SUPPRESS_WINDOW
      // (120ms). Then send Enter as a plain \r. crossterm's default
      // decoder still treats \r as KeyCode::Enter + Press even with
      // DISAMBIGUATE_ESCAPE_CODES — the kitty push only changes what
      // a physical terminal encodes for a keypress, not what crossterm
      // DECODES when reading bytes.
      await new Promise(r => setTimeout(r, 250))
      // Diagnostic sweep: send every encoding Codex might accept for
      // Enter, with pauses. This is noisy but narrows down which
      // encoding works. In the real harness we'll keep only the
      // winning one.
      const enters: Array<[string, string]> = [
        ['\\r', '\r'],
        ['\\n', '\n'],
        ['\\r\\n', '\r\n'],
        ['CSI 13u', '\x1b[13u'],
        ['CSI 13;1u', '\x1b[13;1u'],
        ['CSI 13;1;1u', '\x1b[13;1;1u'],
        ['SS3 M', '\x1bOM'],
      ]
      for (const [name, bytes] of enters) {
        process.stderr.write(`[codex-proxy-test] try Enter = ${name}\n`)
        headless.write(bytes)
        await new Promise(r => setTimeout(r, 1500))
      }
    }, 4000)
  }

  if (durationMs && Number.isFinite(durationMs) && durationMs > 0) {
    setTimeout(() => {
      process.stderr.write(`[codex-proxy-test] duration ${durationMs}ms elapsed, shutting down\n`)
      void shutdown(0)
    }, durationMs)
  }
}

main().catch(err => {
  console.error('[codex-proxy-test] fatal:', err)
  process.exit(1)
})
