/**
 * Is Codex's composer empty, holding a draft, or not provably either?
 * (agent-code#800, agent-code#1313)
 *
 * WHY cell attributes and not text: Codex 0.157 paints its empty-composer
 * placeholder ("Ask Codex to do anything", and other suggestions) as DIM text
 * after the `›` marker, and a typed draft as plain text on the same row.
 * Recorded: `testing/fixtures/composer-0157/idle-draft-ctrlc.json`. The words
 * alone cannot tell them apart: a human can type the placeholder's words, and
 * the placeholder changes between versions. Claude's composer has the same
 * property; claude-code-headless settled it the same way (#39).
 *
 * WHY the bottom-pane anchor: transcript rows are attacker-controlled and user
 * messages in the transcript also start with `›`. Only the composer sits
 * directly above a blank row and the provider's footer, so any other shape is
 * `unknown`, never `empty` and never `drafted`.
 *
 * Callers must treat `unknown` as "cannot verify" and map it to NEITHER
 * side: it is not occupancy (a false occupied blocks every prompt; the Claude
 * gate latched that way for 186 s once), and it is not ready or consent
 * either (#54 review C: a Claude-style "anything else is ready" fall-through
 * would drop real drafts). Only `empty` is consent, and it requires Codex's
 * own empty-composer hint (EMPTY_HINT_ROW); only `drafted` is occupancy.
 */

export type CodexComposerState = 'empty' | 'drafted' | 'unknown'

/** One viewport row: its text (right-trimmed) and, for every non-blank cell,
 *  whether it is painted dim. */
export type ComposerCellRow = {
  text: string
  cells: ReadonlyArray<{ chars: string; dim: boolean }>
}

// `  <model> · <cwd>`, the provider status row; 0.149.1 and 0.157.0 agree.
const STATUS_ROW = /^ {2}\S.* · .+$/u
// While a turn runs, the queue hint can take the status row's place (0.149.1
// recorded case `active-footer-tab-queue`; upstream footer.rs QueueMessage).
const QUEUE_ROW = /^ {2}\S+ to queue(?: message)?\b/u
// A Vim status atom means the key semantics of the composer changed under us.
const VIM_STATUS_SUFFIX = / {2,}Vim: (?:Insert|Normal)$/u
const MARKER_ROW = /^›(?: |$)/u
// How far above the footer the marker may sit: the composer grows with a
// multi-line draft, but a marker further up is transcript, not composer.
const MAX_COMPOSER_ROWS = 12

/**
 * WHY `empty` needs Codex's own word for it (#54 review A, C): dim cells are
 * not enough. The quit frame paints `› Shutting down...` dim, and an image
 * attached above the textarea leaves the dim placeholder in place; both read
 * "empty" from cells alone, and an empty-only caller would then write into an
 * exiting process or submit an image it never saw. Codex shows the
 * `? for shortcuts` hint ONLY in `FooterMode::ComposerEmpty`, and its
 * `is_empty()` already counts attachments and bash mode
 * (vendor/codex-src/codex-rs/tui/src/bottom_pane/footer.rs:224-231,
 * chat_composer.rs:1128). No hint (quit, a narrow pane that dropped it, a
 * draft) is never `empty`.
 */
//
// WHY anchored to the START of a hint row, never searched in the status row
// (#54 review round 2, A, B and C): the status row carries the cwd, which is
// user-controlled. A folder named `for shortcuts` forged `empty` over an
// attached image, and one named `to queue message` forged `drafted`. The
// hints are the LEFT side of the footer row below the status row (0.157), or
// the queue row itself (0.149.1); the right side is Codex's context (e.g.
// "⚠ 1 warning · f2 to view").
const EMPTY_HINT_ROW = /^ {2}(?:\S+ for agents · )?\S+ for shortcuts\b/u
const QUEUE_HINT_ROW = /^ {2}\S+ to queue(?: message)?\b/u

export function classifyCodexComposerState(rows: ReadonlyArray<ComposerCellRow> | null): CodexComposerState {
  if (!rows || rows.length === 0) return 'unknown'
  const text = rows.map(row => row.text.replace(/[ \t]+$/u, ''))
  const blank = (index: number) => (text[index] ?? '').trim() === ''
  const footerHead = (index: number) => STATUS_ROW.test(text[index] ?? '') || QUEUE_ROW.test(text[index] ?? '')
  let last = text.length - 1
  while (last >= 0 && blank(last)) last -= 1
  if (last < 1) return 'unknown'

  // The footer is the status (or queue) row, optionally followed by ONE more
  // provider row (0.157: hints and warnings). Nothing else may follow it.
  let status: number
  if (footerHead(last) && blank(last - 1)) status = last
  else if (!blank(last - 1) && footerHead(last - 1) && blank(last - 2)) status = last - 1
  else return 'unknown'
  const footer = text.slice(status, last + 1)
  if (footer.some(row => VIM_STATUS_SUFFIX.test(row))) return 'unknown'

  const separator = status - 1
  let marker = -1
  for (let index = separator - 1; index >= Math.max(0, separator - MAX_COMPOSER_ROWS); index -= 1) {
    if (MARKER_ROW.test(text[index]!)) { marker = index; break }
  }
  if (marker < 0) return 'unknown'

  for (let index = marker; index < separator; index += 1) {
    // An attachment label is real composer content even when it looks like
    // chrome: submitting would send an image the caller never saw.
    if (/\[Image #\d+\]/u.test(text[index]!)) return 'drafted'
    let seenMarker = index !== marker
    for (const cell of rows[index]!.cells) {
      if (!cell.chars.trim()) continue
      if (!seenMarker && cell.chars === '›') { seenMarker = true; continue }
      if (!cell.dim) return 'drafted'
    }
  }
  // Codex offers "tab to queue" only for a draft while a turn runs. The
  // footer head is either the status row (cwd: never searched) or the queue
  // row; rows below the head are Codex's hint rows.
  const hintRows = footer.slice(1)
  if (QUEUE_HINT_ROW.test(footer[0]!) || hintRows.some(row => QUEUE_HINT_ROW.test(row))) return 'drafted'
  return hintRows.some(row => EMPTY_HINT_ROW.test(row)) ? 'empty' : 'unknown'
}
