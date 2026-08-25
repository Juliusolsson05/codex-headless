# Codex prompt-input evidence corpus

These fixtures are projections of real Codex `0.149.1` TUI sessions, not
hand-written editor examples. `record-live-prompt-input.mts` drives the installed
binary through `node-pty`, reads the provider-rendered xterm grid, points Codex
at a localhost canned Responses server, and independently compares:

1. the role-user value Codex durably appended to its isolated rollout; and
2. the final role-user value Codex sent to the local Responses endpoint.

No external model request is made. Raw PTY bytes, request bodies, rollouts,
temporary paths, injected startup context, and account/plugin state are not
committed. The fixture retains only public sentinel input, sanitized structural
screen rows, expected submission/no-submission, exact public submitted value,
and SHA-256 provenance for each private source stream.

## Reproduce

From `packages/codex-headless` with the exact `0.149.1` binary installed:

```sh
CODEX_BINARY=/absolute/path/to/codex \
  npx tsx testing/record-live-prompt-input.mts
```

The script prints a sanitized JSON projection to stdout and exits non-zero if
the rollout and localhost request disagree. Review and commit the projection
with `apply_patch`; do not redirect raw or projected provider output into the
repository because the privacy review must happen before the file exists.

Build the exact pre-repair package before recording its runtime capability
shape:

```sh
npm run build
npx tsx testing/record-resume-capability-shape.mts
```

## Inventory

| Case | Provider fact recorded |
|---|---|
| `trust-action-then-submit` | Trust byte `1` is modal input; the later durable prompt excludes it. |
| `combining-grapheme-backspace` | Backspace deletes the entire decomposed grapheme. |
| `mixed-cjk-ctrl-w` | Ctrl+W follows Codex's Unicode word boundary, not an ASCII separator run. |
| `repeated-line-boundaries` | Repeated Ctrl+A/Ctrl+E crosses adjacent logical lines. |
| `remapped-kill-line-start` | A CLI keymap override makes Ctrl+U a no-op. |
| `vim-normal-default` | Initial `i` changes Vim mode and is not inserted into the prompt. |
| `unbound-submit-enter` | An empty submit binding makes Enter a non-submission. |
| `modal-ctrl-c-preserves-draft` | Ctrl+R history search consumes Ctrl+C and restores the underlying draft. |
| `tab-footer-spoof-skill-popup` | Draft text can contain `tab to queue` while a `$` popup consumes Tab. |
| `active-footer-tab-queue` | Only the active running-composer bottom footer makes Tab queue the draft. |
| `capability-6244eac-recorded` | The built pre-repair package is constructible by deep import and exposes/retains raw state. |

## Source boundary

- CLI: `codex-cli 0.149.1`
- Binary SHA-256:
  `f0d8762236594359b60cfbe17f4c7e945a3ce8d1c91e74778838c968d250fb6c`
- Upstream source tag: `rust-v0.149.1`
- Recorded package head:
  `6244eac4a24ac1fb2aa6d12227cd85c106590ca7`

The screen projection deliberately retains full bottom-pane row ordering around
the composer, popup, and queue footer. Whole-screen prose is not input evidence;
tests must classify the structural bottom surface and may not search transcript
history for a magic substring.
