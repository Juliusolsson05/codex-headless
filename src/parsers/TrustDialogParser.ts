// Detect Codex's trust dialog from a screen snapshot.
//
// Two upstream layouts are recognised. The 0.156+ `Folder access` layout is
// documented at detectFolderAccessLayout below (#65). The legacy layout, still
// painted by the accepted 0.149.1, was captured live from
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
  /**
   * The folder the dialog names: `> You are in <dir>` (legacy) or the path
   * under `Folder access` (0.157). When 0.157 elides that row for space, this
   * falls back to `trustTarget`.
   */
  workspace?: string
  /**
   * 0.157 only: the Git repository root that trust will actually apply to,
   * shown under "Note: You’re in a subdirectory of a Git project". Absent when
   * trust applies to `workspace` itself.
   */
  trustTarget?: string
  /** The selectable options, labels exactly as painted. */
  options?: Array<{ key: string; label: string }>
  /** Which upstream layout matched; decides the keystrokes below. */
  layout?: CodexTrustDialogLayout
  /** Bytes that choose option 1 on THIS layout. See the constants below. */
  acceptKeys?: string
  /** Bytes that choose option 2 on THIS layout. */
  declineKeys?: string
}

/**
 * `you-are-in`: codex-cli 0.145–0.149 (`> You are in …` / `1. Yes, continue`).
 * `folder-access`: codex-cli 0.156+ (`Folder access` / `1. Trust and continue`).
 */
export type CodexTrustDialogLayout = 'you-are-in' | 'folder-access'

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
 * Returns { visible: true, … } when either upstream layout is genuinely on
 * screen, { visible: false } otherwise. Called on every changed screen frame,
 * so each layout's cheap whole-string reject runs first.
 */
export function detectCodexTrustDialog(screen: string): CodexTrustDialogState {
  if (!screen) return { visible: false }
  return detectFolderAccessLayout(screen) ?? detectYouAreInLayout(screen) ?? { visible: false }
}

function detectYouAreInLayout(screen: string): CodexTrustDialogState | null {
  if (!QUESTION_RE.test(screen)) return null

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
  if (anchorIdx === -1) return null

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
  if (yesIdx === -1 || noIdx === -1) return null

  return {
    visible: true,
    workspace,
    options: [
      { key: '1', label: 'Yes, continue' },
      { key: '2', label: 'No, quit' },
    ],
    layout: 'you-are-in',
    acceptKeys: CODEX_TRUST_DIALOG_ACCEPT_KEYS,
    declineKeys: CODEX_TRUST_DIALOG_DECLINE_KEYS,
  }
}

