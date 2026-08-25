# Recorded Codex rollout-ownership corpus

These fixtures are sanitized projections of real Codex rollout files, not
plausible JSON written to fit the claimant. They preserve the facts ownership
uses: session class, CLI version, line order, user-message transport, equality
between duplicated messages, the locally submitted prompt, and the old/new
claim decision.

Raw prompt, bootstrap, path, agent, and thread text is replaced. Every fixture
stores an opaque source label, SHA-256, original line/user counts, original user
line indices, source recording ID when available, and sanitizer version. The
private source files are deliberately not committed.

## Corpus census

Measured on 2026-08-24 by running:

```sh
npx tsx scripts/extract-rollout-ownership-fixtures.mts \
  --manifest <private-manifest.json> --verify \
  --census-root ~/.codex/sessions
```

Only genuine `codex-tui` rows are shown here. Two `0.149.0` files created by
`agent-transcript-parser` still contain `event_msg.user_message`; they are
synthetic parser outputs and are excluded from the upstream wire-shape count.

| CLI | Captured rollouts | With `event_msg.user_message` |
|---|---:|---:|
| 0.130.0 | 142 | 142 |
| 0.132.0 | 406 | 406 |
| 0.145.0 | 58 | 58 |
| 0.147.0 | 17 | 0 |
| 0.149.0 | 27 | 0 |
| 0.149.1 | 2 | 0 |

The corpus establishes that the event was present through `0.145.0` and absent
by `0.147.0`. It does not contain `0.146.x`, so it cannot name a more precise
first breaking release.

## Fixture catalog

| Fixture | Reality represented | Ordered user observations | Old decision | Required decision |
|---|---|---:|---:|---:|
| `legacy-0145-event-user` | Legacy fresh `0.145.0`; actual prompt appears as a response item and `event_msg.user_message` | 3 / 2 equality classes | accept | accept |
| `modern-0147-environment-first` | First captured event-free version; injected startup context precedes the submitted prompt | 2 | hold | accept |
| `modern-0149-large-bootstrap-first` | Failed fresh Agent Code recording `dc734595…`; no committed rollout entries | 7 | hold | accept |
| `modern-0149-agents-first` | Active issue recording `17ee1e36…`; Codex processed prompts while Agent Code recorded zero rollout entries | 8 | hold | accept |
| `concurrent-01491-alpha` | Controlled Agent Code MCP sibling `b50629c3…`, same CWD and launch second as beta | 2 | hold | accept |
| `concurrent-01491-beta` | Controlled Agent Code MCP sibling `8101283c…`, same CWD and launch second as alpha | 2 | hold | accept |
| `subagent-0149-exact-attachment` | Working `0.149.0` subagent recording `1e53c93f…`, attached through exact provider identity rather than the fresh claimant | 4 | n/a | n/a |

The concurrent siblings used distinct submitted prompts. Both prompts were
visible in their own Codex rollout and recorded terminal screen, while both
Agent Code orchestration sessions remained `prompt_sent`/`waiting` with zero
committed JSONL messages. This is a recorded cross-wire test: each candidate
must accept only its own local token when both same-CWD fixtures are present.

## Reproduction and verification contract

The extractor consumes a private JSON manifest. Each source entry supplies an
ID, rollout path, session class, local prompt observation index, expected old
and target decisions, and optional line limit for a rollout that was live when
captured. A minimal source entry is:

```json
{
  "id": "recorded-case",
  "sourcePath": "/private/path/rollout.jsonl",
  "sourceLineLimit": 100,
  "sessionRecordingId": "recording-id",
  "sessionClass": "fresh",
  "localPromptObservationIndex": 1,
  "expectedLegacyDecision": "hold",
  "expectedTargetDecision": "accept",
  "note": "Why this recording belongs in the corpus."
}
```

Generation and `--verify` run the production parser over the private source and
sanitized projection, then compare ordered transport/equality signatures and
the legacy decision. Verification fails if the source hash or projection drifts,
if a pinned live prefix is shorter than recorded, if a private path survives,
or if complete recorded user text leaks into the fixture.

## What these fixtures do not decide

- They do not authorize attaching two rollouts when the same normalized local
  prompt appears in both. That remains ambiguous and must fail closed.
- They do not turn English bootstrap prefixes into a protocol. The target
  claimant matches private local prompt evidence and never tries to recognize
  `AGENTS.md` or environment text by content.
- The subagent fixture does not exercise fresh ownership. It exists to ensure
  integration work does not route exact-id/lineage attachment through the new
  claimant.
