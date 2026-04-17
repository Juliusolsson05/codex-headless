#!/usr/bin/env tsx
// Headless end-to-end proxy harness using `codex exec --json`.
//
// WHY this exists alongside run.ts:
//   The earlier run.ts harness spawns the full Codex TUI in a PTY and
//   tries to submit the prompt by synthesizing keystrokes. That path
//   has to fight several Codex UX defenses simultaneously:
//     1. The WS→SSE fallback now works (we return HTTP 426 Upgrade
//        Required so codex-rs/core/src/client.rs:1303 picks the
//        SSE path — previously we returned 404 and the whole session
//        errored out before any POST was tried).
//     2. Kitty keyboard protocol push (tui.rs:113-117) with
//        DISAMBIGUATE_ESCAPE_CODES + REPORT_EVENT_TYPES means bare
//        `\r` may not be decoded as KeyCode::Enter + Press.
//     3. Paste-burst heuristic (bottom_pane/paste_burst.rs) treats
//        any char stream <8ms/char apart as a paste, and
//        PASTE_ENTER_SUPPRESS_WINDOW=120ms silently drops the first
//        Enter that follows a paste.
//     4. Even with per-char typing + 250ms wait + every known Enter
//        encoding (\r, \n, CSI 13u, CSI 13;1;1u, SS3 M), the prompt
//        just sits in the composer box and never submits. Something
//        else in Codex's event decoding is eating our key.
//   Fighting through all of that to test the proxy is a diversion.
//   `codex exec --json` is Codex's non-interactive mode: it reads a
//   prompt from argv, runs to completion, and emits JSONL events on
//   stdout. Zero TUI, zero key decoding, zero paste heuristic. It
//   still goes through the same /responses API path, so the proxy
//   and adapter get exercised identically.
//
// What this harness validates:
//   1. ResponsesProxy bind + auth-mode detection.
//   2. WS upgrade → 426 → codex falls back to SSE POST.
//   3. The SSE stream flows through the proxy and reaches the
//      CodexResponsesAdapter.
//   4. CodexResponsesAdapter parses OpenAI Responses events and
//      publishes typed events on SemanticChannel (turn_started,
//      turn_delta, flow_selected, usage_updated, turn_completed).
//   5. The proxy-sourced text matches what codex exec returns as
//      its own "last message".
//
// Usage:
//   npx tsx src/testing/proxy-testing/exec.ts "what is 2+2? reply in one sentence"
//   or: npm run proxy-exec -- "what is 2+2?"

import { spawn } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'

import { ResponsesProxy } from '../../proxy/responsesProxy.js'
import { CodexResponsesAdapter } from '../../proxy/CodexResponsesAdapter.js'
import { SemanticChannel } from '../../channels/SemanticChannel.js'
import type { CodexHeadless } from '../../CodexHeadless.js'

function makeFakeHeadless(): CodexHeadless {
  // The adapter only reaches into `headless.semantic`; it never calls
  // anything else on the CodexHeadless instance. A duck-typed shim
  // keeps the harness from needing a PTY / terminal emulator just
  // to exercise the proxy parsing path.
  return { semantic: new SemanticChannel() } as unknown as CodexHeadless
}

