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
 * Callers must treat `unknown` as "cannot verify": it is NOT a refusal
 * signal for normal delivery (a false occupied blocks every prompt; the Claude
 * gate latched that way for 186 s once), and NOT consent where an empty
 * composer is required.
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
// A Vim status atom means the key semantics of the composer changed under us.
const VIM_STATUS_SUFFIX = / {2,}Vim: (?:Insert|Normal)$/u
const MARKER_ROW = /^›(?: |$)/u
// How far above the footer the marker may sit: the composer grows with a
// multi-line draft, but a marker further up is transcript, not composer.
const MAX_COMPOSER_ROWS = 12

export function classifyCodexComposerState(rows: ReadonlyArray<ComposerCellRow> | null): CodexComposerState {
  if (!rows || rows.length === 0) return 'unknown'
  const text = rows.map(row => row.text.replace(/[ \t]+$/u, ''))
  const blank = (index: number) => (text[index] ?? '').trim() === ''
  let last = text.length - 1
  while (last >= 0 && blank(last)) last -= 1
  if (last < 1) return 'unknown'

  // The footer is the status row, optionally followed by ONE more provider
  // row (0.157: shortcut hints and warnings). Nothing else may follow it.
  let status: number
  if (STATUS_ROW.test(text[last]!) && blank(last - 1)) status = last
  else if (!blank(last - 1) && STATUS_ROW.test(text[last - 1]!) && blank(last - 2)) status = last - 1
  else return 'unknown'
  if (VIM_STATUS_SUFFIX.test(text[status]!)) return 'unknown'

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
  return 'empty'
}
