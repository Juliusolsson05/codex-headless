// Detect Codex's trust dialog from a screen snapshot.
//
// Codex shows this on first launch in a new directory. Captured live from
// codex-cli 0.145.0 in a fresh temp dir (see
// docs/decomposition/provider-condition-answering.md in agent-code):
//
//   > You are in /private/var/folders/.../codex-trust-z1cosz
//     Do you trust the contents of this directory? Working with untrusted
//     contents comes with higher risk of prompt injection. Trusting the
//     directory allows project-local config, hooks, and exec policies to load.
//   › 1. Yes, continue
//     2. No, quit
//     Press enter to continue
//
// Pure: no Node, no DOM, no IO.

export type CodexTrustDialogState = {
  /** True if Codex is currently showing the trust dialog. */
  visible: boolean
  /** The directory Codex is asking the user to trust. */
  workspace?: string
  /** The selectable options. */
  options?: Array<{ key: string; label: string }>
}

// STRUCTURAL anchoring, not substring presence.
//
// The previous implementation asked `screen.includes(marker)` for three
// phrases anywhere on screen. That is not a dialog test, it is a text search,
// and it fired constantly: scanning 52 real session recordings for all three
// markers found 14 full matches, and EVERY ONE was an assistant discussing the
// trust dialog — a code review, a pasted parser, a plan document. The same
// flaw hit the approval titles, where 28 frames matched three DIFFERENT titles
// simultaneously because the frame contained a list literal holding all of
// them; a real overlay can only ever show one.
//
// That false positive is not cosmetic. `codex.trust-dialog` is in the
// provider's `actionKinds`, so a phantom detection blocks keystroke routing
// and paints an unanswerable modal over a session that is asking nothing —
// and it re-fires on every frame while the text remains on screen, so the
// modal never closes on its own.
//
// The real dialog has STRUCTURE: an anchor line naming the directory, then two
// numbered option rows, in that vertical order. Prose that merely mentions the
// phrases has no `> You are in` line followed by numbered rows, so it can no
// longer match.
//
// UPSTREAM DRIFT: 0.145 appends a sentence ("Trusting the directory allows
// project-local config, hooks, and exec policies to load.") that the vendored
// 0.130 source does not have — so anchoring on the full paragraph would
// already be broken today. Anchor on the stable question opener only.
// Live-verified at 120/80/60/50 columns: these anchors survive wrapping,
// because the paragraph wraps AFTER the opening phrase.
//
// The floor, measured rather than assumed: detection holds down to 46
// columns and FAILS at 44, where the 44-character question phrase itself
// wraps and this whole-screen substring test can no longer see it. It also
// fails at rows <= 7, where the option rows clip off the bottom of the
// viewport while the dialog is live and blocking. Both limits are inherited
// from the previous implementation, not introduced here — the old marker
// list failed at exactly the same widths — but they are real, so they are
// written down instead of implied. Fixing them means matching on reflowed
// text and reading beyond the viewport, which is a larger change than this.

const QUESTION_RE = /Do you trust the contents of this directory/
const YOU_ARE_IN_RE = /^\s*>\s*You are in\s+(.+?)\s*$/
// The highlighted row carries a `›` marker, and the highlight moves with arrow
// keys, so either row may or may not be marked.
const YES_ROW_RE = /^\s*[›>]?\s*1\.\s*Yes, continue\s*$/
const NO_ROW_RE = /^\s*[›>]?\s*2\.\s*No, quit\s*$/

/**
 * Detect Codex's trust dialog from a plain-text screen snapshot.
 *
 * Returns { visible: true, workspace, options } when the dialog is genuinely
 * on screen, { visible: false } otherwise. Called on every changed screen
 * frame, so the cheap whole-string reject runs first.
 */
export function detectCodexTrustDialog(screen: string): CodexTrustDialogState {
  if (!screen) return { visible: false }
  if (!QUESTION_RE.test(screen)) return { visible: false }

  const lines = screen.split('\n')
  let anchorIdx = -1
  let workspace: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(YOU_ARE_IN_RE)
    if (m) {
      anchorIdx = i
      workspace = m[1].trim()
      break
    }
  }
  if (anchorIdx === -1) return { visible: false }

  // Both option rows must appear BELOW the anchor, in order. Scanning the
  // whole screen would re-admit a transcript that happens to quote them.
  let yesIdx = -1
  let noIdx = -1
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    if (yesIdx === -1 && YES_ROW_RE.test(lines[i])) {
      yesIdx = i
      continue
    }
    if (yesIdx !== -1 && NO_ROW_RE.test(lines[i])) {
      noIdx = i
      break
    }
  }
  if (yesIdx === -1 || noIdx === -1) return { visible: false }

  const options = [
    { key: '1', label: 'Yes, continue' },
    { key: '2', label: 'No, quit' },
  ]

  return { visible: true, workspace, options }
}

/**
 * The keystroke that accepts the trust dialog.
 *
 * `1`, not `\r`. Both were verified to work against a live codex-cli 0.145.0
 * dialog, but they are NOT equivalent: upstream maps Enter to "confirm
 * whatever is currently HIGHLIGHTED" (trust_directory.rs KeyboardHandler),
 * while `1` selects "Yes, continue" unconditionally. The highlight moves on
 * arrow keys, so an Enter sent after any stray navigation quits Codex instead
 * of trusting the directory. A UI button must mean exactly one thing.
 */
export const CODEX_TRUST_DIALOG_ACCEPT_KEYS = '1'

/**
 * The keystroke that declines.
 *
 * `2` alone, with NO trailing `\r`. Upstream acts on the digit immediately
 * (`KeyCode::Char('2') => handle_quit()`), verified live: sending `2` quits.
 * The old `'2\r'` therefore delivered a stray Enter into whatever screen came
 * next.
 */
export const CODEX_TRUST_DIALOG_DECLINE_KEYS = '2'
