import type { StableTerminalFrame } from '../../terminal/HeadlessTerminal.js'

export type Codex01491ComposerSurface =
  | {
      kind: 'primary-composer'
      draftText: string
      queueWithTab: boolean
    }
  | { kind: 'history-search' }
  | { kind: 'completion-popup' }
  | { kind: 'non-composer-modal' }
  | { kind: 'unknown' }

const PLACEHOLDER = 'Ask Codex to do anything'
const HISTORY_FOOTER = /^\s{2}reverse-i-search:/i
const COMPLETION_FOOTER = /^\s{2}Press enter to insert or esc to close\s*$/i
// WHY a two-row footer shape (#63). In 0.157.1's fullscreen mode, the default
// and how Agent Code launches Codex, the bottom pane has room for BOTH the
// status line and footer.rs's instructional row under it: "? for shortcuts"
// while idle, "tab to queue message" (or, when narrow, "tab to queue") when
// Tab would queue the draft. Both are recorded in
// codex-01571-fullscreen-recorded.json. Only these exact instructional rows
// are accepted (an optional right-aligned context percentage allowed).
// footer.rs has more variants (agent hints, the collaboration-mode indicator,
// the cycle hint), and any of those makes the pane `unknown`, which declines
// evidence rather than guessing.
const FULLSCREEN_SHORTCUTS_HINT = /^  \? for shortcuts(?: {2,}\d+% context left)?$/u
const FULLSCREEN_QUEUE_HINT = /^  tab to queue(?: message)?(?: {2,}\d+% context left)?$/u

// WHY a second popup shape (#63): 0.157.1 moved the skill/mention popup ABOVE
// the composer (skill_popup.rs at rust-v0.157.1; recorded in the 0.157.1
// corpus) and dropped the 0.149.1 footer string entirely: the popup's hint
// row, then a blank row, then the composer. Below the composer the pane
// then looks exactly like an idle composer with a draft, so without this check
// Enter in the popup (which INSERTS a completion) would be recorded as
// submitting the draft, the plausible wrong prompt this parser exists to
// refuse. A transcript line that happens to read like the hint just above the
// composer only makes us decline, which is the safe direction.
const COMPLETION_HINT_ABOVE_COMPOSER = /^\s{2}enter(?:\/tab)? insert · esc close(?: · .*)?$/i
const QUEUE_FOOTER = /^  tab to queue(?: message)?\s+\d+% context left\s*$/i
const IDLE_FOOTER = /^  \S.*\s·\s.+$/u
// The 0.156+ trust dialog's key hint (#63, codex-headless#65). Codex paints it
// as the dialog's LAST row, where a composer paints its status footer, and it
// also has the IDLE_FOOTER shape ("  enter continue · esc quit"). Without this
// check the dialog was read as a composer whose "draft" is
// "1. Trust and continue". It is matched on the bottom row only (one wrap
// allowed: the Windows "… and create sandbox ·" hint wraps below 46 columns),
// so the same words typed into a draft are never mistaken for it.
const TRUST_HINT_FOOTER = /^\s*enter continue(?: and create sandbox)?\s*·\s*esc (?:quit|back)\s*$/i
// Codex 0.149.1 renders Vim mode as a distinct right-hand status atom, with a
// run of layout padding before the atom and no content after it. A cwd ending
// in `/Vim: Insert` is part of the left status value and has neither boundary.
// Keeping this anchored is critical: paths and drafts are attacker-controlled.
const VIM_STATUS_SUFFIX = / {2,}Vim: (?:Insert|Normal)$/u

/**
 * Classify only Codex 0.149.1's current bottom pane.
 *
 * WHY this parser walks upward from the final rendered rows: transcript content
 * is attacker-controlled and can contain every footer phrase. The active TUI
 * owns the bottom pane, while historical transcript rows sit above it. A global
 * substring search therefore turns prompt prose into authorization; an anchored
 * bottom-pane shape keeps prose as prose.
 */
