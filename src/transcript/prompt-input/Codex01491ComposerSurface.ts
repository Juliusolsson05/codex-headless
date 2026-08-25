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
const QUEUE_FOOTER = /^  tab to queue(?: message)?\s+\d+% context left\s*$/i
const IDLE_FOOTER = /^  \S.*\s·\s.+$/u

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

  const visibleBottom = rows.slice(Math.max(0, lastNonBlank - 14), lastNonBlank + 1)
  const visibleBottomText = visibleBottom.join('\n')
  if (/\bVim:\s+(?:Insert|Normal)\b/u.test(visibleBottomText)) {
    // WHY `/vim` can change the live editor after launch even though the issued
    // profile forces a non-Vim startup and removes the configurable toggle key.
    // The provider advertises that drift in the bottom status; treating it as a
    // normal composer would reinterpret modal commands as literal prompt text.
    return { kind: 'unknown' }
  }
  if (isKnownNonComposerModal(visibleBottomText)) {
    return { kind: 'non-composer-modal' }
  }

  const composerRow = findComposerRow(rows, lastNonBlank)
  if (composerRow < 0) return { kind: 'unknown' }

  const separatorRow = rows.findIndex((row, index) => index > composerRow && row.trim() === '')
  if (separatorRow < 0 || separatorRow > lastNonBlank) return { kind: 'unknown' }

  const footerRows = rows
    .slice(separatorRow + 1, lastNonBlank + 1)
    .filter(row => row.trim() !== '')

  // WHY primary composer chrome has one summary/status row in the recorded
  // 0.149.1 layouts. Multiple nonblank rows below the draft are an overlay or
  // popup we have not classified. Guessing "still composer" would route Enter
  // or Tab through controls that get first refusal upstream.
  if (footerRows.length !== 1 ||
    (!IDLE_FOOTER.test(bottom) && !QUEUE_FOOTER.test(bottom))) {
    // WHY position alone is not enough: once the composer disappears, a user
    // message can scroll to the physical bottom and contain its own `›` plus
    // blank line. Requiring one of the two recorded provider footers prevents
    // that transcript shape from becoming Enter evidence. The footer remains
    // structural rather than semantic—its path/model text is never retained.
    return { kind: 'unknown' }
  }

  const draftRows = rows.slice(composerRow, separatorRow)
  const draftText = extractDraftText(draftRows, frame.cols)
  if (draftText === null) return { kind: 'unknown' }

  return {
    kind: 'primary-composer',
    draftText,
    queueWithTab: QUEUE_FOOTER.test(bottom),
  }
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

function extractDraftText(rows: readonly string[], cols: number): string | null {
  if (rows.length === 0) return null
  const first = rows[0] ?? ''
  if (!/^›(?: |$)/u.test(first)) return null

  const logicalRows = [first.replace(/^› ?/u, '')]
  for (const continuation of rows.slice(1)) {
    if (!/^  /u.test(continuation)) return null
    logicalRows.push(continuation.slice(2))
  }

  // WHY ratatui paints wrapped textarea rows itself, so xterm's `isWrapped`
  // bit cannot always distinguish a logical newline from a soft wrap. A nearly
  // full intermediate row is therefore ambiguous. Short recorded multiline
  // rows are exact logical lines; long wrapped drafts fail closed.
  const wrapThreshold = Math.max(1, cols - 6)
  if (logicalRows.slice(0, -1).some(row => [...row].length >= wrapThreshold)) {
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
  return /Do you trust the contents of this directory/i.test(text) ||
    /Press enter to continue/i.test(text) ||
    /Would you like to run the following command/i.test(text) ||
    /Yes, and don't ask again/i.test(text) ||
    /customize shortcuts with \/keymap/i.test(text)
}
