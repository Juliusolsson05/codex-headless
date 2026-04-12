// Detect Codex's trust dialog from a screen snapshot.
//
// Codex shows this on first launch in a new directory:
//
//   > You are in /path/to/dir
//
//     Do you trust the contents of this directory? Working with
//     untrusted contents comes with higher risk of prompt injection.
//
//   › 1. Yes, continue
//     2. No, quit
//
//     Press enter to continue
//
// Detection: ALL required markers must be present. Conservative to
// avoid false-positiving on assistant text that mentions "trust".
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

// Every one of these must be present for a positive match.
const REQUIRED_MARKERS = [
  'Do you trust the contents of this directory',
  'Yes, continue',
  'No, quit',
] as const

/**
 * Detect Codex's trust dialog from a plain-text screen snapshot.
 *
 * Returns { visible: true, workspace, options } when the dialog is
 * on screen, { visible: false } otherwise. Called on every screen
 * frame (~10Hz in the debugger, ~60Hz in production), so it needs
 * to be cheap — early return on first missing marker.
 */
export function detectCodexTrustDialog(screen: string): CodexTrustDialogState {
  if (!screen) return { visible: false }

  for (const marker of REQUIRED_MARKERS) {
    if (!screen.includes(marker)) return { visible: false }
  }

  // Extract the workspace path. Codex renders it as:
  //   > You are in /path/to/dir
  // The `>` prefix + "You are in" is the anchor.
  let workspace: string | undefined
  const lines = screen.split('\n')
  for (const line of lines) {
    const match = line.match(/>\s*You are in\s+(.+)/)
    if (match) {
      workspace = match[1].trim()
      break
    }
  }

  const options = [
    { key: '1', label: 'Yes, continue' },
    { key: '2', label: 'No, quit' },
  ]

  return { visible: true, workspace, options }
}

/**
 * The keystroke to accept the trust dialog. Codex pre-selects
 * "Yes, continue" — pressing Enter confirms it.
 */
export const CODEX_TRUST_DIALOG_ACCEPT_KEYS = '\r'