export function classifyCodex01491ComposerSurface(
  frame: StableTerminalFrame | null,
): Codex01491ComposerSurface {
  if (!frame || frame.rows.length === 0) return { kind: 'unknown' }

  const rows = frame.rows.map(row => row.text.replace(/[ \t]+$/u, ''))
  const lastNonBlank = findPreviousNonBlank(rows, rows.length - 1)
  if (lastNonBlank < 0) return { kind: 'unknown' }

  const bottom = rows[lastNonBlank] ?? ''
  if (HISTORY_FOOTER.test(bottom)) return { kind: 'history-search' }
  if (COMPLETION_FOOTER.test(bottom)) return { kind: 'completion-popup' }
  const aboveBottom = rows[lastNonBlank - 1] ?? ''
  if (TRUST_HINT_FOOTER.test(bottom) ||
    (aboveBottom.trim() !== '' && TRUST_HINT_FOOTER.test(`${aboveBottom.trim()} ${bottom.trim()}`))) {
    return { kind: 'non-composer-modal' }
  }

  const composerRow = findComposerRow(rows, lastNonBlank)
  if (composerRow >= 2 && (rows[composerRow - 1] ?? '').trim() === '' &&
    COMPLETION_HINT_ABOVE_COMPOSER.test(rows[composerRow - 2] ?? '')) {
    return { kind: 'completion-popup' }
  }
  if (composerRow >= 0) {
    const separatorRow = rows.findIndex((row, index) =>
      index > composerRow && row.trim() === '',
    )
    if (separatorRow >= 0 && separatorRow <= lastNonBlank) {
      const footerRows = rows
        .slice(separatorRow + 1, lastNonBlank + 1)
        .filter(row => row.trim() !== '')

      // WHY draft text and cwd text are attacker-controlled, so sentinel words
      // cannot be interpreted until the surrounding bottom pane proves what
      // owns them. A primary composer has exactly one anchored provider footer;
      // genuine trust/approval overlays have option rows plus their own footer
      // and therefore fall through to modal classification below.
      // One footer row (0.149.1, and 0.157.1 inline), or the 0.157.1
      // fullscreen pair: status line, then an exact instructional row.
      const footer = footerRows.length === 1 &&
        (IDLE_FOOTER.test(bottom) || QUEUE_FOOTER.test(bottom))
        ? { status: bottom, queueWithTab: QUEUE_FOOTER.test(bottom) }
        : footerRows.length === 2 && IDLE_FOOTER.test(footerRows[0]!) &&
            (FULLSCREEN_SHORTCUTS_HINT.test(footerRows[1]!) || FULLSCREEN_QUEUE_HINT.test(footerRows[1]!))
          ? { status: footerRows[0]!, queueWithTab: FULLSCREEN_QUEUE_HINT.test(footerRows[1]!) }
          : null
      if (footer) {
        if (VIM_STATUS_SUFFIX.test(footer.status)) {
          // WHY `/vim` can change the live editor after launch even though the
          // issued profile forces a non-Vim startup. Only the provider's
          // right-separated footer atom proves that drift; the same words in a
          // cwd or draft remain ordinary content.
          return { kind: 'unknown' }
        }

        const draftRows = frame.rows.slice(composerRow, separatorRow)
        const draftText = extractDraftText(draftRows, frame.cols)
        if (draftText === null) return { kind: 'unknown' }
        if (draftMayOpenPopup(draftText)) return { kind: 'completion-popup' }

        return {
          kind: 'primary-composer',
          draftText,
          queueWithTab: footer.queueWithTab,
        }
      }
    }
  }

  // Modal sentinels are consulted only after the bottom pane has failed the
  // complete composer/footer structure. Searching before this point lets a
  // normal prompt containing trust prose revoke its own submission evidence.
  const visibleBottom = rows.slice(Math.max(0, lastNonBlank - 14), lastNonBlank + 1)
  if (isKnownNonComposerModal(visibleBottom.join('\n'))) {
    return { kind: 'non-composer-modal' }
  }

  return { kind: 'unknown' }
}

