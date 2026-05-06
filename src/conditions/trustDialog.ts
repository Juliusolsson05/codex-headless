import {
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  type CodexTrustDialogState,
} from '../parsers/TrustDialogParser.js'
import type { CodexTrustDialogCondition } from './types.js'

export function buildCodexTrustDialogCondition(
  state: CodexTrustDialogState,
): CodexTrustDialogCondition | null {
  if (!state.visible) return null
  return {
    kind: 'codex.trust-dialog',
    state,
    actions: [
      { kind: 'pty', id: 'accept', label: 'Trust folder', data: CODEX_TRUST_DIALOG_ACCEPT_KEYS },
      { kind: 'pty', id: 'reject', label: 'Quit', data: '2\r' },
    ],
  }
}
