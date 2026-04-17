import { spawn as ptySpawn, type IPty } from 'node-pty'

// Spawn the `codex` binary in a PTY with its `openai_base_url` override
// pointed at a local ResponsesProxy.
//
// WHY --config and not an env var:
//   Codex's effective `openai_base_url` is resolved from config merge
//   (toml → CLI overrides → auth file). There's no `OPENAI_BASE_URL`
//   env var that changes the upstream cleanly — setting one would only
//   affect certain subcommands and would be silently ignored by the
//   main TUI. `--config openai_base_url="…"` is the documented,
//   authoritative override that the Rust client reads unconditionally
//   at session start. cc-shell's real CodexSession does the same;
//   see src/providers/codex/runtime/codexSession.ts:141.
//
// WHY no CA cert / proxy env:
//   Unlike Claude (which needs mitmproxy CA injection because
//   Anthropic has no base-URL override), Codex's proxy path is plain
//   HTTP to a loopback server. No TLS interception, no CA trust
//   dance. The only env hygiene we do is force xterm color and
//   remove any ambient HTTPS_PROXY — ambient proxies would double-
//   wrap our redirect and break auth header pass-through.

export type SpawnCodexWithProxyOptions = {
  cwd: string
  cols?: number
  rows?: number
  binary?: string
  /** Proxy base URL, e.g. `http://127.0.0.1:54321/v1`. Passed to
   *  codex as `--config openai_base_url=<JSON-quoted url>`. */
  proxyBaseUrl: string
  /** Optional resume argument: when set, spawns `codex resume <id>`
   *  instead of a fresh session. Useful for harness runs that want
   *  to replay against an existing rollout. */
  resumeSessionId?: string
  /** If true, pass `--dangerously-bypass-approvals-and-sandbox`.
   *  Harness default is OFF — a smoke test should see the approval
   *  overlay so you notice when a parser regression breaks it. */
  dangerousMode?: boolean
}

export function spawnCodexWithProxy(options: SpawnCodexWithProxyOptions): IPty {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }

  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'

  // Strip any ambient HTTP(S)_PROXY — if the harness is run behind a
  // corporate proxy, Codex would otherwise route its requests through
  // THAT proxy instead of our local one, and the upstream would see
  // the corporate proxy's IP with no session context. We want the
  // direct path: codex → 127.0.0.1:PORT → upstream.
  delete env.HTTPS_PROXY
  delete env.https_proxy
  delete env.HTTP_PROXY
  delete env.http_proxy

  const args: string[] = []
  if (options.dangerousMode) {
    args.push('--dangerously-bypass-approvals-and-sandbox')
  }
  if (options.resumeSessionId) {
    args.push('resume', options.resumeSessionId)
  }
  // JSON.stringify quotes the URL so codex's TOML parser treats it
  // as a string literal regardless of characters in the URL (port
  // numbers, forward slashes). Matches cc-shell's production spawn.
  args.push('--config', `openai_base_url=${JSON.stringify(options.proxyBaseUrl)}`)

  return ptySpawn(options.binary ?? 'codex', args, {
    name: 'xterm-256color',
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
    cwd: options.cwd,
    env,
  })
}
