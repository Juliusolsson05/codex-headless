import {
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  CODEX_TRUST_DIALOG_DECLINE_KEYS,
  CODEX_TRUST_DIALOG_FOLDER_ACCESS_ACCEPT_KEYS,
  CODEX_TRUST_DIALOG_FOLDER_ACCESS_DECLINE_KEYS,
  type CodexTrustDialogState,
} from '../parsers/TrustDialogParser.js'
import { defineModule } from './core/contract.js'
import type { ConditionAction } from './core/contract.js'
import type { CodexConditionInputs, CodexTrustDialogCondition } from './types.js'

// The trust-dialog action TEMPLATE. This holds the action DATA only — every
// `actions()` call clones it into a FRESH array of FRESH objects (see the module
// below).
//
// The ids/labels/order are a wire contract and must not change casually. The
// KEYSTROKES were also frozen on that basis, and that was wrong: they were
// simply incorrect, and a frozen-bytes rule that preserves a bug is not a
// contract worth keeping. They changed here deliberately, verified against a
// live codex-cli 0.145.0 dialog — see the parser for the full rationale and
// the commit for the blast-radius assessment (effectively nil: the remote
// path matches actions against the live snapshot it just broadcast, and the
// phone echoes back the action object it received rather than composing
// bytes).
//
// WHY fresh-per-call and not just return this array directly.
// The conditions-core isolation contract says an emitted snapshot's `actions`
// must be private to that snapshot: a consumer that mutates a returned action
// (e.g. patches `actions[0].data` before dispatching) must NOT poison the next
// evaluation. The OLD `buildCodexTrustDialogCondition` allocated a fresh array
// of fresh object literals on every call, so it had this property for free. An
// earlier cut of this module handed back this shared module-level array of
// shared objects directly, which silently regressed that contract — one
// mutation would leak into every future snapshot. Keeping the DATA module-level
// (one source of truth for ids/labels/keystrokes) but cloning per call restores
// the old freshness without re-typing the literals at the call site.
//
// `readonly` marks the template as not-for-mutation; the per-call clone is what
// callers receive and may freely own. BOTH keystrokes are now sourced from the
// parser so the contract with the real Codex TUI lives in exactly one place.
//
// The bytes changed here, deliberately, and the "byte-for-byte wire contract"
// note above no longer holds for this literal. Accept was '\r' (confirm
// whatever is HIGHLIGHTED) and is now '1' (select "Yes, continue"
// unconditionally); reject was '2\r' and is now '2', because upstream acts on
// the digit immediately and the trailing Enter leaked into the next screen.
// Both were verified against a live codex-cli 0.145.0 dialog. See the parser
// for the full rationale.
const TRUST_DIALOG_ACTIONS: readonly ConditionAction[] = [
  { kind: 'pty', id: 'accept', label: 'Trust folder', data: CODEX_TRUST_DIALOG_ACCEPT_KEYS },
  { kind: 'pty', id: 'reject', label: 'Quit', data: CODEX_TRUST_DIALOG_DECLINE_KEYS },
]

// #65: the template above is the LEGACY layout's actions, and it is only the
// fallback now. Codex 0.156+ paints a different dialog whose keystrokes differ
// (`1` merely moves the highlight there, so accept is `1` + Enter) and whose
// option labels vary: option 2 is "Back to Agent Command Center" when Codex
// is connected to its background server, and option 1 is "Open restricted" for
// a folder saved as untrusted. The parser reports both per frame, so the
// actions follow the screen that is actually up. A fixed "Quit" button that
// in fact returned to the overview, or a fixed "Trust folder" that in fact
// opened the folder restricted, would tell the user something false.
//
// The action ids stay `accept` / `reject`: those are what the app and the
// phone key on. Only `label` and `data` follow the state.
function trustDialogActions(state: CodexTrustDialogState): ConditionAction[] {
  if (state.layout !== 'folder-access') return TRUST_DIALOG_ACTIONS.map((a) => ({ ...a }))
  const label = (key: string, fallback: string) =>
    state.options?.find((option) => option.key === key)?.label ?? fallback
  return [
    { kind: 'pty', id: 'accept', label: label('1', 'Trust and continue'), data: state.acceptKeys ?? CODEX_TRUST_DIALOG_FOLDER_ACCESS_ACCEPT_KEYS },
    { kind: 'pty', id: 'reject', label: label('2', 'Quit'), data: state.declineKeys ?? CODEX_TRUST_DIALOG_FOLDER_ACCESS_DECLINE_KEYS },
  ]
}

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
  // Fresh array of fresh objects per call — see TRUST_DIALOG_ACTIONS: the
  // isolation contract requires a mutated snapshot not to poison later ones.
  // `{ ...a }` is a sufficient clone because ConditionAction fields are all
  // primitives (no nested objects to share).
  // Each call builds new objects (see trustDialogActions), so the isolation
  // contract above still holds.
  actions: (state) => trustDialogActions(state),
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