// --- 0.156+ "Folder access" layout (#65) ---
//
// Recorded from codex-cli 0.157.1 (testing/fixtures/trust-dialog-0157) and
// read against upstream `codex-rs/tui/src/onboarding/trust_directory.rs` at
// tag rust-v0.157.1:
//
//     Folder access
//     /path/to/folder                       (hard-wrapped, or …-truncated)
//
//     Note: You’re in a subdirectory of a Git project. Trusting will apply
//     to the repository root:               (only in a Git subdirectory)
//     /path/to/repo
//
//     Trust this folder? Codex can read, edit, and run files here, …
//
//   › 1. Trust and continue
//     2. Back to Agent Command Center
//
//     <error paragraph>                     (only after a failed trust write)
//
//     enter continue · esc back
//
// The old anchors are all gone: no `> You are in`, no "Do you trust the
// contents", no `Yes, continue` / `No, quit`. So the previous parser returned
// not-visible for a live, blocking dialog.
//
// The same STRUCTURAL rule as the legacy layout, for the same reason (text
// that quotes the dialog must never raise a blocking modal), plus position:
// the key hint must be the LAST painted row (see detectFolderAccessLayout),
// with the nearest adjacent `1.` / `2.` pair above it and the nearest
// `Folder access` title above that. Each piece must be a whole line, and the
// option labels must be ones upstream can paint. The question paragraph is NOT an
// anchor: it has three different texts (trust / restricted / existing task)
// and it wraps at every width.
//
// WHY the labels are read from the screen and not fixed. Upstream varies both:
//   option 1: "Trust and continue", or "Open restricted" for a folder saved
//             as untrusted, or "Open existing task" when resuming one;
//   option 2: "Quit", or "Back to Agent Command Center" when Codex is
//             connected to its background server (TrustCancelAction).
// Both option-2 labels were seen locally on the same 0.157.1 binary in
// different folders. A fixed "Quit" button would lie in the second case: the
// key goes back to the overview, and Codex keeps running.
//
// The hint must agree with option 2 (`esc quit` with Quit, `esc back` with
// Back…), because upstream derives both from the same TrustCancelAction. A
// frame where they disagree is not a real render.
//
// Width floor: every anchor line is at most 33 characters
// ("  2. Back to Agent Command Center"), and upstream's own 40-column snapshots
// keep each on one row, so detection holds at 40 columns. The Windows sandbox
// hint (46 characters) wraps below 46 columns; one wrap is accepted. When
// anything wraps further, detection fails closed (not visible), the same
// failure direction as the legacy layout's floor.
const FOLDER_ACCESS_RE = /^\s*Folder access\s*$/
const FIRST_OPTION_RE = /^\s*[›>]?\s*1\.\s*(Trust and continue|Open restricted|Open existing task)\s*$/
const SECOND_OPTION_RE = /^\s*[›>]?\s*2\.\s*(Quit|Back to Agent Command Center)\s*$/
// "and create sandbox" is the Windows variant of the confirm hint.
const HINT_RE = /^\s*enter continue(?: and create sandbox)?\s*·\s*esc (quit|back)\s*$/
// Only the note's first words: the sentence wraps as early as "…of a" at 40
// columns (upstream's long_repository_root_40x17 snapshot).
const GIT_NOTE_RE = /^\s*Note: You[’']re in a subdirectory/
const GIT_NOTE_END_RE = /repository root:\s*$/
// The three fixed paragraph openers. They end a path block when the dialog is
// so short that upstream drops the blank spacer rows (the 40x13 snapshot).
const PARAGRAPH_OPENER_RE = /^\s*(Trust this folder\?|Config, hooks, and exec policies|This existing task may retain)/

function detectFolderAccessLayout(screen: string): CodexTrustDialogState | null {
  if (!screen.includes('Folder access')) return null
  const lines = screen.split('\n')

  // WHY the match is anchored at the BOTTOM of the screen and read upward
  // (review of #67, both reviewers). The first cut accepted the first
  // `Folder access` line anywhere, then any later option pair and hint. A
  // transcript that quotes this dialog verbatim (a pasted upstream .snap, a
  // copied terminal frame, this repo's own plan) satisfied all of that and
  // raised a blocking, ANSWERABLE phantom whose keys would then be written
  // into whatever screen was really up. What a copy cannot fake is position:
  // this dialog is Codex's onboarding screen, painted before any chat widget
  // exists, so its key hint is the last painted row. A quoted frame inside a
  // transcript always has the live composer (and footer) below it.
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last--
  if (last < 0) return null

  // The hint is a wrapping paragraph. The Windows variant ("enter continue
  // and create sandbox · esc quit", 46 columns with its inset) wraps onto a
  // second row below 46 columns, so the last row alone or the last two rows
  // joined must read as the hint.
  let hintStart = last
  let hintMatch = lines[last].match(HINT_RE)
  if (!hintMatch && last > 0 && lines[last - 1].trim() !== '') {
    hintMatch = `${lines[last - 1].trim()} ${lines[last].trim()}`.match(HINT_RE)
    hintStart = last - 1
  }
  if (!hintMatch) return null
  const hintVerb = hintMatch[1]

  // The option pair is adjacent in every upstream render (two picker rows
  // pushed back to back, no spacer) and is the nearest pair above the hint;
  // only a spacer and an optional error paragraph sit between them.
  let firstIdx = -1
  for (let i = hintStart - 2; i >= 0; i--) {
    if (FIRST_OPTION_RE.test(lines[i]) && SECOND_OPTION_RE.test(lines[i + 1])) {
      firstIdx = i
      break
    }
  }
  if (firstIdx === -1) return null
  const firstLabel = lines[firstIdx].match(FIRST_OPTION_RE)![1]
  const secondLabel = lines[firstIdx + 1].match(SECOND_OPTION_RE)![1]
  if ((hintVerb === 'quit') !== (secondLabel === 'Quit')) return null

  // The nearest `Folder access` above the options is the dialog's own title.
  let anchorIdx = -1
  for (let i = firstIdx - 1; i >= 0; i--) {
    if (FOLDER_ACCESS_RE.test(lines[i])) {
      anchorIdx = i
      break
    }
  }
  if (anchorIdx === -1) return null

  const { workspace, trustTarget } = readFolderAccessPaths(lines.slice(anchorIdx + 1, firstIdx))

  return {
    visible: true,
    workspace: workspace ?? trustTarget,
    ...(trustTarget !== undefined ? { trustTarget } : {}),
    options: [
      { key: '1', label: firstLabel },
      { key: '2', label: secondLabel },
    ],
    layout: 'folder-access',
    acceptKeys: CODEX_TRUST_DIALOG_FOLDER_ACCESS_ACCEPT_KEYS,
    declineKeys: CODEX_TRUST_DIALOG_FOLDER_ACCESS_DECLINE_KEYS,
  }
}

// Reads the folder path under `Folder access` and, in a Git subdirectory, the
// repository root under the note.
//
// WHY rows are concatenated with no separator: upstream renders a path as a
// ratatui Paragraph with `trim: false` in a (width - 4) column, so a long path
// hard-wraps at an arbitrary CHARACTER ("…/long-nested-folde" + "r" in the
// 40x24 snapshot), not at a separator. Stripping the 2-column inset and the
// right padding, then joining, restores it. The one thing this cannot restore
// is a space that sat exactly at a wrap boundary; a folder name with a space
// in precisely that column loses it. A path too tall for its rows is instead
// centre-truncated to one row with `…`, which is reported as painted.
function readFolderAccessPaths(block: string[]): { workspace?: string; trustTarget?: string } {
  const joinRows = (rows: string[]) => {
    const text = rows.map(row => row.replace(/^ {2}/, '').replace(/\s+$/, '')).join('')
    return text.length > 0 ? text : undefined
  }
  const endsPathBlock = (line: string) =>
    line.trim() === '' || GIT_NOTE_RE.test(line) || PARAGRAPH_OPENER_RE.test(line)

  let i = 0
  const cwdRows: string[] = []
  while (i < block.length && !endsPathBlock(block[i])) cwdRows.push(block[i++])
  while (i < block.length && block[i].trim() === '') i++

  let trustTarget: string | undefined
  if (i < block.length && GIT_NOTE_RE.test(block[i])) {
    // The note paragraph wraps too; it ends on the row ending "root:".
    while (i < block.length && !GIT_NOTE_END_RE.test(block[i])) i++
    i++
    const rootRows: string[] = []
    while (i < block.length && !endsPathBlock(block[i])) rootRows.push(block[i++])
    trustTarget = joinRows(rootRows)
  }
  return { workspace: joinRows(cwdRows), trustTarget }
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

/**
 * The keystrokes that choose option 1 on the 0.156+ `Folder access` layout.
 *
 * `1` then Enter, NOT `1` alone. Upstream changed what the digit does
 * (trust_directory.rs at rust-v0.157.1): `1`/`y` (SELECT_FIRST) now only MOVES
 * THE HIGHLIGHT to option 1, "trust always requires an explicit Enter
 * confirmation" (a terminal colour-query reply can begin with `1`), and only
 * Enter (CONFIRM) acts on the highlighted row. So the legacy `'1'` would
 * leave the dialog up, and a bare `'\r'` would confirm whatever happened to
 * be highlighted, which may be option 2. `1` first pins the highlight, so the
 * Enter that follows can only confirm option 1.
 *
 * Source-verified, not live-verified: answering the dialog live writes the
 * trust decision into the user's own ~/.codex/config.toml, so the recording
 * (testing/fixtures/trust-dialog-0157) deliberately never pressed a key.
 * The upstream unit test `fragmented_terminal_response_cannot_grant_directory_trust`
 * pins exactly this: digits move the highlight, Enter grants.
 */
export const CODEX_TRUST_DIALOG_FOLDER_ACCESS_ACCEPT_KEYS = '1\r'

/**
 * The keystroke that chooses option 2 on the 0.156+ layout.
 *
 * Still `2` alone: `2`/`n` (SELECT_SECOND) acts immediately (`handle_quit`),
 * as before. What option 2 MEANS varies (quit, or back to the overview), which
 * is why the condition labels its action from the screen.
 */
export const CODEX_TRUST_DIALOG_FOLDER_ACCESS_DECLINE_KEYS = '2'
