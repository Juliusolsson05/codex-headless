# codex-headless — API Reference

Exhaustive reference for everything `codex-headless` exports. This
document is self-sufficient for using the package — there is no
separate `EVENT_SPEC.md` or `PROXY_STREAMING.md`; everything is here.

Every symbol named here is exported from the package root
(`src/index.ts`). Source files are cited as `src/<file>.ts` where it
helps.

`codex-headless` is the sibling of `claude-code-headless` and mirrors
its three-channel truth model. The provider-specific differences live
in the parsers (Codex's TUI markers differ), the transcript types
(Codex's "rollout" JSONL format differs from Claude's per-cwd JSONL),
the conditions system (Codex-only — Claude has no equivalent), and the
proxy (Codex's proxy is a plain HTTP forwarding server, not a
mitmproxy TLS interceptor).

---

## 1. Orientation

`codex-headless` programmatically controls a running OpenAI Codex
(`codex`) process. You spawn the CLI yourself in a PTY; the package
mirrors that PTY through a headless `xterm`, parses the TUI, tails
Codex's "rollout" JSONL transcript, and (optionally) consumes
proxy-captured OpenAI Responses-API SSE traffic. It emits structured,
typed events.

The package **never spawns or kills processes**, **never auto-accepts
dialogs**, and **never writes to the filesystem** beyond reading
Codex's session directory (the optional proxy can mirror events to a
JSONL file when you explicitly pass `eventsFile`). The consumer owns
the PTY lifecycle.

### Mental model

```
                  ┌──────────────────────────────┐
   your PTY  ───▶  │         CodexHeadless         │  ◀─── proxy SSE events
  (codex CLI)      │   (orchestrator + ownership)  │       (optional)
                  └──────────────┬───────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  semantic channel         screen channel          committed channel
 "what Codex is           "what is on the          "what has persisted
   producing now"          terminal now"            to the rollout"
```

Five subsystems compose into the orchestrator:

- **Orchestrator** — `CodexHeadless`. Owns the PTY mirror, the rollout
  JSONL tailer, parser dispatch, live-turn ownership policy, the
  conditions evaluator, and the three channels.
- **Three channels** — `semantic`, `screen`, `committed`. Independent
  typed event streams. The preferred public contract.
- **Conditions** — a Codex-specific subsystem that turns
  screen-detected interactive states (trust dialog, command-approval
  overlay, model-switch prompt) into a typed "what is blocking the
  session right now and how do I answer it" snapshot.
- **Proxy adapter** — `ResponsesProxy` + `CodexResponsesAdapter`.
  Optional. A plain-HTTP forwarding server plus an SSE parser that
  publishes block-structured semantic events with `source: 'proxy'`.
- **Pure parsers / transcript helpers** — stateless functions you can
  use standalone without an orchestrator at all.

### The three semantic sources

Codex's semantic channel can be driven by three sources, ranked by
trust:

| `source` | What it is | Confidence |
| --- | --- | --- |
| `proxy` | OpenAI Responses-API SSE bytes observed live by the proxy. Block-structured, instant. | `high` |
| `rollout` | Codex's append-only `rollout-*.jsonl` `event_msg` delta stream. Authoritative but slightly latent (written after the fact). | `high` (live deltas) / `medium` (committed catch-up) |
| `screen` | The TUI viewport parsed by the screen extractor. A fallback for the brief window before the rollout file exists. | `fallback` |

A consumer who only wants rollout/screen observation does not need the
proxy at all — `CodexHeadless` stays fully functional with `rollout`
and `screen` alone. The proxy surface is purely additive.

### Import surface

```ts
import {
  // Orchestrator + legacy flat events
  CodexHeadless,
  // Channels
  CodexSemanticChannel, CodexScreenChannel, CodexCommittedChannel,
  // Terminal
  HeadlessTerminal, terminalToMarkdown,
  // Parsers
  detectCodexWorkingState, extractCodexStreamingText,
  extractCodexAssistantInProgress, detectCodexActivity,
  isCodexChromeLine, isCodexDividerLine, isCodexPromptLine,
  isCodexUserPromptLine, isCodexStatusLine, isCodexIntermediateChromeLine,
  detectCodexApproval, isApprovalOverlayVisible,
  detectCodexTrustDialog, CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  diffLines,
  // Transcript
  isCodexConversationEntry, isCodexResponseItem, isCodexEventMsg,
  isCodexSessionMeta, extractCodexMessageText, parseCodexFunctionArgs,
  getCodexHome, getCodexSessionsDir, listCodexSessions,
  // Proxy
  ResponsesProxy, CodexResponsesAdapter,
} from 'codex-headless'
```

All TypeScript types (`CodexHeadlessOptions`, `CodexSemanticEvent`,
`ScreenSnapshot`, `CodexRolloutLine`, `CodexCondition`, etc.) are
exported alongside their runtime counterparts. The package is ESM
(`"type": "module"`).

Note that several channel/event types are re-exported under a
`Codex`-prefixed alias to avoid name collisions when both
`codex-headless` and `claude-code-headless` are imported in the same
file — e.g. `SemanticChannel` is exported as `CodexSemanticChannel`,
`SemanticEvent` as `CodexSemanticEvent`. The §-tables below give both
the alias and the underlying source name.

### Dependencies

| Dependency | Kind | Notes |
| --- | --- | --- |
| `@xterm/headless` | dependency | Headless terminal emulator. |
| `chokidar` | dependency | Directory watcher for new-rollout detection. |
| `node-pty` | **peer dependency** | You provide it; the package types against `IPty`. |

The proxy uses only Node built-ins (`http`, `net`, `stream`, `fs`) —
no extra runtime dependency, unlike `claude-code-headless` which needs
an external `mitmdump`.

---

## 2. Getting started

### Install / build

```bash
npm install codex-headless node-pty
# building from source:
npm run build   # tsc only — no asset copy step
```

`main` is `dist/index.js`, `types` is `dist/index.d.ts`. Only `dist/`
is published. License: MIT.

### Minimal end-to-end example (no proxy)

```ts
import { spawn } from 'node-pty'
import { CodexHeadless } from 'codex-headless'

const cwd = process.cwd()

// 1. You own the PTY. Spawn the codex binary however you like.
const pty = spawn('codex', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd,
  env: process.env,
})

// 2. Construct the orchestrator with your PTY + cwd.
const codex = new CodexHeadless({ pty, cwd })

// 3. Subscribe BEFORE start() so you miss nothing.
codex.committed.on('turn_committed', ev => {
  console.log(`[${ev.role}] ${ev.text}`)
})
codex.screen.on('activity', ev => {
  console.log(ev.active ? `working: ${ev.status}` : 'idle')
})

// 4. start() resolves the rollout sessions dir and attaches the
//    tailer, THEN begins mirroring PTY data. Always await it.
const { sessionsDir } = await codex.start()

// 5. Drive the session.
codex.sendPrompt('Say hello in three words')

// 6. Teardown — detaches tailer + terminal. Does NOT kill the PTY.
//    process.on('exit', () => { void codex.stop(); pty.kill() })
```

### Lifecycle

1. **construct** — `new CodexHeadless(options)`. Inert: builds the
   `HeadlessTerminal` and the three channels, but does not subscribe
   to PTY data yet.
2. **subscribe** — attach listeners on the three channels and/or the
   legacy flat events.
3. **`await start()`** — resolves `~/.codex/sessions/`, attaches the
   rollout JSONL tailer (watching the date tree for the new
   `rollout-*.jsonl`, or locating the existing file by thread id on
   the resume path), **then** calls `terminal.attach()` so PTY bytes
   start flowing. The tailer-before-terminal ordering guarantees no
   rollout entry is missed.
4. **drive** — `sendPrompt()`, `write()`, `resize()`, answer dialogs.
5. **observe** — events on `semantic` / `screen` / `committed`.
6. **`await stop()`** — disposes the terminal mirror and the rollout
   tailer. The PTY is yours to kill.

The `exit` event fires when the PTY child exits; cleanup of the
rollout tailer runs automatically as part of that (`cleanup()`), but
the terminal mirror is only torn down by an explicit `stop()`.

### Why Codex differs from Claude

These deltas are why the parsers/transcript/proxy modules cannot be
shared verbatim with `claude-code-headless` (see the header comment in
`src/CodexHeadless.ts`):

| Aspect | Claude Code | Codex |
| --- | --- | --- |
| Binary | `claude` | `codex` |
| Resume | `--resume` flag | `codex resume <id>` subcommand |
| Transcript | `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl` (per-cwd) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (date-bucketed globally) |
| Assistant marker | `⏺` | `•` (or older `◦`) |
| User marker | `❯` | `›` |
| Trust prompt | "Accessing workspace" | "Do you trust the contents of this directory" |
| Proxy | mitmproxy TLS interceptor | plain HTTP server behind `openai_base_url` |

---

## 3. `CodexHeadless`

`src/CodexHeadless.ts`. Extends `EventEmitter`. The orchestrator.

### 3.1 Constructor options — `CodexHeadlessOptions`

