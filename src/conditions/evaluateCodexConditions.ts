import type { ScreenApproval } from '../parsers/ApprovalParser.js'
import type { CodexTrustDialogState } from '../parsers/TrustDialogParser.js'
import { buildCodexApprovalCondition } from './approval.js'
import { buildCodexTrustDialogCondition } from './trustDialog.js'
import type {
  CodexApprovalMetadata,
  CodexConditionMap,
  CodexConditionSnapshot,
} from './types.js'

export type CodexConditionInputs = {
  trustDialog: CodexTrustDialogState
  approval: ScreenApproval | null
  approvalMetadata?: CodexApprovalMetadata | null
}

export function evaluateCodexConditions(
  inputs: CodexConditionInputs,
): CodexConditionSnapshot {
  const conditions: CodexConditionMap = {}

  const trustDialog = buildCodexTrustDialogCondition(inputs.trustDialog)
  if (trustDialog) conditions[trustDialog.kind] = trustDialog

  const approval = buildCodexApprovalCondition(
    inputs.approval,
    inputs.approvalMetadata ?? null,
  )
  if (approval) conditions[approval.kind] = approval

  return {
    provider: 'codex',
    conditions,
    ts: Date.now(),
  }
}

export function codexConditionSnapshotKey(
  snapshot: CodexConditionSnapshot,
): string {
  return JSON.stringify(snapshot.conditions)
}
