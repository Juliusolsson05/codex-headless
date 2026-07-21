<p align="center">
  <strong>codex-headless</strong>
</p>

<p align="center">
  Programmatically drive the <em>real</em> OpenAI Codex CLI — structured
  events, live token streaming, full rollout-transcript access. No SDK
  shortcuts.
</p>

<p align="center">
  <a href="https://github.com/Juliusolsson05/codex-headless/stargazers"><img src="https://img.shields.io/github/stars/Juliusolsson05/codex-headless?style=flat" alt="Stars"></a>
  <a href="https://github.com/Juliusolsson05/codex-headless/network/members"><img src="https://img.shields.io/github/forks/Juliusolsson05/codex-headless?style=flat" alt="Forks"></a>
  <a href="https://github.com/Juliusolsson05/codex-headless/issues"><img src="https://img.shields.io/github/issues/Juliusolsson05/codex-headless?style=flat" alt="Issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Juliusolsson05/codex-headless?style=flat" alt="License"></a>
  <a href="https://github.com/Juliusolsson05/codex-headless/commits/main"><img src="https://img.shields.io/github/last-commit/Juliusolsson05/codex-headless?style=flat" alt="Last commit"></a>
</p>

---

## Why this exists

OpenAI Codex is a terminal application. If you want to build on top of it
programmatically, today's options are bad:

- **The SDK** gives you a reduced surface — send a message, get a message
  back. It throws away most of what makes Codex good in practice: the
  approval flow, the slash-command system, compaction, session resume,
  the full tool loop, the real streaming behaviour.
- **Screen-scraping the TUI** is brittle and gives you pixels, not
  meaning.

`codex-headless` takes the opposite approach. It runs the **actual
`codex` binary** inside a pseudo-terminal and exposes everything the CLI
does as structured, typed events. The full command surface, the real
prompts, the real flows stay intact. You get the real product,
programmatically.

This is a control layer. Build an editor, an automation, a multi-agent
orchestrator, a harness — anything that needs to drive Codex without
giving up what Codex actually is.

It is the sibling of [`claude-code-headless`](https://github.com/Juliusolsson05/claude-code-headless)
and mirrors its API where the two providers genuinely behave the same.

## What you get

- **The real CLI, in a PTY.** Every command, prompt, tool, and flow the
  `codex` binary has, you have. Nothing is reimplemented or reduced.
- **A three-channel event model.** Observation is split into three typed
  streams so you never confuse "the model produced this" with "this is
  on screen" with "this is durably committed":
  - `semantic` — what the model is producing (text, tool calls)
  - `screen` — terminal visual state (overlays, activity)
  - `committed` — the durable rollout transcript, as written to disk
- **The rollout stream is a live semantic source.** Unlike Claude Code's
  write-on-complete transcript, Codex's rollout JSONL emits
  `agent_message_delta` and tool-lifecycle events *as they happen* — so
  `semantic` is authoritative (`source: 'rollout'`, high confidence)
  with zero screen-scraping on the happy path.
- **Optional live streaming via a plain-HTTP proxy.** Codex natively
  supports a custom `openai_base_url`, so a local HTTP server can sit in
  front of the Responses API — no TLS interception — and surface
  assistant output token-by-token.
- **Rollout transcript access.** Structured, typed tailing of Codex's
  own JSONL rollouts under `~/.codex/sessions/`.
- **TUI parsers + a conditions system.** Trust dialogs and approval
  overlays are detected and turned into typed *conditions* — each with
  the exact actions (keystrokes) needed to answer them.
- **Embeddable.** Pure-function parsers, a consumer-owned PTY, no global
  state. Drop it into an Electron app, a server, a CLI tool.

## Use it

`codex-headless` is **not published to npm**. Use it one of two ways.

**Install from git** — npm can install straight from the repository:

```bash
npm install github:Juliusolsson05/codex-headless node-pty
```

**Or vendor it** — clone (or add as a submodule) and build from source:

```bash
git clone https://github.com/Juliusolsson05/codex-headless.git
cd codex-headless
npm install
npm run build
```

Either way you also need the `codex` CLI itself installed and on your
`PATH` — this package drives the real binary. `node-pty` is a peer
dependency; the consumer provides it (and owns the PTY).

## Quick start

```ts
import { CodexHeadless } from 'codex-headless'
import { spawn } from 'node-pty'

// You own the PTY. The library never spawns or kills processes for you.
const pty = spawn('codex', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
})

const codex = new CodexHeadless({ pty, cwd: process.cwd() })

// Live assistant text — sourced from Codex's rollout delta stream.
codex.semantic.on('turn_delta', (e) => process.stdout.write(e.textDelta ?? ''))

// Durable transcript turns, as they commit to the rollout file.
codex.committed.on('turn_committed', (e) => {
  console.log(`\n[${e.role}] committed`)
})

await codex.start()
codex.sendPrompt('Explain this repository in two sentences.')
```

## How it works

The package combines these pieces:

| Piece | Role |
|---|---|
| **PTY mirror** | `codex` runs in a pseudo-terminal; an `@xterm/headless` instance mirrors the screen so visual state is always queryable. |
| **Rollout tailer** | Codex's rollout JSONL is tailed with a poll-based watcher. Its `event_msg` deltas are a *live* semantic source — live tokens surface on `semantic`, durable history on `committed`. |
| **Responses proxy** *(optional)* | A plain local HTTP server that Codex's `openai_base_url` config override points at. It forwards traffic to the real OpenAI/ChatGPT upstream and re-emits the SSE so the `semantic` channel can be driven with `source: 'proxy'`. No TLS interception. |
| **Parsers + conditions** | Pure functions detect TUI overlays (trust dialog, approval); the conditions system turns each into a typed object carrying the exact actions needed to answer it. |

The full reference is [`API.md`](API.md) — every export, every channel
event and field, every option, with usage and recipes.

## Project structure

```
src/
  index.ts            Public API surface
  CodexHeadless.ts     The orchestrator class
  channels/           Three-channel event model (semantic/screen/committed)
  conditions/         Approval / trust-dialog → typed action conditions
  terminal/           @xterm/headless + node-pty wrapper
  parsers/            Pure-function TUI parsers (activity, approval, trust)
  proxy/              Plain-HTTP Responses proxy + Responses-API SSE adapter
  transcript/         Rollout JSONL tailing, session discovery, types
```

## Status

Early and moving. This is `0.x` — the API surface is still settling and
breaking changes land without ceremony. Pin a version.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, the branch workflow,
and PR guidelines.

## Security

This package spawns the real `codex` CLI and — when the proxy is enabled
— routes its API traffic through a local process. That has real security
implications. Read [`SECURITY.md`](SECURITY.md) before enabling the
proxy, and to report a vulnerability.

## License

[MIT](LICENSE) © Julius Olsson
