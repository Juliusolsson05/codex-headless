# Prompt-input profile for Codex 0.157.1 (#63)

## Evidence
- `prepareCodex01491PromptInputProfile` refuses any CLI whose app-server `userAgent` is not exactly `0.149.1`.
  - The result at 0.157.1, the version Agent Code runs daily, is `unsupported-cli`.
  - `CodexHeadless` then gets no profile and `PromptInputEvidence` yields nothing.
  - Fresh-rollout ownership survives only through the proxy identity path.
- The pin is deliberate. The profile is a recorded contract, not a version range. The fix is to record 0.157.1 against the same corpus and issue a profile only for a version whose recording matches.
- **First run of the unchanged recorder against 0.157.1 (2026-09-27):**
  1. **Codex never started.** 0.157 auto-starts a managed app-server daemon whose control socket lives under `CODEX_HOME`. The recorder's isolated home under macOS `$TMPDIR` makes the socket path longer than SUN_LEN, and Codex exits with "app server did not become ready … use --no-daemon". The spawned daemon also outlived its deleted home. Filed as #66.
     - `--no-daemon` exists from 0.156.0: absent in the installed 0.150.1–0.155.1 standalone releases, present in 0.156.0–0.157.1.
  2. **The trust case waited forever** for the pre-0.156 dialog text. The 0.156+ dialog is different (#65). There, `1` only moves the highlight and Enter confirms.
- **Agent Code does not pass `--no-alt-screen`**, and 0.157 made the fullscreen transcript (alternate screen) the default. The recorder always passed `--no-alt-screen`, so its inline corpus alone does not describe the screen the app's panes show.

## Change (recorder, this commit's scope)
- Pass `--no-daemon` from 0.156, gated by version because older CLIs reject unknown flags.
- `CODEX_INPUT_RECORD_ALT_SCREEN=1` records with the app's launch shape (no `--no-alt-screen`).
- **The trust case handles both dialogs.** On the 0.156+ dialog it writes `1`, then asserts after 1 s that the dialog is STILL up, then writes Enter. This live-verifies (in the isolated home) the keystroke contract that #65 took from upstream source.

## Result (recorded 2026-09-27)
- **Corpus.** All 16 cases were recorded against codex-cli 0.157.1, inline and fullscreen. Rollout and request agree in every case. The only provider semantic that differs from 0.149.1 is the Vim-default composer opening in Insert (`vim-normal-default` submits `iabc`), and the issued profile forces Vim off anyway.
- **`config/read`.** The projection is identical to 0.149.1's. The per-tag audit of the config precedence code is in `codex-01571-config-source.json`: all nine claims hold at new coordinates. New in 0.157: thread config layers, which use the same precedence table.

### Recorder fixes the recording needed
Each is gated to 0.156+ and explained where it is made:
- `--no-daemon` (SUN_LEN, #66).
- A seen model migration.
- Skill frontmatter.
- The trust case: `1` then Enter, asserting `1` alone leaves the dialog up. This is live verification for #65.
- Title side requests (`thread_title.rs`) are answered unheld and unrecorded. My first diagnosis called them retries; that was wrong, and the comment says so.
- The request that carries the prompt is matched, not the newest one (0.157 does re-send a held request).
- Frames and screens are windowed on the last painted row (0.157 paints short sessions from the top).
- The resize redraw is taken when the rows actually change. Fullscreen repaints on a frame timer after a quiet gap.
- The popup wait uses the popup's own hint.

### Classifier fixes: real 0.157 surfaces the 0.149.1 classifier misread
Each is pinned by the recorded corpora:
- **The trust dialog's hint row has the idle-footer shape.** The dialog read as a composer drafting "1. Trust and continue". It is now matched as a bottom-row structural modal check, shared byte-for-byte with #67.
- **The skill popup moved above the composer**, with the hint `enter insert · esc close`. Read as an idle composer, Enter-to-insert would have produced evidence for a prompt Codex never sent. It is now `completion-popup`.
- **Fullscreen paints a two-row footer:** the status line, then `? for shortcuts` or `tab to queue message`. Only those exact rows are accepted; anything else is `unknown`.

### Profile
Issued for a table of exact recorded versions (0.149.1, 0.157.1), never a range. Unrecorded versions still get `unsupported-cli`.

### Fail-first
Against origin/main, both 0.157.1 suites fail at profile issuance. With only the classifier reverted, 6 tests fail.

### Found and filed, not fixed here
- **#68:** 0.157.1 drops a `?` from a single-chunk typed draft in about 1 of 5 runs. That is the `sendPrompt` single-line path. The committed corpus is from intact runs, and the catalog says so.
