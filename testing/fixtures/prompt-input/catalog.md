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

The Stage 29 extension can be replayed without rerunning the older corpus:

```sh
CODEX_INPUT_RECORD_CASES=narrow-soft-wrap-resize-redraw,unchanged-redraw-after-edit,ordinary-modal-sentinel-draft,ordinary-vim-sentinel-cwd,lower-layer-keymap-valid-control,lower-layer-keymap-issued-profile-conflict \
CODEX_INPUT_RECORD_TIMEOUT_MS=30000 \
  npx tsx testing/record-live-prompt-input.mts
```

The script prints a sanitized JSON projection to stdout and exits non-zero if
the rollout and localhost request disagree. Review and commit the projection
with `apply_patch`; do not redirect raw or projected provider output into the
repository because the privacy review must happen before the file exists.

The effective launch profile has its own app-server recording:

```sh
CODEX_BINARY=/absolute/path/to/codex \
  npx tsx testing/record-live-config-read.mts
```

That recorder invokes `config/read` with the exact four proposed session
overrides, but emits only the provider version, non-null key-routing projection,
and configuration layer types. It never writes or prints the raw effective
configuration.

Build the exact pre-repair package before recording its runtime capability
shape:

```sh
npm run build
npx tsx testing/record-resume-capability-shape.mts
```

## Codex 0.157.1 (#63)

The same 16 cases were re-recorded against codex-cli `0.157.1` on 2026-09-27, twice:
- `codex-01571-recorded.json`: inline (`--no-alt-screen`), comparable row for row with the 0.149.1 corpus.
- `codex-01571-fullscreen-recorded.json`: fullscreen, 0.157's default and how Agent Code launches Codex.

`codex-01571-config-read-recorded.json` and `codex-01571-config-source.json` are the matching `config/read` projection and the per-tag audit of the config precedence code.

The recorder needed these 0.156+ adjustments. Each is gated so the 0.149.1 recording conditions are unchanged, and each is explained where it is made:
- `--no-daemon`: the isolated `CODEX_HOME` otherwise exceeds SUN_LEN for the managed daemon's socket.
- A seen `gpt-5.6-sol → gpt-6-sol` model migration.
- YAML frontmatter on the fixture skill.
- The trust case answers `1` then Enter, and asserts that `1` alone leaves the dialog up.
- All held slow-turn requests are released: 0.157 retries a request that has written no bytes.
- Resize frames are windowed on the last painted row.
- The popup wait uses the popup's own key hint.

Provider facts that differ from 0.149.1:
- **Vim default.** A Vim-default composer now opens in Insert, so `vim-normal-default` submits `iabc`. It is outside the issued profile, which forces Vim off.
- **Skill popup.** The skill popup paints above the composer, with the hint `enter insert · esc close`.
- **Trust dialog.** The trust dialog is the new `Folder access` layout, and its last row has the idle-footer shape.

The composer-surface classifier recognises the last two. Every issued-profile case agrees with 0.149.1.

**Known provider flake, not hidden:** 0.157.1 sometimes drops a `?` from a single-chunk typed draft (1 in 5 runs of `ordinary-modal-sentinel-draft`; codex-headless#68). The recorder fails loudly when that happens, because rollout, request and typed text disagree. The committed corpus is from runs where the text arrived intact; the drop is tracked in #68 with its own evidence.

**Side requests:** 0.157.1 also sends a thread-title side request after the first prompt. The fixture server answers it without holding or recording it (see `serveFixture`).

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
| `narrow-soft-wrap-resize-redraw` | A synchronous resize exposes the old two-row 52-column provider paint at 92 columns and the same generation; only later provider bytes advance the generation and repaint the draft as one row. |
| `unchanged-redraw-after-edit` | After a suffix edit, a real working-status chunk advances the PTY generation while retaining the prior draft/cursor; only the later provider paint contains the suffix. |
| `ordinary-modal-sentinel-draft` | Modal sentinel prose inside an ordinary draft is submitted identically to the rollout and provider request. |
| `ordinary-vim-sentinel-cwd` | A literal `Vim: Insert` cwd suffix is ordinary footer text, not evidence that Vim mode is active. |
| `lower-layer-keymap-valid-control` | The lower-layer `queue=[]` plus `toggle_shortcuts="tab"` map reaches a composer with no request or rollout user item. |
| `lower-layer-keymap-issued-profile-conflict` | Adding the exact four package-issued CLI overrides makes the otherwise-valid lower map exit 1 before the composer, request, or rollout user item. |
| `capability-6244eac-recorded` | The built pre-repair package is constructible by deep import and exposes/retains raw state. |

## Source boundary

- CLI: `codex-cli 0.149.1`
- Binary SHA-256:
  `f0d8762236594359b60cfbe17f4c7e945a3ce8d1c91e74778838c968d250fb6c`
- Upstream source tag: `rust-v0.149.1`
- Upstream tag commit:
  `ff29a44391deccde0aba0f8390337d7f3c319ea4`
- Recorded package head:
  `6244eac4a24ac1fb2aa6d12227cd85c106590ca7`

`codex-01491-config-source.json` pins the exact tag commit, full-file hashes,
and line coordinates for session/managed precedence, CLI override materializing,
TOML overlay semantics, and effective-keymap conflict validation. It is source
evidence beside the provider recording, not a substitute for the two observed
startup outcomes.

`codex-01491-config-read-recorded.json` is the matching live `config/read`
projection. It records that the exact 0.149.1 binary resolved Enter, Tab, Vim
mode, and every other keymap leaf as expected on the capture host, and that no
legacy managed layer was present. The source fixture remains the authority for
why legacy managed file/MDM layers must be refused when they do appear.

The screen projection deliberately retains full bottom-pane row ordering around
the composer, popup, and queue footer. Whole-screen prose is not input evidence;
tests must classify the structural bottom surface and may not search transcript
history for a magic substring.
