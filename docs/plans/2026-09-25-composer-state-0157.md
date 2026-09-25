# A live, attribute-aware composer read for Codex (agent-code#800, #1313)

## Evidence
A raw PTY recording of codex-cli 0.157.0 (`testing/fixtures/composer-0157/idle-draft-ctrlc.json`):
- **Empty composer:** `› Ask Codex to do anything`, with the placeholder painted dim (`\x1b[2m`). Below it are a blank row, the status row `  GPT-6-Sol high fast · ~/…`, and a SECOND footer row (`  ← for agents · ? for shortcuts … ⚠ 1 warning`).
- **Typed draft:** `› please review the draft`, in plain cells. The hint half of the second footer row goes blank; the warning stays.
- **Ctrl+C:** clears the draft, and the dim placeholder returns.

Replayed through this package's `HeadlessTerminal`, `classifyCodex01491ComposerSurface` returns `unknown` for both frames. It requires exactly one footer row, the 0.149.1 layout. The app's text-only `isCodexNativeComposerEmpty` cannot call the empty composer empty either (agent-code#1313), and nothing reports a Codex draft (agent-code#800).

## Change
`CodexHeadless.getComposerState(): 'empty' | 'drafted' | 'unknown'`, read from the LIVE xterm buffer, not a throttled snapshot:
- **Anchor:** the bottom-most `›` row within the bottom pane, its continuation rows, then a blank row, then one or two footer rows. The first footer row must be the status shape `  <x> · <y>`, and nothing else may follow. Anything else is `unknown`, so transcript text that begins with `›` cannot pose as the composer.
- **Classification (after review round 1):**
  - `drafted`: plain (non-dim) cells on the composer rows, an `[Image #n]` label on them, or Codex's own "tab to queue message" hint (`ComposerHasDraft` while a task runs).
  - `empty`: no plain cells AND the footer shows Codex's `? for shortcuts` hint. Codex shows that hint ONLY in `FooterMode::ComposerEmpty`, and its `is_empty()` counts attachments and bash mode (`vendor/codex-src/codex-rs/tui/src/bottom_pane/footer.rs:224-231`, `chat_composer.rs:1128`).
  - `unknown`: everything else. Dim cells alone are not enough: the quit frame paints `› Shutting down...` dim, and an image attached above the textarea keeps the dim placeholder (#54 review A and C).
- **Anchor:** the footer head is the status row or, during a turn, the queue row. A Vim atom on either footer row makes the result `unknown`.
- The 0.149.1 classifier and `PromptInputEvidence` are untouched; they stay version-gated.

## Tests
- Replay the recording: the empty frame and the after-Ctrl+C frame read `empty`; the typed draft reads `drafted`.
- A transcript `›` row with no footer below it reads `unknown`.
- Red before the change, because the method does not exist.
