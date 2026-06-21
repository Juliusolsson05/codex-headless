import {
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  type CodexTrustDialogState,
} from '../parsers/TrustDialogParser.js'
import { defineModule } from './core/contract.js'
import type { ConditionAction } from './core/contract.js'
import type { CodexConditionInputs, CodexTrustDialogCondition } from './types.js'

// The trust-dialog actions. Pulled into a module-level constant so BOTH the new
// module (`trustDialogModule.actions`) and the legacy
// `buildCodexTrustDialogCondition` builder below hand back the EXACT same array
// — byte-for-byte identical serialized output is this migration's whole
// acceptance test. The accept keystroke is sourced from the parser
// (CODEX_TRUST_DIALOG_ACCEPT_KEYS) so the keystroke contract with the real Codex
// TUI lives in one place; the reject keystroke '2\r' is the literal "Quit"
// menu-index keystroke.
const TRUST_DIALOG_ACTIONS: ConditionAction[] = [
  { kind: 'pty', id: 'accept', label: 'Trust folder', data: CODEX_TRUST_DIALOG_ACCEPT_KEYS },
  { kind: 'pty', id: 'reject', label: 'Quit', data: '2\r' },
]

// trustDialogModule — the headless-module form of the trust-dialog condition.
//
// `detect` takes the WHOLE input bundle and reaches into `inputs.trustDialog`,
// returning that state object VERBATIM when visible and null otherwise. Returning
// the same object reference the old builder embedded (not a copy) is what keeps
// the serialized `state` byte-identical — the previous `buildCodexTrustDialogCondition`
// also stored `state` as-is.
//
// ORDER MATTERS at the registration site (see modules.ts): trust is inserted
// before approval, and JSON.stringify of the conditions map serializes in
// insertion order, so the module list order is part of the wire contract.
export const trustDialogModule = defineModule<
  'codex.trust-dialog',
  CodexConditionInputs,
  CodexTrustDialogState
>({
  kind: 'codex.trust-dialog',
  detect: (inputs) => (inputs.trustDialog.visible ? inputs.trustDialog : null),
  actions: () => TRUST_DIALOG_ACTIONS,
})

// Legacy builder, re-implemented on top of the module so any external importer
// (or the re-export in index.ts) keeps working unchanged. The module's erased
// record is structurally identical to the typed CodexTrustDialogCondition.
export function buildCodexTrustDialogCondition(
  state: CodexTrustDialogState,
): CodexTrustDialogCondition | null {
  const detected = trustDialogModule.detect({
    trustDialog: state,
    approval: null,
    approvalMetadata: null,
  })
  if (detected === null) return null
  return {
    kind: 'codex.trust-dialog',
    state: detected,
    actions: trustDialogModule.actions(detected),
  }
}
