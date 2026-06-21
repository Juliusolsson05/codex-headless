import type { ScreenApproval } from '../parsers/ApprovalParser.js'
import { defineModule } from './core/contract.js'
import type { ConditionAction } from './core/contract.js'
import type {
  CodexApprovalCondition,
  CodexApprovalMetadata,
  CodexApprovalState,
  CodexConditionInputs,
} from './types.js'

// The approval action TEMPLATE — DATA only; `actions()` clones it into a fresh
// array of fresh objects per call (see the isolation rationale on the trust
// dialog's TRUST_DIALOG_ACTIONS, which applies identically here). The exact
// ids/labels/keystrokes/order are a wire contract: the migration is byte-for-byte
// (verified out-of-band by a throwaway byte-for-byte comparison of the OLD and
// NEW serialized snapshots — not committed, per the repo's no-committed-tests
// policy), so nothing in this literal may change.
//
// The keystrokes are the contract with the real Codex approval overlay:
//   '\r'   = accept the highlighted "Approve" choice
//   'p'    = the "Approve always (for this session)" hotkey
//   '\x1b' = ESC, which Codex maps to "Deny"
const APPROVAL_ACTIONS: readonly ConditionAction[] = [
  { kind: 'pty', id: 'approve', label: 'Approve', data: '\r' },
  { kind: 'pty', id: 'approve-always', label: 'Approve always', data: 'p' },
  { kind: 'pty', id: 'deny', label: 'Deny', data: '\x1b' },
]

// mergeApprovalState — the TWO-SOURCE MERGE that is the delicate heart of this
// condition, lifted verbatim from the old `buildCodexApprovalCondition`.
//
// WHY two sources. An approval can be known from EITHER:
//   (a) the parsed SCREEN (`inputs.approval`, a ScreenApproval): what the Codex
//       TUI is currently rendering — title/reason/command/options/selectedIndex; OR
//   (b) the ROLLOUT METADATA (`inputs.approvalMetadata`): callId + commandParts +
//       workdir derived from the `exec_approval_request` rollout event, which can
//       arrive BEFORE the screen paints (or persist after).
// The condition is live if EITHER source is present. When the screen is present
// we layer metadata fields on top of it; when ONLY metadata is present we
// synthesize a minimal screen-shaped state from it. The exact field precedence
// (`command: state.command ?? commandParts.join(' ')`, etc.) is preserved
// EXACTLY — changing it would change the serialized bytes (the migration was
// verified out-of-band by a throwaway byte-for-byte comparison, not committed,
// per the repo's no-committed-tests policy).
function mergeApprovalState(
  state: ScreenApproval | null,
  metadata: CodexApprovalMetadata | null,
): CodexApprovalState | null {
  // The detector's null condition: neither source present → not live.
  if (!state && !metadata) return null
  const fallbackMetadata = metadata ?? {
    callId: null,
    commandParts: [],
    workdir: null,
  }
  return state
    ? {
        ...state,
        callId: fallbackMetadata.callId,
        command: state.command ?? fallbackMetadata.commandParts.join(' '),
        commandParts: fallbackMetadata.commandParts,
        workdir: fallbackMetadata.workdir,
      }
    : {
        title: 'Would you like to run the following command?',
        reason: null,
        command: fallbackMetadata.commandParts.join(' '),
        options: [],
        selectedIndex: 0,
        callId: fallbackMetadata.callId,
        commandParts: fallbackMetadata.commandParts,
        workdir: fallbackMetadata.workdir,
      }
}

// approvalModule — the headless-module form of the approval condition.
//
// `detect` runs the two-source merge over the whole input bundle. Returning the
// merged state (or null) IS the old builder's null/non-null decision, so the
// evaluator skips/keeps the record on exactly the same condition as before.
export const approvalModule = defineModule<
  'codex.approval',
  CodexConditionInputs,
  CodexApprovalState
>({
  kind: 'codex.approval',
  detect: (inputs) =>
    mergeApprovalState(inputs.approval, inputs.approvalMetadata ?? null),
  // Fresh array of fresh objects per call — see APPROVAL_ACTIONS: the isolation
  // contract requires a mutated snapshot not to poison later ones. `{ ...a }` is
  // a sufficient clone because ConditionAction fields are all primitives.
  actions: () => APPROVAL_ACTIONS.map((a) => ({ ...a })),
})

// Legacy builder, re-implemented on top of the module. Same signature as before
// (takes the screen state + metadata directly) so external callers and the
// index.ts re-export are unchanged.
export function buildCodexApprovalCondition(
  state: ScreenApproval | null,
  metadata: CodexApprovalMetadata | null,
): CodexApprovalCondition | null {
  const merged = approvalModule.detect({
    trustDialog: { visible: false },
    approval: state,
    approvalMetadata: metadata,
  })
  if (merged === null) return null
  return {
    kind: 'codex.approval',
    state: merged,
    actions: approvalModule.actions(merged),
  }
}