```ts
const codex = new CodexHeadless(options: CodexHeadlessOptions)
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `pty` | `IPty` | — (required) | Consumer-owned PTY running the `codex` binary. The class never spawns or kills it. |
| `cwd` | `string` | — (required) | Working directory the Codex session runs in. Captured for reference; note Codex's rollout files are NOT per-cwd, so `cwd` does not change which directory is tailed (the whole `~/.codex/sessions/` tree is watched). |
| `cols` | `number` | `120` | Terminal columns for the headless xterm mirror. |
| `rows` | `number` | `40` | Terminal rows for the headless xterm mirror. |
| `snapshotIntervalMs` | `number` | `16` | Throttle interval (ms) for screen snapshots — ~60 Hz. |
| `resumeThreadId` | `string` | unset | If set, tail the existing rollout file whose name contains this thread id instead of waiting for a new one. For `codex resume <id>` flows. Bootstraps the tailer from a bounded 200-line tail. |

There is no `proxy` sub-option. Unlike `claude-code-headless`, the
proxy is wired up externally: you create a `ResponsesProxy`, create a
`CodexResponsesAdapter(proxy, codexHeadless)`, and call `adapter.attach()`.
See §9.

### 3.2 Public fields

| Field | Type | Description |
| --- | --- | --- |
| `semantic` | `SemanticChannel` | Authoritative "what Codex is producing" stream. Proxy and rollout publish here; screen does **not**. |
| `screen` | `ScreenChannel` | Visual terminal truth — snapshots, activity, trust-dialog/approval overlays. |
| `committed` | `CommittedChannel` | Durable rollout transcript history. |
| `semanticShadow` | `SemanticChannel` | Shadow channel that receives **screen-fallback** semantic publishes (synthetic `live-<ts>` turns). Renderers should NOT subscribe to this — it exists for debug panels. See §3.6. |

There is no public `proxy` field — the `CodexResponsesAdapter`
publishes onto `semantic` directly and is held by the consumer, not by
`CodexHeadless`.

### 3.3 Methods

#### `start()`

```ts
start(): Promise<{ sessionsDir: string }>
```

Resolves Codex's session directory (`~/.codex/sessions/`, honoring
`$CODEX_HOME`), attaches the rollout JSONL tailer, then calls
`terminal.attach()` to begin mirroring PTY data. **Always await this
before sending input.**

- **Fresh session** — recursively watches the date tree (depth 4) for
  the first new `rollout-<date>-<uuid>.jsonl` file, then tails it.
- **Resume path** (`resumeThreadId` set) — walks the date tree
  backwards (newest dates first) for a filename containing the thread
  id and tails it with a 200-line bootstrap tail. If the lookup misses
  (a date-tree race, or a resume that forks a new rollout file), it
  emits a non-fatal `rollout-error` and falls back to the new-file
  watcher.

Returns `{ sessionsDir }` — the resolved absolute path of
`~/.codex/sessions/`.

#### `sendPrompt(text)`

```ts
sendPrompt(text: string): void
```

Sends a prompt and submits it. Single-line text is written as
`text + '\r'`. **Multi-line** text is wrapped in bracketed paste
(`\x1b[200~…\x1b[201~\r`) so Codex treats embedded newlines as literal
input rather than submit events.

#### `write(data)`

```ts
write(data: string): void
```

Writes raw bytes to the PTY. Use for keystroke synthesis (answering
dialogs, sending escape sequences). The trust-dialog `accept`/`reject`
callbacks on the flat events, and every condition `pty` action, are
built on this.

#### `resize(cols, rows)`

```ts
resize(cols: number, rows: number): void
```

Resizes the PTY and the headless terminal in lockstep. Swallows
node-pty errors on 0/negative dimensions.

#### State queries

| Method | Returns | Description |
| --- | --- | --- |
| `isIdle()` | `boolean` | True if Codex's Working row is NOT visible (waiting for input). |
| `isWorking()` | `boolean` | True if the Working row IS visible. |
| `getActivity()` | `string \| null` | Current activity verb (e.g. `"working… 10s"`) or `null` if idle. |
| `getScreen()` | `string` | Current plain-text viewport snapshot. |
| `getScreenMarkdown()` | `string` | Current viewport with bold/italic reconstructed as markdown. |
| `getAssistantInProgress()` | `string` | In-progress assistant text extracted from the current viewport; `''` if none yet. |
| `getApprovalState()` | `ScreenApproval \| null` | Last-detected command-approval overlay state, or `null`. |
| `getConditionSnapshot()` | `CodexConditionSnapshot` | Current conditions snapshot (§6). |
| `getSessionMeta()` | `CodexSessionMeta \| null` | The `session_meta` payload from the first rollout entry, if seen. |
| `isExited()` | `boolean` | True if the PTY has exited. |

#### `stop()`

```ts
stop(): Promise<void>
```

Disposes the terminal mirror and detaches the rollout JSONL tailer
(best-effort — a failing tailer close is swallowed). **Does not kill
the PTY** — the consumer owns it.

There is no `listResumableSessions` method on `CodexHeadless`; use the
free function `listCodexSessions` (§8.3) directly.

### 3.4 Legacy flat event surface

`CodexHeadless` is an `EventEmitter` typed by `CodexHeadlessEvents`.
This flat surface predates the three channels and **still fires** so
existing consumers keep working. New code should prefer the channels
(§4). Subscribe with `codex.on('<name>', cb)`.

| Event name | Listener args | Notes |
| --- | --- | --- |
| `event` | `[CodexHeadlessEvent]` | Catch-all union of every flat event (see below). |
| `activity` | `[string]` | Activity verb when Codex starts working. |
| `idle` | `[]` | Debounced (~2.5 s) idle transition. |
| `screen` | `[ScreenSnapshot]` | Every throttled screen snapshot (full `ScreenSnapshot`, incl. `recent`/`recentMarkdown`). |
| `rollout-entry` | `[CodexRolloutLine, string]` | Raw rollout JSONL line + file path. |
| `rollout-error` | `[Error]` | Rollout read error (also: resume-lookup miss). |
| `trust-dialog` | `[CodexTrustDialogState]` | Trust dialog state changed (fires on **every** visible↔hidden transition). |
| `approval` | `[ScreenApproval \| null]` | Command-approval overlay state changed. |
| `conditions` | `[CodexConditionSnapshot]` | Conditions snapshot changed (deduped on a JSON key). |
| `exit` | `[{ exitCode: number; signal?: number }]` | PTY child exited. |
| `live-owner-change` | `[LiveOwnerDecision]` | Diagnostic: live-turn ownership transition. **Not** part of the `event` union — see §3.6. |

#### The `CodexHeadlessEvent` union (the `event` catch-all)

`CodexHeadlessEvent` is a discriminated union on `type`. Every member
also carries `ts: number` (epoch ms).

| `type` | Type alias | Extra fields |
| --- | --- | --- |
| `activity` | `CodexActivityEvent` | `status: string` |
| `idle` | `CodexIdleEvent` | — |
| `screen` | `CodexScreenEvent` | `plain: string`, `markdown: string` (only these two — not the wider `recent` fields) |
| `rollout_entry` | `CodexRolloutEntryEvent` | `line: CodexRolloutLine`, `file: string` |
| `trust_dialog` | `CodexTrustDialogEvent` | `workspace: string \| undefined`, `accept(): void`, `reject(): void` |
| `conditions` | `CodexConditionsEvent` | `snapshot: CodexConditionSnapshot` |
| `exit` | `CodexExitEvent` | `exitCode: number`, `signal?: number` |

Notes on the `trust_dialog` action callbacks:

- `accept()` writes `CODEX_TRUST_DIALOG_ACCEPT_KEYS` (`'\r'`) —
  confirms the pre-selected "Yes, continue".
- `reject()` writes `'2\r'` — selects "No, quit".

The `event` flat surface only emits a `{ type: 'trust_dialog', … }`
member when the dialog becomes **visible**; the simple `trust-dialog`
event carries the full state on every transition (open AND dismiss),
so a renderer that needs to learn the dialog closed must listen to
`trust-dialog` (or the screen channel's `trust_dialog`), not the
`event` union.

There is no flat event for the command-approval overlay in the
`CodexHeadlessEvent` union — it surfaces via the simple `approval`
event, the `screen` channel's `approval` event, and the conditions
system. (`exec_approval_request` rollout events feed
`approvalMetadata` into the conditions evaluator; they are not
themselves re-emitted as a flat event.)

> **Caveat — `activity` is not a submit verdict.** It is debounced
> (~2.5 s on the idle edge) and the underlying Working-row regex has
> real mid-turn gaps during tool-output animation. Do not gate "did my
> prompt submit?" on `activity`. Prefer "a new committed entry
> arrived" on the committed channel.

### 3.5 Activity / idle debounce

Codex's bottom "Working" row is more stable than Claude's rotating
spinner, but it still briefly vanishes between TUI redraws (tool-call
animation cycles, header swaps). `CodexHeadless` therefore applies the
same **2500 ms idle debounce** as the Claude package: `activity` fires
immediately on the working→idle→working edge into `active`, but the
`idle` transition is delayed and re-checked against the current screen
so a transient empty frame does not flicker the activity pip.

### 3.6 Live-turn ownership model

The orchestrator enforces **at most one authoritative live semantic
producer at a time**. `LiveOwnerKind` is `'proxy' | 'rollout' |
'screen'`. State is tracked in `LiveOwnerState`:

```ts
interface LiveOwnerState {
  kind: LiveOwnerKind | null
  turnId: string | null
  startedAt: number | null
  status: 'idle' | 'live' | 'reconciling'
}
```

Every transition emits a `LiveOwnerDecision` on `live-owner-change`:

```ts
interface LiveOwnerDecision {
  accept: boolean
  action: 'start' | 'drop' | 'promote' | 'finalize' | 'clear'
  kind: LiveOwnerKind
  turnId: string
  reason: string
  prev: LiveOwnerState
  next: LiveOwnerState
  ts: number
}
```

Ownership lifecycle:

- **`screen`** claims when TUI activity is detected AND no other owner
  exists. It opens a synthetic `live-<ts>` turn on the **shadow**
  channel (`semanticShadow`), not on `semantic`. Yields to
  rollout/proxy when they preempt it; released on the idle debounce.
- **`rollout`** claims on a `task_started` / `turn_started` `event_msg`
  in the rollout stream. Yields on `task_complete` / `turn_complete`.
  Takes priority over screen.
- **`proxy`** claims when `CodexResponsesAdapter` fires a proxy-sourced
  `turn_started` on `semantic`. Yields on the proxy `turn_completed`.
  Takes priority over screen.

Consequences for consumers:

- The renderer should subscribe to **`semantic`**. Screen-derived live
  *content* lands on `semanticShadow` only — by deliberate design,
  this eliminates cross-source flicker at the cost of a degraded live
  UX for the brief no-rollout-yet window.
- A coarse `stream_phase` (`thinking` / `idle`) IS published to the
  real `semantic` channel by the screen fallback when no proxy owns
  the turn — so a consumer still gets a "working" signal even without
  proxy or rollout deltas.
- Reconcile across channels by **text + timing**, not id equality: the
  synthetic `live-<ts>` id is not a rollout `turn_id` and not a
  proxy `response.id`.

`live-owner-change` is intentionally kept off the typed `event` union
so consumers that do not care about ownership diagnostics incur no
type churn.

---

## 4. The three channels

Each channel is a small `EventEmitter` subclass with a typed event
map. Subscribe with `.on('<type>', cb)`. Every channel also emits a
catch-all `'event'` carrying the union of that channel's events — use
it when you want one handler for everything.

```ts
codex.semantic.on('turn_delta', ev => { /* per-type */ })
codex.semantic.on('event', ev => { /* catch-all union */ })
```

The split exists so consumers never blur "I saw it on the terminal"
with "Codex said it happened." See `src/channels/types.ts`.

Runtime classes and their exported aliases:

| Source class | Exported alias | Events type (alias) |
| --- | --- | --- |
| `SemanticChannel` | `CodexSemanticChannel` | `CodexSemanticChannelEvents` |
| `ScreenChannel` | `CodexScreenChannel` | `CodexScreenChannelEvents` |
| `CommittedChannel` | `CodexCommittedChannel` | `CodexCommittedChannelEvents` |

### Provenance tags

Every semantic event carries two tags:

- `source: SemanticSource` — `'rollout' | 'proxy' | 'screen'`
  (exported as `CodexSemanticSource`). Trust ranking: proxy ≈ rollout
  > screen.
- `confidence: SemanticConfidence` — `'high' | 'medium' | 'fallback'`
  (exported as `CodexSemanticConfidence`). `high` = `event_msg` delta
  or proxy SSE; `medium` = derived from a committed rollout entry
  after the fact; `fallback` = inferred from TUI paint — be defensive
  about any destructive action keyed on the content.

### 4.1 `SemanticChannel` (`CodexSemanticChannel`)

`src/channels/SemanticChannel.ts`. "What Codex is producing right
now." Stream-shaped: events are strictly ordered per `turnId`. Never
emits visual-only state (trust dialogs, approval overlays) — that is
the screen channel's job.

#### Lifecycle strictness

The channel is a **strict transport, not a healer**:

- `startTurn` while a different turn is active → **dropped**, emits
  `lifecycle_violation` (`kind: 'start_while_active'`). Same-turn
  re-entry is an idempotent no-op.
- `applyDelta` for a turnId that is not the active turn → **dropped**,
  emits `lifecycle_violation` (`kind: 'delta_mismatched_turn'`).
- `finishTurn` for a mismatched turnId → **dropped**, emits
  `lifecycle_violation` (`kind: 'finish_mismatched_turn'`).
  `finishTurn` for the active turn is idempotent (first wins).

Producer coherence is enforced by the orchestrator's ownership model
(§3.6), not by the channel.

#### Read methods

| Method | Returns | Description |
| --- | --- | --- |
| `getActiveTurnId()` | `string \| null` | Currently active turnId on the wire. |
| `getLastSource()` | `SemanticSource \| null` | Source of the most recent delta. |
| `getLastFullText()` | `string` | Last known full text for the active turn. |
| `getLastPhase()` | `StreamPhase` | Last published stream phase. |

#### Publish methods

Most consumers only *subscribe*. Publishers (the proxy adapter, the
orchestrator's rollout ingest, the screen fallback) call: `startTurn`,
`applyDelta`, `finishTurn`, `toolStarted`, `toolOutputDelta`,
`toolCompleted`, `publishBlockStarted`, `publishTextDelta`,
`publishThinkingDelta`, `publishBlockCompleted`, `publishTurnStopped`,
`publishStreamError`, `publishApiError`, `publishFlowSelected`,
`publishFlowIgnored`, `publishUsageUpdated`, `publishStreamPhase`.
Each takes a `params` object whose fields mirror the corresponding
event below (minus `type` and `ts`); `confidence` defaults to `high`
for proxy/rollout sources and `fallback` for screen (stream errors
default to `medium`).

#### Events — `SemanticChannelEvents`

All events carry `ts: number`, `source: SemanticSource`,
`confidence: SemanticConfidence` unless noted. `'event'` is the
catch-all (`SemanticEvent` union, exported as `CodexSemanticEvent` —
it **excludes** `lifecycle_violation`).

##### Turn-level aggregate

**`turn_started`** → `SemanticTurnStartedEvent`
(alias `CodexSemanticTurnStartedEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_started'` | |
| `turnId` | `string` | Rollout `turn_id`, proxy `response.id`, or a synthetic `live-<ts>` / `rollout-<ts>` id. |
| `role` | `'user' \| 'assistant'` | In practice always `'assistant'` for Codex turns. |

**`turn_delta`** → `SemanticTurnDeltaEvent`
(alias `CodexSemanticTurnDeltaEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_delta'` | |
| `turnId` | `string` | |
| `textDelta?` | `string` | Incremental piece. May be absent for snapshot-only deltas. |
| `fullText` | `string` | Full running text. Always present so late subscribers can catch up. |
| `markdownText?` | `string` | Markdown-flavored text when the source can provide it (the screen fallback can; rollout deltas deliver plain UTF-8). |

**`turn_completed`** → `SemanticTurnCompletedEvent`
(alias `CodexSemanticTurnCompletedEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_completed'` | |
| `turnId` | `string` | |
| `fullText?` | `string` | Final settled text for the turn. |

**`source_changed`** → `SemanticSourceChangedEvent`
(alias `CodexSemanticSourceChangedEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'source_changed'` | |
| `turnId` | `string \| null` | |
| `previousSource` | `SemanticSource \| null` | |
| `source` | `SemanticSource` | New authoritative source. Fired before a delta whose source differs from the last delta's. |

##### Tool lifecycle (rollout-driven, first-class for Codex)

Codex's rollout stream emits `exec_command_begin` /
`exec_command_output_delta` / `exec_command_end` and the MCP
equivalents. These map to a coarse tool lifecycle.

**`tool_started`** → `SemanticToolStartedEvent`
(alias `CodexSemanticToolStartedEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'tool_started'` | |
| `turnId` | `string \| null` | The active turn at the time, if any. |
| `callId` | `string` | Upstream call id, or a synthetic `exec-<ts>` / `mcp-<ts>` fallback. |
| `tool` | `'exec' \| 'mcp' \| 'custom' \| 'function'` | |
| `label?` | `string` | Best-effort label. For `exec`: the command array joined with spaces. For `mcp`: `${server}.${tool}`. |

**`tool_output_delta`** → `SemanticToolOutputDeltaEvent`
(alias `CodexSemanticToolOutputDeltaEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'tool_output_delta'` | |
| `callId` | `string` | Pairs against the `tool_started` of the same call. |
| `textDelta` | `string` | Incremental tool output. Empty deltas are dropped. |

**`tool_completed`** → `SemanticToolCompletedEvent`
(alias `CodexSemanticToolCompletedEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'tool_completed'` | |
| `callId` | `string` | |
| `exitCode?` | `number` | Process exit code for `exec` calls. |

##### Block-level stream (proxy-driven, Responses-API alignment)

Block events carry `SemanticBlockRef` fields: `turnId: string`,
`blockIndex: number` (the upstream `output_index`), and optional
`itemId?: string` (the upstream item id, e.g. `rs_…`, `msg_…`,
`fc_…`).

`SemanticBlockKind` (exported indirectly via the block events) is one
of:

```
'message' | 'reasoning' | 'function_call' | 'function_call_output' |
'custom_tool_call' | 'custom_tool_call_output' | 'tool_search_call' |
'tool_search_output' | 'local_shell_call' | 'web_search_call' |
'image_generation_call' | 'compaction' | 'ghost_snapshot' | 'other'
```

**`block_started`** → `SemanticBlockStartedEvent`

Fires at `response.output_item.added`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'block_started'` | |
| `turnId`, `blockIndex`, `itemId?` | | Block ref. |
| `kind` | `SemanticBlockKind` | |
| `toolName?` | `string` | For function / custom tool calls. |
| `callId?` | `string` | For tool / function variants — pairs against the later `*_output` block. |
| `messagePhase?` | `'commentary' \| 'final_answer'` | For `message` blocks when the model declared one. `undefined` = unknown. |
| `status?` | `string` | Initial upstream status (e.g. `"in_progress"`). |

**`text_delta`** → `SemanticTextDeltaEvent`

Fires from `response.output_text.delta`, keyed to the open `message`
block.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'text_delta'` | |
| `turnId`, `blockIndex`, `itemId?` | | Block ref. |
| `textDelta` | `string` | This delta's text. |
| `textSoFar` | `string` | Running accumulator for the block. |

**`thinking_delta`** → `SemanticThinkingDeltaEvent`

Fires from `response.reasoning_text.delta` (track `'full'`) and
`response.reasoning_summary_text.delta` (track `'summary'`).

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'thinking_delta'` | |
| `turnId`, `blockIndex`, `itemId?` | | Block ref. |
| `track` | `'summary' \| 'full'` | Which reasoning track. |
| `thinkingDelta` | `string` | This delta's text. |
| `thinkingSoFar` | `string` | Running accumulator for that track. |
| `index` | `number` | Upstream `summary_index` (summary) or `content_index` (full). |

**`block_completed`** → `SemanticBlockCompletedEvent`

Fires at `response.output_item.done`. The authoritative "this block is
settled" signal. Optional fields are populated per-`kind`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'block_completed'` | |
| `turnId`, `blockIndex`, `itemId?` | | Block ref. |
| `kind` | `SemanticBlockKind` | |
| `text?` | `string` | For `message`: flattened `output_text` content. |
| `reasoningSummary?` | `string` | For `reasoning`: joined `summary_text`. |
| `reasoningText?` | `string` | For `reasoning`: joined `reasoning_text` / `text`. |
| `toolName?`, `callId?` | `string` | For tool variants. |
| `argumentsJson?` | `string` | For `function_call`: raw arguments JSON (may be invalid). For `custom_tool_call`: the raw `input` string. |
| `parsedArguments?` | `Record<string, unknown>` | Best-effort `JSON.parse` of `argumentsJson`. |
| `parseError?` | `string` | Set when `argumentsJson` failed to parse. |
| `output?` | `unknown` | For `function_call_output` / `custom_tool_call_output`: the output payload as-is. |
| `webSearchAction?` | object | For `web_search_call`: `{ kind: 'search'\|'open_page'\|'find_in_page'\|'other'; query?; queries?; url?; pattern? }`. |
| `imageGeneration?` | object | For `image_generation_call`: `{ status; revisedPrompt?; result }` — `result` is base64. |
| `localShellCall?` | object | For `local_shell_call`: `{ status; command: string[]; workingDirectory?; timeoutMs?; env?; user? }`. |
| `status?` | `string` | Final upstream status if the item carried one. |
| `raw?` | `Record<string, unknown>` | Full raw upstream item — future-proofing for new variants. |

##### Turn lifecycle beyond start/delta/complete

**`turn_stopped`** → `SemanticTurnStoppedEvent`

Fires when the turn ended with information beyond "done": a rollout
`turn_aborted`, or a proxy `response.incomplete`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_stopped'` | |
| `turnId` | `string` | |
| `stopReason` | `string \| null` | Freeform — codex-rs's `incomplete_details.reason` is a freeform string. Common values: `max_output_tokens`, `content_filter`, `interrupted`. `null` = stream ended without one. |
| `isRefusal` | `boolean` | Convenience for `stopReason === 'refusal'`. |

##### Error events

Two tiers, mirroring the Claude package.

**`stream_error`** → `SemanticStreamErrorEvent`

Soft. The adapter's own SSE parser hit a malformed frame; the turn
continues if possible.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'stream_error'` | |
| `turnId` | `string \| null` | |
| `errorType` | `string` | Machine tag — e.g. `json_parse_error`, `unexpected_frame_shape`, `missing_required_field`. |
| `message` | `string` | |

Default `confidence` for stream errors is `medium`.

**`api_error`** → `SemanticApiErrorEvent`

Hard. The request failed. Classification ports codex-rs's `ApiError`
taxonomy.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'api_error'` | |
| `turnId` | `string \| null` | |
| `errorType` | `'context_window_exceeded' \| 'quota_exceeded' \| 'usage_not_included' \| 'server_overloaded' \| 'invalid_request' \| 'retryable' \| 'stream'` | Stable identifier for UI branching. |
| `message` | `string` | Human-readable text. |
| `retryAfterMs?` | `number` | For `retryable`: server-suggested delay. |
| `status?` | `number` | HTTP status when available. |
| `isOverloaded?` | `boolean` | Convenience for `errorType === 'server_overloaded'`. |

##### Usage accounting

**`usage_updated`** → `SemanticUsageEvent`
(alias `CodexSemanticUsageEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'usage_updated'` | |
| `turnId` | `string` | |
| `usage` | `Record<string, number \| string \| undefined>` | Flat map. Nested upstream shapes (e.g. `input_tokens_details`) are flattened to `parent.child` keys. Missing = "unchanged". |
| `costUSD?` | `number` | Cost estimate. The adapter does not populate this today — reserved for consumer-layer enrichment. |

##### Flow attribution (proxy-sourced diagnostics)

`flow_*` events fire only when a proxy is wired in — the rollout source
has no notion of HTTP "flows".

**`flow_selected`** → `SemanticFlowSelectedEvent`
(alias `CodexSemanticFlowSelectedEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'flow_selected'` | |
| `turnId` | `string \| null` | |
| `flowId` | `string` | Adapter-minted `proxy-N` id. |
| `reason` | `string` | Freeform — e.g. `"first-chunk (no competing active flow)"`. |

**`flow_ignored`** → `SemanticFlowIgnoredEvent`
(alias `CodexSemanticFlowIgnoredEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'flow_ignored'` | |
| `flowId` | `string` | |
| `reason` | `string` | Why this flow was excluded — e.g. `"concurrent with active flow proxy-2"`. |

##### Stream phase

**`stream_phase`** → `SemanticStreamPhaseEvent`

"What is the model doing right now." Deduped on `(phase, turnId,
toolUseId)`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'stream_phase'` | |
| `turnId` | `string \| null` | |
| `phase` | `StreamPhase` | `'idle' \| 'requesting' \| 'thinking' \| 'responding' \| 'tool-input' \| 'tool-use' \| 'awaiting-tool'`. |
| `toolName?` | `string` | When the phase is tool-related. |
| `toolUseId?` | `string` | |

The proxy adapter derives the fine-grained phase from
`response.output_item` transitions; the screen fallback publishes a
coarse `thinking` / `idle` only.

##### Lifecycle violation (diagnostic, not on `event`)

**`lifecycle_violation`** → `SemanticLifecycleViolationEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'lifecycle_violation'` | |
| `kind` | `'start_while_active' \| 'delta_mismatched_turn' \| 'finish_mismatched_turn'` | |
| `attemptedTurnId` | `string` | |
| `activeTurnId` | `string \| null` | |
| `source` | `SemanticSource` | |

Carries `ts` but no `confidence`. Deliberately excluded from the
catch-all `'event'` union.

### 4.2 `ScreenChannel` (`CodexScreenChannel`)

`src/channels/ScreenChannel.ts`. "What the TUI is painting right now."
Visual truth — snapshots, activity, and the two interactive overlays.

Events — `ScreenChannelEvents` (catch-all `'event'` carries
`ScreenEvent`, alias `CodexChannelScreenEvent`):

**`snapshot`** → `ScreenSnapshotEvent` (alias `CodexScreenSnapshotEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'snapshot'` | |
| `plain` | `string` | Viewport plain text. |
| `markdown` | `string` | Viewport with markdown emphasis. |
| `ts` | `number` | |

**`activity`** → `ScreenActivityEvent` (alias `CodexScreenActivityEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'activity'` | |
| `active` | `boolean` | True while the Working row is up. |
| `status` | `string \| null` | Activity verb when `active`, else `null`. |
| `ts` | `number` | |

**`trust_dialog`** → `ScreenTrustDialogEvent`
(alias `CodexChannelTrustDialogEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'trust_dialog'` | |
| `state` | `CodexTrustDialogState` | See §7.3. |
| `ts` | `number` | |

**`approval`** → `ScreenApprovalEvent` (alias `CodexScreenApprovalEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'approval'` | |
| `visible` | `boolean` | |
| `state` | `ScreenApproval \| null` | See §7.2. |
| `ts` | `number` | |

### 4.3 `CommittedChannel` (`CodexCommittedChannel`)

`src/channels/CommittedChannel.ts`. "What the rollout file has
persisted." Every event corresponds to a line already written to a
`rollout-*.jsonl` file — settled history, safe to persist in the app's
feed/log.

`publishLine(line, file)` is called by the orchestrator for every
rollout line. It always emits `rollout_line`, plus one of `session_meta`
/ `response_item` / `turn_committed` depending on the line shape.

Events — `CommittedChannelEvents` (catch-all `'event'` carries
`CommittedEvent`, alias `CodexCommittedEvent`):

**`rollout_line`** → `CommittedRolloutLineEvent`
(alias `CodexCommittedRolloutLineEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'rollout_line'` | |
| `line` | `CodexRolloutLine` | Raw envelope. |
| `file` | `string` | |
| `ts` | `number` | |

**`session_meta`** → `CommittedSessionMetaEvent`
(alias `CodexCommittedSessionMetaEvent`)

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'session_meta'` | |
| `meta` | `CodexSessionMeta` | |
| `file` | `string` | |
| `ts` | `number` | |

**`response_item`** → `CommittedResponseItemEvent`
(alias `CodexCommittedResponseItemEvent`)

Fires for **every** `response_item` line (including messages).

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'response_item'` | |
| `item` | `CodexResponseItem` | |
| `file` | `string` | |
| `ts` | `number` | |

**`turn_committed`** → `CommittedTurnEvent`
(alias `CodexCommittedTurnEvent`)

Fires additionally when a `response_item` is a `message`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_committed'` | |
| `turnId` | `string` | The item's own `id`, or a synthesized `committed-<role>-<timestamp>-<text32>` fingerprint when the item carries no id. |
| `role` | `'user' \| 'assistant' \| 'developer' \| 'system'` | |
| `text` | `string` | Flattened message text (`extractCodexMessageText`). |
| `item` | `CodexMessageItem` | The full message item. |
| `file` | `string` | |
| `ts` | `number` | |

**`error`** → listener args `[Error]`. Emitted via `publishError`,
forwarded from the rollout tailer's read errors. Not part of the
`CommittedEvent` union.

---

## 5. `HeadlessTerminal`

`src/terminal/HeadlessTerminal.ts`. Extends `EventEmitter`. Wraps
`@xterm/headless` around a consumer-owned PTY. The foundation
primitive; `CodexHeadless` builds on it. Identical to the
`claude-code-headless` `HeadlessTerminal` — it is provider-agnostic
and usable standalone.

### 5.1 Options — `HeadlessTerminalOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `pty` | `IPty` | — (required) | PTY to mirror. Consumer owns its lifecycle. |
| `cols` | `number` | `120` | Terminal columns. |
| `rows` | `number` | `40` | Terminal rows. |
| `snapshotIntervalMs` | `number` | `16` | Throttle interval (ms) for `screen` events. |

### 5.2 Lifecycle

The constructor is **inert** — it builds the xterm but does not
subscribe to PTY events. Call `attach()` after wiring anything that
depends on PTY data (tailers, recorders). `attach()` is idempotent.
`CodexHeadless.start()` calls `attach()` for you.

### 5.3 Methods

| Method | Signature | Description |
| --- | --- | --- |
| `attach()` | `(): void` | Subscribe to PTY events; start mirroring. Idempotent. |
| `write(data)` | `(string): void` | Write raw bytes to the PTY. |
| `resize(cols, rows)` | `(number, number): void` | Resize PTY + xterm in lockstep. Swallows node-pty errors on 0/negative dims. |
| `snapshotPlain()` | `(): string` | Visible viewport as plain text. Source of truth for "current screen" parsers. |
| `snapshotMarkdown()` | `(): string` | Viewport with bold/italic reconstructed as markdown. |
| `snapshotRecent(rows?)` | `(rows = 200): string` | Last `rows` lines (viewport + recent scrollback) as plain text. For streaming extractors that walk past the viewport. |
| `snapshotRecentMarkdown(rows?)` | `(rows = 200): string` | Markdown counterpart of `snapshotRecent`. |
| `snapshotFullBuffer()` | `(): string` | Entire xterm buffer (all scrollback) as plain text. For recording/archival. |
| `getTerminal()` | `(): Terminal` | Direct read-only access to the `@xterm/headless` Terminal — for cell-level reads. |
| `isExited()` | `(): boolean` | True if the PTY has exited. |
| `dispose()` | `(): void` | Detach PTY listeners, clear timers. Does NOT kill the PTY. |

### 5.4 `ScreenSnapshot`

The payload of the `screen` event and the `recent` / `recentMarkdown`
inputs to streaming extractors.

| Field | Type | Description |
| --- | --- | --- |
| `plain` | `string` | Visible viewport, plain text. "What is Codex showing right now?" Source for current-screen parsers. |
| `markdown` | `string` | Same viewport, bold/italic reconstructed as markdown. |
| `recent` | `string` | Wider window (last ~200 rows incl. scrollback). For extractors that must scroll past the viewport — `extractCodexAssistantInProgress` on tall replies. |
| `recentMarkdown` | `string` | Markdown counterpart of `recent`. |

### 5.5 Events — `HeadlessTerminalEvents`

| Event | Args | Description |
| --- | --- | --- |
| `pty-data` | `[string]` | Raw PTY bytes received. For recording/fidelity. |
| `screen` | `[ScreenSnapshot]` | Throttled dual snapshot of the viewport. |
| `exit` | `[{ exitCode: number; signal?: number }]` | PTY child exited. |

### 5.6 `terminalToMarkdown`

```ts
terminalToMarkdown(
  term: Terminal,
  opts?: { fullBuffer?: boolean; recentRows?: number },
): string
```

Pure function. Walks a Terminal's active buffer and reconstructs
markdown from cell SGR attributes: bold cells get `**wrapped**`,
italic `*wrapped*`, both `***wrapped***`. Agents render markdown as
ANSI via chalk; by the time it reaches the terminal `**bold**` is gone,
replaced by SGR attributes — this reads them back.

Windowing modes (mutually exclusive, checked in order):

- `fullBuffer: true` — walk every row including all scrollback.
- `recentRows: N` — walk the last `N` rows from the buffer bottom.
- default — viewport only (visible rows).

---

## 6. Conditions

`src/conditions/`. A **Codex-specific** subsystem with no equivalent
in `claude-code-headless`. It turns screen-detected interactive states
into a typed "what is blocking the session right now, and what
keystrokes answer it" snapshot — so a consumer can drive approvals
without re-implementing TUI parsing or hardcoding keystrokes.

`CodexHeadless` re-evaluates conditions on every screen frame (plus
when `exec_approval_request` / `exec_command_end` rollout events
update the approval metadata) and emits a `conditions` event / a
`{ type: 'conditions' }` flat event whenever the snapshot's JSON key
changes. `getConditionSnapshot()` returns the current snapshot
synchronously.

### 6.1 The snapshot — `CodexConditionSnapshot`

```ts
type CodexConditionSnapshot = {
  provider: 'codex'
  conditions: CodexConditionMap
  ts: number
}
```

`CodexConditionMap` is a partial map keyed by condition kind:

```ts
type CodexConditionMap = Partial<{
  [K in CodexConditionKind]: Extract<CodexCondition, { kind: K }>
}>
```

`CodexConditionKind` = `'codex.trust-dialog' | 'codex.approval' |
'codex.switch-model-prompt'`.

A snapshot with an empty `conditions` map means nothing is currently
blocking. A condition's presence means that interactive state is
on-screen.

### 6.2 Condition variants — `CodexCondition`

`CodexCondition` is the union of the three variants. Every variant has
`{ kind, state, actions }`.

**`CodexTrustDialogCondition`** — `kind: 'codex.trust-dialog'`

| Field | Type | Description |
| --- | --- | --- |
| `state` | `CodexTrustDialogState` | The parsed trust dialog (§7.3). |
| `actions` | `ConditionAction[]` | `accept` (Trust folder, writes `'\r'`), `reject` (Quit, writes `'2\r'`). |

**`CodexApprovalCondition`** — `kind: 'codex.approval'`

| Field | Type | Description |
| --- | --- | --- |
| `state` | `CodexApprovalState` | The parsed approval overlay (§7.2) merged with rollout-sourced metadata: `callId`, `commandParts`, `workdir`. |
| `actions` | `ConditionAction[]` | `approve` (writes `'\r'`), `approve-always` (writes `'p'`), `deny` (writes `'\x1b'`). |

`CodexApprovalState` = `ScreenApproval` plus optional `callId?: string
\| null`, `commandParts?: string[]`, `workdir?: string \| null`. When
the approval overlay is detected on-screen but no rollout metadata
arrived, the screen-parsed state is used directly; when only the
rollout `exec_approval_request` metadata arrived (overlay not yet
painted), a synthetic state with the canonical title is built.

**`CodexSwitchModelPromptCondition`** — `kind: 'codex.switch-model-prompt'`

| Field | Type | Description |
| --- | --- | --- |
| `state` | `{ visible: true; message: string; selectedIndex?: number; options?: string[] }` | The model-switch prompt. |
| `actions` | `ConditionAction[]` | |

> **Hedge:** the `codex.switch-model-prompt` *type* is exported and is
> part of the `CodexCondition` union, but the bundled evaluator
> (`evaluateCodexConditions`, §6.4) only ever populates
> `codex.trust-dialog` and `codex.approval`. There is no builder for
> the model-switch prompt in the current source. The type exists for
> consumers that detect that prompt themselves and inject the
> condition; the orchestrator will not emit it on its own.

### 6.3 Actions — `ConditionAction`

Re-exported from the package root as `CodexConditionAction` etc.

```ts
type ConditionPtyAction = {
  kind: 'pty'; id: string; label: string; data: string
}
type ConditionCustomAction = {
  kind: 'custom'; id: string; label: string; name: string
}
type ConditionAction = ConditionPtyAction | ConditionCustomAction
```

| Type | Alias at package root | Meaning |
| --- | --- | --- |
| `ConditionAction` | `CodexConditionAction` | Either variant below. |
| `ConditionPtyAction` | `CodexConditionPtyAction` | `data` is raw bytes — write them to the PTY (`codex.write(action.data)`) to perform the action. |
| `ConditionCustomAction` | `CodexConditionCustomAction` | `name` is an app-defined action identifier — the consumer decides what it does. The bundled builders only emit `pty` actions. |

To answer a condition: pick the `ConditionAction` whose `id` matches
the intent (`'approve'`, `'deny'`, `'accept'`, …), and if it is a
`pty` action write `action.data` to the PTY.

### 6.4 The evaluator

Exported from `src/conditions/index.ts` (and re-exported at the
package root only as the *types* — the functions below are exported
from the `conditions` module but **not** re-exported through
`src/index.ts`; they are used internally by `CodexHeadless`. The
consumer-facing surface is `getConditionSnapshot()` / the `conditions`
event):

```ts
type CodexConditionInputs = {
  trustDialog: CodexTrustDialogState
  approval: ScreenApproval | null
  approvalMetadata?: CodexApprovalMetadata | null
}

function evaluateCodexConditions(inputs: CodexConditionInputs): CodexConditionSnapshot
function codexConditionSnapshotKey(snapshot: CodexConditionSnapshot): string
function buildCodexTrustDialogCondition(state: CodexTrustDialogState): CodexTrustDialogCondition | null
function buildCodexApprovalCondition(state: ScreenApproval | null, metadata: CodexApprovalMetadata | null): CodexApprovalCondition | null
```

- `evaluateCodexConditions` builds the snapshot: runs each builder,
  drops `null` results, returns `{ provider: 'codex', conditions, ts }`.
- `codexConditionSnapshotKey` is `JSON.stringify(snapshot.conditions)`
  — the dedupe key the orchestrator uses to decide whether to re-emit.
- `CodexApprovalMetadata` = `{ callId: string | null; commandParts:
  string[]; workdir: string | null }`. Sourced from rollout
  `exec_approval_request` events.

### 6.5 Consuming conditions — pattern

```ts
codex.on('conditions', snapshot => {
  const approval = snapshot.conditions['codex.approval']
  if (approval) {
    // A command is waiting for approval. Decide policy:
    const cmd = approval.state.command            // "git status --short"
    const action = isSafe(cmd)
      ? approval.actions.find(a => a.id === 'approve')
      : approval.actions.find(a => a.id === 'deny')
    if (action && action.kind === 'pty') codex.write(action.data)
  }

  const trust = snapshot.conditions['codex.trust-dialog']
  if (trust) {
    const accept = trust.actions.find(a => a.id === 'accept')
    if (accept && accept.kind === 'pty') codex.write(accept.data)
  }
})
```

---

## 7. Parsers

`src/parsers/`. Pure functions — no Node, no DOM, no IO. They are
heuristics tuned against recorded Codex TUI fixtures; a future Codex
CLI release can change layout. Importable standalone without an
orchestrator.

### 7.1 Screen structure — `ScreenParser.ts`

Codex's TUI markers (confirmed from recordings): `›` user prompt
prefix, `•`/`◦` assistant text + tool calls + working indicator, `└`
tool-output sub-item, `│` tool-output continuation, `──────` divider.

| Symbol | Signature | Detects / does |
| --- | --- | --- |
| `isCodexDividerLine(line)` | `(string) => boolean` | A horizontal-rule line (≥10 `─`/`━`/`═`/`▔` chars, ≥80 % of non-space content). |
| `isCodexPromptLine(line)` | `(string) => boolean` | The empty composer indicator: `›` then whitespace only (optional markdown emphasis wrappers tolerated). |
| `isCodexUserPromptLine(line)` | `(string) => boolean` | `›` followed by text — a user prompt echo or composer with placeholder. Used as a stop-terminator when extracting the assistant block. |
| `isCodexStatusLine(line)` | `(string) => boolean` | The persistent bottom status row — matched by substrings `gpt-`, `context left`, `tab to queue`, `/model to change`. |
| `isCodexChromeLine(line)` | `(string) => boolean` | Any persistent UI furniture: blank, divider, prompt line, status line, or box-drawing-only. |
| `isCodexIntermediateChromeLine(line)` | `(string) => boolean` | Mid-turn tool/thinking decorations: tree markers (`│`/`└`), Braille spinner lines, `esc to interrupt` working rows, and `• <verb>` tool-call labels (`Ran`, `Explored`, `Edited`, `Called`, `Calling`, `Spawned`, `Closed`, `Updated Plan`, `Finished waiting`, `Booting MCP`). |
| `detectCodexWorkingState(screen)` | `(string) => CodexWorkingState` | Scans the last ~12 lines for `• Working (Ns • esc to interrupt)`. Returns `{ active, statusText?, elapsedText? }`. |
| `detectCodexActivity(screen)` | `(string) => string \| null` | The activity verb (e.g. `"working… 10s"`) when the Working row is up, else `null`. Built on `detectCodexWorkingState`. |
| `extractCodexStreamingText(screen)` | `(string) => string` | Everything Codex rendered except the persistent bottom input box + status row. Returns `''` when the trust dialog, resume picker, or approval overlay is on-screen. Low-level primitive. |
| `extractCodexAssistantInProgress(screen)` | `(string) => string` | Just the most-recent in-progress assistant text block. Composes on `extractCodexStreamingText`, filters intermediate chrome, walks to the last `•` marker, slices to the next `›` user-prompt line, strips the marker. `''` when no assistant marker is visible (caller should show a "thinking…" placeholder). If chrome filtering removed every `•` line, falls back to the current activity string. |

`CodexWorkingState` = `{ active: boolean; statusText?: string;
elapsedText?: string }`.

### 7.2 Command-approval overlay — `ApprovalParser.ts`

```ts
detectCodexApproval(screen: string): ScreenApproval | null
isApprovalOverlayVisible(screen: string): boolean
```

Detects Codex's bottom-pane command-approval modal. The overlay is
recognized by matching one of the known title strings:

- `Would you like to run the following command?`
- `Would you like to make the following edits?`
- `Would you like to grant these permissions?`
- `Do you want to approve network access`

`detectCodexApproval` returns the full parsed state, or `null` when no
title matches. `isApprovalOverlayVisible` is the lighter check — just
title matching, returns `boolean`.

`ScreenApproval`:

| Field | Type | Description |
| --- | --- | --- |
| `title` | `string` | The matched overlay title. |
| `reason` | `string \| null` | Parsed from a `Reason: <text>` line after the title. |
| `command` | `string \| null` | Parsed from a `$ <command>` line. |
| `options` | `string[]` | Option labels (the `N.` prefix and trailing `(key)` hint stripped). |
| `selectedIndex` | `number` | 0-indexed option under the `›` marker. |

### 7.3 Trust dialog — `TrustDialogParser.ts`

```ts
detectCodexTrustDialog(screen: string): CodexTrustDialogState
```

Detects Codex's first-launch-in-a-new-directory trust dialog. **All**
required markers must be present (conservative — avoids
false-positiving on assistant text that mentions "trust"):
`Do you trust the contents of this directory`, `Yes, continue`,
`No, quit`.

`CodexTrustDialogState`:

| Field | Type | Description |
| --- | --- | --- |
| `visible` | `boolean` | |
| `workspace?` | `string` | The directory Codex asks to trust, parsed from a `> You are in <path>` line. |
| `options?` | `Array<{ key: string; label: string }>` | The two options, hardcoded `{ '1', 'Yes, continue' }` / `{ '2', 'No, quit' }`. |

`CODEX_TRUST_DIALOG_ACCEPT_KEYS` = `'\r'` — confirms the pre-selected
"Yes, continue". (Reject is `'2\r'`, not exported as a constant —
see the trust-dialog condition's `reject` action.)

### 7.4 Line diff — `LineDiff.ts`

```ts
diffLines(oldText: string, newText: string): DiffLine[]
```

Line-level LCS diff (O(m×n) DP). For rendering Edit-tool output.
Returns a flat sequence in display order. Removed lines appear at their
`oldText` position, added lines at their `newText` position, context
lines once. Trailing empty lines are dropped (a file ending in `\n`
does not produce a phantom final blank).

`DiffLine` = `{ kind: 'ctx' | '-' | '+'; text: string }` — `ctx` =
unchanged context, `-` = removed, `+` = added.

---

## 8. Transcript

`src/transcript/`. Reading Codex's "rollout" JSONL transcript files.
Unlike Claude's per-cwd directory, Codex stores **all** sessions in a
single date-bucketed tree:

```
~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
```

### 8.1 Session directory — `ProjectDir.ts`

```ts
getCodexHome(): string
getCodexSessionsDir(): string
```

- `getCodexHome()` — resolves Codex's config home. Honors `$CODEX_HOME`
  if set and non-empty; otherwise `~/.codex`. The result is
  NFC-normalized.
- `getCodexSessionsDir()` — `join(getCodexHome(), 'sessions')`. The
  root of the date-bucketed tree.

### 8.2 Rollout envelope + item types — `TranscriptTypes.ts`

The on-disk format is one JSON object per line:

```ts
type CodexRolloutLine = {
  timestamp: string   // ISO 8601
  type: string        // serde tag — "session_meta" | "turn_context" |
                      // "compacted" | "response_item" | "event_msg" | …
  payload: unknown    // shape depends on `type` (and on payload.type)
}
```

`type` is the outer serde tag; for `response_item` and `event_msg`
lines, `payload.type` discriminates further. **Use the type guards
(§8.4) at runtime — do not trust the discriminator alone.** Pure
types only.

#### RolloutItem variants

**`CodexSessionMeta`** (`type: 'session_meta'`) — the first line of a
rollout file.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The session/thread UUID. |
| `timestamp` | `string` | |
| `cwd` | `string` | Working directory the session was created in. |
| `originator` | `string` | `"codex-tui"` \| `"codex"`. |
| `cli_version` | `string` | |
| `source` | `string` | `"cli"` \| `"app_server"`. |
| `model_provider?` | `string` | `"openai"`. |
| `agent_nickname?`, `agent_role?`, `agent_path?` | `string` | |
| `base_instructions?` | `{ text: string }` | |
| `forked_from_id?` | `string` | |
| `memory_mode?` | `string` | |
| `dynamic_tools?` | `unknown` | |
| `git?` | `{ branch?; commit?; dirty? }` | |

**`CodexTurnContext`** (`type: 'turn_context'`)

| Field | Type |
| --- | --- |
| `turn_id` | `string` |
| `cwd` | `string` |
| `current_date` | `string` |
| `timezone` | `string` |
| `approval_policy` | `string` (`"on-request"` \| `"auto-approve"` \| …) |
| `sandbox_policy` | `{ type: string; writable_roots: string[]; network_access: boolean }` |

**`CodexCompactedItem`** (`type: 'compacted'`)

| Field | Type |
| --- | --- |
| `message` | `string` |
| `replacement_history?` | `CodexResponseItem[]` |

#### ResponseItem variants (`type: 'response_item'`)

`CodexResponseItem` is the union of the variants below, plus
`CodexOtherItem` as the catch-all. `payload.type` discriminates.

| Type | `payload.type` | Key fields |
| --- | --- | --- |
| `CodexMessageItem` | `'message'` | `id?`, `role` (`"user"`\|`"assistant"`\|`"developer"`\|`"system"`), `content: CodexContentItem[]`, `end_turn?`, `phase?`. |
| `CodexFunctionCallItem` | `'function_call'` | `name`, `namespace?`, `arguments` (JSON string), `call_id`. |
| `CodexFunctionCallOutputItem` | `'function_call_output'` | `call_id`, `output` (`string \| CodexFunctionCallOutputContent[]`). |
| `CodexLocalShellCallItem` | `'local_shell_call'` | `call_id?`, `status`, `action: { type; cmd?; workdir?; timeout_seconds? }`. |
| `CodexReasoningItem` | `'reasoning'` | `id?`, `summary: Array<{ type; text }>`, `content?`, `encrypted_content?`. |
| `CodexCustomToolCallItem` | `'custom_tool_call'` | `call_id`, `name`, `input` (JSON string), `status?`. |
| `CodexCustomToolCallOutputItem` | `'custom_tool_call_output'` | `call_id`, `name?`, `output`. |
| `CodexWebSearchCallItem` | `'web_search_call'` | `status?`, `action?: { type; query }`. |
| `CodexOtherItem` | any other | `{ type: string; [k: string]: unknown }`. |

`CodexContentItem` (the entries of `CodexMessageItem.content`) is one
of `{ type: 'input_text'; text }`, `{ type: 'output_text'; text;
annotations? }`, `{ type: 'refusal'; refusal }`, or an open
`{ type: string; [k: string]: unknown }`.

`CodexFunctionCallOutputContent` = `{ type: string; text?: string;
[k: string]: unknown }`.

#### EventMsg variants (`type: 'event_msg'`)

`CodexEventMsg` is the union of the variants below, plus
`CodexGenericEvent` (`{ type: string; [k: string]: unknown }`) as the
catch-all. `payload.type` discriminates.

| Type | `payload.type` | Key fields |
| --- | --- | --- |
| `CodexTurnStartedEvent` | `'task_started'` \| `'turn_started'` | `turn_id`, `started_at`, `model_context_window?`, `collaboration_mode_kind?`. |
| `CodexTurnCompleteEvent` | `'task_complete'` \| `'turn_complete'` | `turn_id`. |
| `CodexTurnAbortedEvent` | `'turn_aborted'` | `turn_id`, `reason?`, `completed_at?`, `duration_ms?`. |
| `CodexUserMessageEvent` | `'user_message'` | `message?`, `kind?`, `text_elements?`, `local_images?`. |
| `CodexAgentMessageEvent` | `'agent_message'` | `message?` — final assistant-text snapshot. |
| `CodexAgentMessageDeltaEvent` | `'agent_message_delta'` | `delta?` — the live streaming delta. |
| `CodexTokenCountEvent` | `'token_count'` | `input_tokens?`, `output_tokens?`, `total_tokens?`. |
| `CodexExecCommandBeginEvent` | `'exec_command_begin'` | `call_id?`, `command?: string[]`, `workdir?`. |
| `CodexExecCommandEndEvent` | `'exec_command_end'` | `call_id?`, `exit_code?`. |
| `CodexExecCommandOutputDeltaEvent` | `'exec_command_output_delta'` | `call_id?`, `delta?`. |
| `CodexExecApprovalRequestEvent` | `'exec_approval_request'` | `call_id?`, `command?: string[]`, `workdir?` — feeds the approval condition's metadata. |
| `CodexMcpToolCallBeginEvent` | `'mcp_tool_call_begin'` | `call_id?`, `server_name?`, `tool_name?`. |
| `CodexMcpToolCallEndEvent` | `'mcp_tool_call_end'` | `call_id?`, `server_name?`, `tool_name?`. |
| `CodexErrorEvent` | `'error'` | `message`, `code?`. |
| `CodexGenericEvent` | any other | open catch-all. |

> **Note:** `CodexTurnAbortedEvent` is *not* re-exported through
> `src/index.ts` (it is consumed internally by the orchestrator and
> declared in `TranscriptTypes.ts`). Every other `CodexEventMsg`
> variant in the table — except `CodexGenericEvent` — is exported.
> `CodexCustomToolCallItem`/`CodexCustomToolCallOutputItem` are
> exported; the helper content type `CodexFunctionCallOutputContent`
> is not.

#### How rollout `event_msg` deltas map to the semantic channel

`CodexHeadless.ingestRolloutIntoSemantic` translates `event_msg`
payloads onto the semantic channel:

| `event_msg` type | Semantic effect |
| --- | --- |
| `task_started` / `turn_started` | `startTurn` (`source: 'rollout'`, `confidence: 'high'`). |
| `agent_message_delta` | `applyDelta` with accumulated `fullText`. |
| `agent_message` | `applyDelta` with the final snapshot text. |
| `task_complete` / `turn_complete` | `finishTurn`. |
| `turn_aborted` | `publishTurnStopped` + `finishTurn`. |
| `exec_approval_request` | updates `approvalMetadata`, re-evaluates conditions. |
| `exec_command_begin` / `_output_delta` / `_end` | `toolStarted` / `toolOutputDelta` / `toolCompleted` (`tool: 'exec'`). |
| `mcp_tool_call_begin` / `_end` | `toolStarted` / `toolCompleted` (`tool: 'mcp'`). |
| other | ignored on the semantic channel. |

Additionally, a committed `response_item` of `role: 'assistant'` acts
as a belt-and-braces fallback: if a short reply skipped deltas, the
message text still lands on the semantic channel with `confidence:
'medium'`.

### 8.3 Type guards + helpers — `TranscriptTypes.ts`

| Function | Signature | Description |
| --- | --- | --- |
| `isCodexConversationEntry` | `(line: CodexRolloutLine) => boolean` | True when `line.type` is `'response_item'` or `'event_msg'`. |
| `isCodexResponseItem` | `(line) => line is CodexRolloutLine & { payload: CodexResponseItem }` | Narrows on `line.type === 'response_item'`. |
| `isCodexEventMsg` | `(line) => line is CodexRolloutLine & { payload: CodexEventMsg }` | Narrows on `line.type === 'event_msg'`. |
| `isCodexSessionMeta` | `(line) => line is CodexRolloutLine & { payload: CodexSessionMeta }` | Narrows on `line.type === 'session_meta'`. |
| `extractCodexMessageText` | `(item: CodexMessageItem) => string` | Flattens a message's `content` array — joins the `text` of `input_text` / `output_text` items with `\n`. |
| `parseCodexFunctionArgs` | `(args: string) => Record<string, unknown>` | `JSON.parse` of a function-call `arguments` string; returns `{}` on parse failure. |

### 8.4 Session discovery — `SessionList.ts`

```ts
listCodexSessions(options?: {
  limit?: number
  cwd?: string
}): Promise<CodexSessionInfo[]>
```

Walks `~/.codex/sessions/` recursively (the date tree), reads the HEAD
of each `rollout-*.jsonl` (bounded to 80 decoded lines per file),
extracts summary metadata, and returns sessions **newest first**.

- `limit` — max results. Default `20`.
- `cwd` — when set, only sessions whose recorded `session_meta.cwd`
  matches (after `path.resolve` normalization on both sides) are
  returned. Required for a per-cwd resume picker — without it the
  result mixes every project Codex was ever used in. Sessions whose
  `session_meta` could not be decoded are dropped under cwd filtering.
  (The options type `ListCodexSessionsOptions` exists in the source
  but is not re-exported through `src/index.ts` — pass an inline
  object literal.)

`CodexSessionInfo`:

| Field | Type | Description |
| --- | --- | --- |
| `sessionId` | `string` | The UUID parsed from the rollout filename. Pass this to `codex resume <id>`. |
| `summary` | `string` | The first user prompt (cleaned of `<user_input>` / `USER_MESSAGE_BEGIN/END` framing), truncated to 200 chars; falls back to the first 8 chars of `sessionId`. |
| `lastModified` | `number` | File mtime (epoch ms). |
| `fileSize` | `number` | Rollout file size in bytes. |
| `cwd?` | `string` | From `session_meta.cwd`. |
| `gitBranch?` | `string` | From `session_meta.git.branch`. |
| `createdAt?` | `number` | Parsed from `session_meta.timestamp`. |

### 8.5 Tailer — `JsonlTailer.ts`

The rollout tailer is an **internal** module — `CodexHeadless.start()`
uses `tailSessionFile` to tail the rollout file. Its functions
(`tailSessionFile`, `tailNewSessionFile`) and the `JsonlEntry` type
are **not** re-exported through `src/index.ts`. They are documented
here only for completeness:

- The tailer uses `fs.watchFile` poll-based detection (100 ms
  interval) — reliable on every fs/OS combination, unlike `fs.watch`
  which silently misses rapid appends.
- Reads are strictly serialized via a "queue at most one re-entry"
  flag pair, so overlapping writes never produce duplicate emits.
- On the resume path the tailer bootstraps from the last 200 lines
  (`bootstrapTailLines: 200`, bounded to 512 KiB of file tail).

---

## 9. Proxy — live streaming

The proxy surface is **additive**. Without it, `CodexHeadless` is
fully functional on `rollout` + `screen` sources. With it, the
semantic channel gains a `source: 'proxy'` stream that fills the live
turn instantly — the proxy sees response bytes as they come back from
the server, whereas the rollout file is written after the fact.

Codex's proxy is structurally different from
`claude-code-headless`'s. It is a **plain HTTP forwarding server**, not
a mitmproxy TLS interceptor. OpenAI/ChatGPT natively support a custom
`openai_base_url`, so you simply point Codex's `openai_base_url`
config override at the local proxy and it forwards every `/v1/*`
request to the real upstream — no CA injection, no TLS gymnastics.

### 9.1 `ResponsesProxy`

`src/proxy/responsesProxy.ts`. Extends `EventEmitter`. A local HTTP
server bound to `127.0.0.1` on an ephemeral port.

#### Construction

`ResponsesProxy` is created via the static async factory, not `new`:

```ts
static ResponsesProxy.create(options?: {
  upstreamBaseUrl?: string
  authMode?: CodexAuthMode
  eventsFile?: string
}): Promise<ResponsesProxy>
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `authMode` | `CodexAuthMode` (`'apikey' \| 'chatgpt'`) | auto-detected | Which auth path Codex uses. Auto-detection reads `~/.codex/auth.json`; absent → `'apikey'`. |
| `upstreamBaseUrl` | `string` | derived from `authMode` | The real upstream. Defaults: `apikey` → `https://api.openai.com/v1`, `chatgpt` → `https://chatgpt.com/backend-api/codex`. |
| `eventsFile` | `string` | unset | If set, every emitted `event` is also appended as a JSON line to this file (forensic mirror; `Buffer` payloads are inlined as `{ _buffer_b64 }`). Append-only; rotation is the caller's problem. |

`create()` starts listening before resolving. The resolved instance
exposes:

```ts
readonly info: CodexResponsesProxyInfo
```

```ts
type CodexResponsesProxyInfo = {
  proxyBaseUrl: string      // "http://127.0.0.1:<port>/v1" — point
                            // Codex's openai_base_url at this
  upstreamBaseUrl: string
  authMode: CodexAuthMode
}
```

#### Why auth mode matters

Codex resolves a different default upstream depending on auth path
(`api.openai.com` for API-key, `chatgpt.com/backend-api/codex` for
ChatGPT). The `openai_base_url` override replaces the URL for **both**
modes with the same proxy URL — so the proxy itself must know which
real upstream to forward to, or a ChatGPT-mode user's JWT gets sent to
`api.openai.com` and 401s.

#### Forwarding behavior

- Every path under `/v1/` (or bare paths, if Codex was pointed at a
  base without `/v1`) is forwarded transparently to
  `{upstreamBaseUrl}/{relative}{?query}`. The proxy passes Codex's own
  `Authorization` header through untouched — it does not inject auth.
- The hot SSE path (`/responses`) uses a 30 s headers timeout; unary
  JSON endpoints (`/responses/compact`, `/memories/trace_summarize`,
  …) use a 5 min headers timeout (slow-but-valid compaction must not
  synthesize a local 502).
- WebSocket upgrade attempts are rejected with HTTP `426 Upgrade
  Required` — the exact handshake Codex needs to fall back to SSE
  POST. The proxy does not bridge WS.
- Root probes / `/favicon` / `/v1` itself are rejected with `404`.

#### Events — `CodexResponsesProxyEvents`

`ResponsesProxy` emits a single event name, `'event'`, carrying a
`Record<string, unknown>`. The shape is discriminated by a `kind`
field:

| `kind` | Key fields | Meaning |
| --- | --- | --- |
| `request` | `requestId`, `endpoint`, `method`, `path`, `upstream`, `bytes?`, `headers`, `body_b64?`, `request_shape?` | An inbound request was forwarded. `endpoint` is one of `responses`, `responses/compact`, `memories/trace_summarize`, `realtime/calls`, `models`, `unknown`. `headers` is an allowlist (no `Authorization`). `body_b64` present when body ≤ 2 MiB. |
| `response` | `requestId`, `path`, `status` | Upstream response headers received. |
| `response-chunk` | `requestId`, `path`, `size`, `chunk: Buffer` | A raw SSE/JSON byte chunk from upstream. |
| `response-end` | `requestId`, `path`, `bytes` | Upstream stream ended cleanly. |
| `response-error` | `requestId`, `path`, `message` | The response stream errored. |
| `upstream-error` | `requestId`, `endpoint`, `path`, `message` | The `fetch` to upstream failed (timeout, DNS, …). |
| `request-error` | `requestId`, `endpoint`, `path`, `message` | The client disconnected mid-upload. |
| `upgrade-rejected` | `path` | A WS upgrade attempt was refused with 426. |
| `rejected` | `method`, `path` | A non-API path was 404'd. |
| `server-error` | `message` | The HTTP server emitted an `error`. |

`requestId` is an opaque monotonic `req-N` tag stamped on every
event for one HTTP call — so overlapping retries to the same path
never get their bytes merged.

#### Methods

| Method | Signature | Description |
| --- | --- | --- |
| `ResponsesProxy.create` | `(options?) => Promise<ResponsesProxy>` | Static factory. Starts listening. |
| `stop()` | `(): Promise<void>` | Force-closes every in-flight socket (so a live SSE turn does not stall teardown for minutes), then closes the server. |

### 9.2 `CodexResponsesAdapter`

`src/proxy/CodexResponsesAdapter.ts`. Consumes the raw `response-chunk`
events from a `ResponsesProxy`, parses OpenAI Responses-API SSE
frames, and publishes block-structured semantic events onto a
`CodexHeadless` instance's `semantic` channel with `source: 'proxy'`.

```ts
class CodexResponsesAdapter {
  constructor(proxy: ResponsesProxy, headless: CodexHeadless)
  attach(): void
  detach(): void
}
```

- `attach()` — subscribes to the proxy's `event` stream and arms a
  watchdog timer. Idempotent.
- `detach()` — unsubscribes, clears the watchdog, drops all in-flight
  flow bookkeeping.

#### What it does

- Filters to the `/responses` endpoint only — `/responses/compact`,
  `/memories/trace_summarize`, `/realtime/calls`, `/models` and
  unknown `/v1/` paths are skipped (they are not the live turn).
- Tracks one **flow** per HTTP request (keyed by `requestId`). The
  **first flow to produce a chunk wins** the right to publish onto the
  shared `semantic` channel ("active"); concurrent flows (retries,
  warmups) are marked "secondary" and parsed but never published —
  this prevents the historical 0/1/0/1 block flicker. Selection
  decisions surface as `flow_selected` / `flow_ignored` events.
- Parses SSE frames and maps Responses-API events onto the semantic
  channel:

| Responses-API SSE event | Semantic effect |
| --- | --- |
| `response.created` / `response.in_progress` | `startTurn` with `response.id` as `turnId`; phase → `requesting`. |
| `response.output_item.added` | `publishBlockStarted`; phase → `responding` / `thinking` / `tool-input` per kind. |
| `response.output_text.delta` | `applyDelta` (turn-level) + `publishTextDelta` (per-block). |
| `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` | `publishThinkingDelta` (track `full` / `summary`). |
| `response.output_item.done` | `publishBlockCompleted` with variant-specific fields. |
| `response.completed` | `publishUsageUpdated` (if usage present) + `finishTurn`; phase → `awaiting-tool` (if pending tool calls) or `idle`. |
| `response.failed` | `publishApiError` (classified) + `finishTurn`; phase → `idle`. |
| `response.incomplete` | `publishTurnStopped` + `finishTurn`; phase → `idle`. |
| malformed `data:` frame | `publishStreamError` (soft — turn continues). |

- A **watchdog** sweeps every 10 s and releases any flow silent for
  more than 60 s — sealing its turn with `confidence: 'fallback'` and
  freeing the active slot so subsequent turns are not starved.
- The decoder is incremental (`StringDecoder`) so a multi-byte
  codepoint split across HTTP chunk boundaries is never corrupted, and
  CRLF line endings are normalized to LF before SSE frame splitting.

When both proxy and rollout drive the same turn, the
`SemanticChannel`'s `source_changed` event signals the handoff —
reconcile by text + timing, not id equality.

---

## 10. Recipes

### 10.1 Plain (rollout-only) session

```ts
import { spawn } from 'node-pty'
import { CodexHeadless } from 'codex-headless'

const pty = spawn('codex', [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env: process.env })
const codex = new CodexHeadless({ pty, cwd: process.cwd() })

codex.semantic.on('turn_delta', ev => process.stdout.write(ev.textDelta ?? ''))
codex.semantic.on('turn_completed', ev => console.log('\n--- turn done ---'))
codex.committed.on('turn_committed', ev => console.log(`[committed ${ev.role}]`))

await codex.start()
codex.sendPrompt('Summarize the README in two sentences.')
```

### 10.2 Proxy-backed live streaming

```ts
import { spawn } from 'node-pty'
import { CodexHeadless, ResponsesProxy, CodexResponsesAdapter } from 'codex-headless'

// 1. Start the proxy. It auto-detects auth mode from ~/.codex/auth.json.
const proxy = await ResponsesProxy.create()
console.log('proxy listening at', proxy.info.proxyBaseUrl)

// 2. Spawn codex with openai_base_url pointed at the proxy. The exact
//    flag/config mechanism is Codex's; -c sets a config override.
const pty = spawn('codex', [
  '-c', `openai_base_url=${proxy.info.proxyBaseUrl}`,
], { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env: process.env })

const codex = new CodexHeadless({ pty, cwd: process.cwd() })

// 3. Wire the adapter: proxy SSE → codex.semantic (source: 'proxy').
const adapter = new CodexResponsesAdapter(proxy, codex)
adapter.attach()

// 4. Subscribe to the block-level stream — only available with proxy.
codex.semantic.on('block_started', ev => console.log('block', ev.blockIndex, ev.kind))
codex.semantic.on('text_delta', ev => process.stdout.write(ev.textDelta))
codex.semantic.on('thinking_delta', ev => { if (ev.track === 'summary') process.stderr.write(ev.thinkingDelta) })
codex.semantic.on('block_completed', ev => console.log('\n[done]', ev.kind))
codex.semantic.on('usage_updated', ev => console.log('usage', ev.usage))
codex.semantic.on('stream_phase', ev => console.log('phase →', ev.phase))

await codex.start()
codex.sendPrompt('Refactor utils.ts and explain what changed.')

// Teardown:
// adapter.detach(); await proxy.stop(); await codex.stop(); pty.kill()
```

### 10.3 Reading historical rollout transcripts (no spawn)

```ts
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import {
  listCodexSessions, getCodexSessionsDir,
  isCodexResponseItem, isCodexEventMsg, extractCodexMessageText,
  type CodexRolloutLine, type CodexMessageItem,
} from 'codex-headless'

// Discover sessions for the current project, newest first.
const sessions = await listCodexSessions({ cwd: process.cwd(), limit: 10 })
for (const s of sessions) {
  console.log(s.sessionId, '·', s.summary)
}

// Replay one rollout file by hand.
const dir = getCodexSessionsDir()  // ~/.codex/sessions
// (locate the file under dir/YYYY/MM/DD/ by sessionId, then:)
const rl = createInterface({ input: createReadStream(rolloutPath, 'utf8') })
for await (const raw of rl) {
  if (!raw.trim()) continue
  const line = JSON.parse(raw) as CodexRolloutLine
  if (isCodexResponseItem(line) && line.payload.type === 'message') {
    const msg = line.payload as CodexMessageItem
    console.log(`[${msg.role}]`, extractCodexMessageText(msg))
  } else if (isCodexEventMsg(line) && line.payload.type === 'agent_message') {
    console.log('[assistant]', line.payload.message)
  }
}
```

### 10.4 Detecting and answering an approval via conditions

```ts
import { spawn } from 'node-pty'
import { CodexHeadless } from 'codex-headless'

const pty = spawn('codex', [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env: process.env })
const codex = new CodexHeadless({ pty, cwd: process.cwd() })

codex.on('conditions', snapshot => {
  // Command-approval overlay.
  const approval = snapshot.conditions['codex.approval']
  if (approval) {
    const cmd = approval.state.command ?? ''
    console.log('Codex wants to run:', cmd)
    // Auto-approve read-only git, deny everything else.
    const wantId = /^git (status|log|diff)\b/.test(cmd) ? 'approve' : 'deny'
    const action = approval.actions.find(a => a.id === wantId)
    if (action?.kind === 'pty') codex.write(action.data)
  }

  // First-launch trust dialog.
  const trust = snapshot.conditions['codex.trust-dialog']
  if (trust) {
    const accept = trust.actions.find(a => a.id === 'accept')
    if (accept?.kind === 'pty') codex.write(accept.data)
  }
})

await codex.start()
codex.sendPrompt('Run the test suite and report failures.')
```

---

## 11. Legacy vs. channel surface

`CodexHeadless` exposes two overlapping surfaces. They both fire — pick
one per concern.

| Concern | Legacy flat surface | Channel surface |
| --- | --- | --- |
| Live model output | `activity` / `idle` only (coarse) | `semantic` — `turn_*`, `block_*`, `tool_*`, `stream_phase` |
| Terminal mirroring / overlays | `screen`, `trust-dialog`, `approval` | `screen` — `snapshot`, `activity`, `trust_dialog`, `approval` |
| Durable transcript | `rollout-entry` | `committed` — `turn_committed`, `response_item`, `session_meta`, `rollout_line` |
| Interactive blocking state | `trust-dialog`, `approval`, `conditions` | `conditions` event (no dedicated channel) + `screen` overlays |

Guidance:

- **New code** should subscribe to the three channels. They are typed,
  deduplicated, and carry provenance (`source` / `confidence`).
- The **legacy flat events** exist for backward compatibility. The
  `event` catch-all union (`CodexHeadlessEvent`) is convenient for a
  single coarse handler, but note it omits `live-owner-change` and
  carries only the narrow two-field `screen` payload.
- **Conditions** have no channel of their own — consume the
  `conditions` flat event or poll `getConditionSnapshot()`. They are
  derived from screen state (plus rollout approval metadata), so they
  are inherently `fallback`-confidence; treat any destructive
  auto-approval defensively.
- The `semanticShadow` channel is **not** part of the public contract
  for renderers — it exists for debug panels that want to observe
  screen-fallback turns. Production rendering consumes `semantic`
  only.
```