function findComposerRow(rows: readonly string[], lastNonBlank: number): number {
  // WHY limit the search to the physical bottom-pane neighborhood. Choosing the
  // last transcript user message after the actual composer has disappeared
  // would manufacture a draft during a full-screen modal or startup view.
  const firstCandidate = Math.max(0, lastNonBlank - 14)
  for (let index = lastNonBlank; index >= firstCandidate; index -= 1) {
    if (/^›(?: |$)/u.test(rows[index] ?? '')) return index
  }
  return -1
}

function extractDraftText(
  rows: StableTerminalFrame['rows'],
  cols: number,
): string | null {
  if (rows.length === 0) return null
  const first = rows[0]?.text.replace(/[ \t]+$/u, '') ?? ''
  if (!/^›(?: |$)/u.test(first)) return null

  const logicalRows = [first.replace(/^› ?/u, '')]
  for (const row of rows.slice(1)) {
    const continuation = row.text.replace(/[ \t]+$/u, '')
    if (!/^  /u.test(continuation)) return null
    logicalRows.push(continuation.slice(2))
  }

  // WHY ratatui paints wrapped textarea rows itself, so xterm's `isWrapped`
  // bit cannot always distinguish a logical newline from a soft wrap. A nearly
  // full intermediate row is therefore ambiguous. Short recorded multiline
  // rows are exact logical lines; long wrapped drafts fail closed.
  const lastUnambiguousColumn = Math.max(0, cols - 6)
  if (rows.slice(0, -1).some(row => {
    // WHY terminal geometry lives in physical cells, not JavaScript strings.
    // xterm stores a double-width glyph in one cell followed by an empty
    // continuation cell; counting code points makes a physically full CJK row
    // appear half empty and converts the next textarea row into a logical LF.
    // The continuation and an ordinary trailing blank are indistinguishable in
    // this provider-neutral snapshot, so the boundary is deliberately one cell
    // conservative. Ambiguity suppresses ownership evidence but never blocks
    // the terminal or the user's actual submission.
    for (let column = Math.min(cols, row.cells.length) - 1;
      column >= 0; column -= 1) {
      if (row.cells[column] !== '') return column >= lastUnambiguousColumn
    }
    return false
  })) {
    return null
  }

  const text = logicalRows.join('\n')
  return text === PLACEHOLDER ? '' : text
}

function findPreviousNonBlank(rows: readonly string[], from: number): number {
  for (let index = from; index >= 0; index -= 1) {
    if ((rows[index] ?? '').trim() !== '') return index
  }
  return -1
}

function isKnownNonComposerModal(text: string): boolean {
  // The 0.156+ trust dialog is recognised structurally by TRUST_HINT_FOOTER
  // before this point, since its hint is always the pane's last row.
  return /Do you trust the contents of this directory/i.test(text) ||
    /Press enter to continue/i.test(text) ||
    /Would you like to run the following command/i.test(text) ||
    /Yes, and don't ask again/i.test(text) ||
    /customize shortcuts with \/keymap/i.test(text)
}

// WHY decline on the DRAFT, not only on a visible popup (review a of
// codex-headless#69). Codex 0.157.1 paints every popup above the composer:
// the slash-command and file popups carry no hint row at all, and a short
// skill popup omits its hint. A frame with a popup open is therefore
// indistinguishable, from the pane alone, from an idle composer holding the
// same draft. Enter there selects or inserts the popup item (dispatches
// `/status`, inserts a file path) and submits nothing. Recorded in
// codex-01571-*recorded.json: `slash-popup-enter-selects-command` and
// `file-popup-enter-inserts-mention`.
//
// Codex opens these popups from the draft itself: a leading `/` for
// commands, and an `@` or `$` token for file, mention and skill search
// (chat_composer.rs, rust-v0.157.1). So a draft that could have one open never
// yields prompt evidence. This is deliberately fail-closed. A real prompt
// that starts with `/`, or mentions `$HOME` or `a@b`, becomes a safe miss
// (ownership falls back to the proxy path) rather than risking a false
// prompt, which could claim a sibling rollout.
function draftMayOpenPopup(draft: string): boolean {
  if (draft.trimStart().startsWith('/')) return true
  // Any token that STARTS with the sigil, including the bare sigil itself: the
  // popup opens on `@` / `$` before a single character follows it.
  return /(?:^|\s)[@$]/u.test(draft)
}
