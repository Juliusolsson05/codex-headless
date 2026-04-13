// Detect Codex's approval overlay from the plain-text screen buffer.
//
// When Codex needs user approval to run a command, it draws a bottom-pane
// modal with a title, the command, and selectable options. We detect this
// by matching the known title strings from codex-rs/tui/src/bottom_pane/
// approval_overlay.rs and extract the command from the "$ <command>" line.
//
// This is more reliable than waiting for the rollout JSONL event because
// the event may not be emitted to the file before the screen updates.

const APPROVAL_TITLES = [
  'Would you like to run the following command?',
  'Would you like to make the following edits?',
  'Would you like to grant these permissions?',
  'Do you want to approve network access',
]

export type ScreenApproval = {
  title: string
  reason: string | null
  command: string | null
  /** The actual option labels parsed from screen, including dynamic
   *  text like "don't ask again for commands that start with `git add`".
   *  Each entry is the full label text (without the leading "N. "). */
  options: string[]
  /** Which option is currently selected (0-indexed), based on the
   *  `›` marker position on screen. */
  selectedIndex: number
}

/**
 * Detect the Codex approval overlay from a screen snapshot.
 * Returns parsed approval info if the overlay is visible, null otherwise.
 */
export function detectCodexApproval(screen: string): ScreenApproval | null {
  if (!screen) return null

  let matchedTitle: string | null = null
  for (const title of APPROVAL_TITLES) {
    if (screen.includes(title)) {
      matchedTitle = title
      break
    }
  }
  if (!matchedTitle) return null

  const lines = screen.split('\n')
  const titleIdx = lines.findIndex(l => l.includes(matchedTitle!))

  // Extract reason from "Reason: <text>" line after the title.
  let reason: string | null = null
  let command: string | null = null
  const options: string[] = []
  let selectedIndex = 0

  if (titleIdx >= 0) {
    for (let i = titleIdx + 1; i < Math.min(titleIdx + 20, lines.length); i++) {
      const line = lines[i] ?? ''

      // Reason line: "  Reason: <text>"
      const reasonMatch = line.match(/Reason:\s+(.+)/)
      if (reasonMatch) {
        reason = reasonMatch[1].trim()
        continue
      }

      // Command line: "  $ <command>"
      const cmdMatch = line.match(/\$\s+(.+)/)
      if (cmdMatch && !command) {
        command = cmdMatch[1].trim()
        continue
      }

      // Option lines: "› N. <label> (key)" or "  N. <label> (key)"
      // The `›` marker indicates the selected option.
      const optMatch = line.match(/^\s*(›?)\s*(\d+)\.\s+(.+)/)
      if (optMatch) {
        const isSelected = optMatch[1] === '›'
        // Strip the trailing shortcut hint "(y)", "(p)", "(esc)" etc.
        const label = optMatch[3].replace(/\s*\([a-z]+\)\s*$/, '').trim()
        if (isSelected) selectedIndex = options.length
        options.push(label)
      }
    }
  }

  return { title: matchedTitle, reason, command, options, selectedIndex }
}

/**
 * Returns true if the approval overlay is visible on screen.
 * Lighter check than detectCodexApproval — just title matching.
 */
export function isApprovalOverlayVisible(screen: string): boolean {
  return APPROVAL_TITLES.some(t => screen.includes(t))
}
