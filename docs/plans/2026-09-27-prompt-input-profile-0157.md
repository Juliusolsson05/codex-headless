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

## Next (after the recording)
- Commit the sanitized 0.157.1 projection, recorded inline and fullscreen.
- Make the recorded-catalog test run per recorded version.
- Issue the profile for exactly the recorded versions: the `cliVersion`/`upstreamTag` pair comes from a table, never a range. Re-record `config/read` for 0.157.1.
- Anything the 0.157.1 corpus shows to differ from 0.149.1 is fixed in the composer-surface classifier from the recorded frames, or the profile stays refused for that version with the reason stated.