async function main(): Promise<void> {
  const prompt = process.argv[2] ?? process.env.CODEX_PROXY_TEST_PROMPT
  if (!prompt) {
    process.stderr.write(
      '[exec-harness] usage: tsx exec.ts "<prompt>"\n' +
        '[exec-harness] (or set CODEX_PROXY_TEST_PROMPT)\n',
    )
    process.exit(2)
  }

  const cwd = process.env.CODEX_PROXY_TEST_CWD ?? process.cwd()
  const binary = process.env.CODEX_PROXY_TEST_BINARY ?? 'codex'
  // `codex exec` normally runs to completion on its own; the cap is a
  // safety net for a hang (e.g. proxy returns a 5xx and codex decides
  // to retry forever, or the model stream gets stuck). 90s is generous
  // for a tiny arithmetic prompt; override if you're sending something
  // bigger.
  const durationMs = process.env.CODEX_PROXY_TEST_DURATION_MS
    ? Number(process.env.CODEX_PROXY_TEST_DURATION_MS)
    : 90_000

  const runDir = join(
    process.cwd(),
    '.proxy-testing',
    'runs-exec',
    new Date().toISOString().replace(/[:.]/g, '-'),
  )
  await mkdir(runDir, { recursive: true })

  // --- Boot the proxy ---------------------------------------------------
  const proxy = await ResponsesProxy.create()
  process.stderr.write(
    `[exec-harness] proxy:   ${proxy.info.proxyBaseUrl}\n` +
      `[exec-harness] auth:    ${proxy.info.authMode}\n` +
      `[exec-harness] upstream: ${proxy.info.upstreamBaseUrl}\n`,
  )

  const headless = makeFakeHeadless()
  const adapter = new CodexResponsesAdapter(proxy, headless)
  adapter.attach()

  // --- Log sinks --------------------------------------------------------
  const proxyLog = createWriteStream(join(runDir, 'proxy-events.jsonl'), { flags: 'a' })
  const semanticLog = createWriteStream(join(runDir, 'semantic-events.jsonl'), { flags: 'a' })
  const execLog = createWriteStream(join(runDir, 'codex-exec.jsonl'), { flags: 'a' })

  let proxyText = ''
  let execStdoutBytes = 0

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
    if (event.kind === 'request') {
      process.stderr.write(
        `[proxy] → ${event.method as string} ${event.path as string}\n`,
      )
    } else if (event.kind === 'response') {
      process.stderr.write(
        `[proxy] ← ${event.status as number} ${event.path as string}\n`,
      )
    } else if (event.kind === 'upgrade-rejected') {
      process.stderr.write(`[proxy] ws upgrade rejected on ${event.path as string}\n`)
    } else if (event.kind === 'upstream-error' || event.kind === 'response-error') {
      process.stderr.write(
        `[proxy] ERROR (${event.kind as string}): ${event.message as string}\n`,
      )
    }
  })

  // --- Semantic channel -------------------------------------------------
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
    const preview = (ev.textDelta ?? '').slice(0, 60).replace(/\n/g, '\\n')
    process.stderr.write(
      `[semantic] +${(ev.textDelta ?? '').length}ch "${preview}"\n`,
    )
  })
  headless.semantic.on('turn_completed', ev => {
    process.stderr.write(
      `[semantic] turn_completed src=${ev.source} conf=${ev.confidence}\n`,
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
      `[semantic] usage: ${JSON.stringify(ev.usage)}\n`,
    )
  })

  // --- Spawn codex exec -------------------------------------------------
  // We add --skip-git-repo-check so the harness works in cwds that
  // aren't git repos (the codex-headless repo is, but we don't want a
  // red herring when someone runs this from /tmp).
  //
  // --dangerously-bypass-approvals-and-sandbox keeps codex from
  // blocking on a yes/no prompt — in non-interactive mode there's no
  // UI to answer the prompt with, and the session would hang. This is
  // a test harness; real use would omit this flag.
  //
  // --json makes codex emit its own event stream on stdout (mirrors
  // what it would write to ~/.codex/sessions/.../rollout-*.jsonl),
  // which gives us a second-source ground truth to compare against
  // the proxy-derived semantic stream.
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--config',
    `openai_base_url=${JSON.stringify(proxy.info.proxyBaseUrl)}`,
    prompt,
  ]
  process.stderr.write(`[exec-harness] ${binary} ${args.map(a => JSON.stringify(a)).join(' ')}\n`)

  const child = spawn(binary, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Strip ambient HTTP(S)_PROXY so codex routes through us, not
      // a corporate proxy that would MITM and break auth.
      HTTPS_PROXY: undefined as unknown as string,
      https_proxy: undefined as unknown as string,
      HTTP_PROXY: undefined as unknown as string,
      http_proxy: undefined as unknown as string,
    },
  })

  child.stdout.on('data', (chunk: Buffer) => {
    execStdoutBytes += chunk.length
    // Stream codex's own JSONL to disk. stderr gets a compact
    // one-liner per line so we don't drown the screen in JSON.
    const text = chunk.toString('utf-8')
    execLog.write(text)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        const t = obj.type as string | undefined
        const msg = obj.msg as Record<string, unknown> | undefined
        const msgType = msg?.type as string | undefined
        process.stderr.write(`[codex-exec] ${t ?? '?'} ${msgType ?? ''}\n`)
      } catch {
        process.stderr.write(`[codex-exec] (non-JSON): ${line.slice(0, 120)}\n`)
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[codex-exec stderr] ${chunk.toString('utf-8')}`)
  })

  let shuttingDown = false
  async function shutdown(code: number, reason: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`[exec-harness] shutdown: ${reason}\n`)
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    try { adapter.detach() } catch { /* best-effort */ }
    try { await proxy.stop() } catch { /* best-effort */ }
    proxyLog.end()
    semanticLog.end()
    execLog.end()

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
          prompt,
          proxyTextLength: proxyText.length,
          proxyTextPreview: proxyText.slice(0, 400),
          execStdoutBytes,
          reason,
        },
        null,
        2,
      ),
    )
    process.stderr.write(`[exec-harness] artifacts: ${runDir}\n`)
    process.exit(code)
  }

  child.on('exit', (code, signal) => {
    process.stderr.write(
      `[exec-harness] codex exec exited (code=${code}, signal=${signal ?? '-'})\n`,
    )
    void shutdown(code ?? 0, 'codex exited')
  })

  child.on('error', err => {
    process.stderr.write(`[exec-harness] spawn error: ${err.message}\n`)
    void shutdown(1, 'spawn error')
  })

  process.on('SIGINT', () => void shutdown(0, 'SIGINT'))
  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'))

  setTimeout(() => {
    void shutdown(1, `duration cap ${durationMs}ms elapsed`)
  }, durationMs)
}

main().catch(err => {
  console.error('[exec-harness] fatal:', err)
  process.exit(1)
})
