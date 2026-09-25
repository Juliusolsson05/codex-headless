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
- **Classification:** plain (non-dim, non-blank) cells on the composer rows after the marker mean `drafted`. Only dim or blank cells mean `empty`.
- **Fail closed:** a Vim status suffix on the footer is `unknown`, and an `[Image #n]` attachment label on the composer rows is `drafted`.
- The 0.149.1 classifier and `PromptInputEvidence` are untouched; they stay version-gated.

## Tests
- Replay the recording: the empty frame and the after-Ctrl+C frame read `empty`; the typed draft reads `drafted`.
- A transcript `›` row with no footer below it reads `unknown`.
- Red before the change, because the method does not exist.
