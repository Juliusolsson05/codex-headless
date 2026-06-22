import type { ScreenApproval } from '../parsers/ApprovalParser.js'
import type { CodexTrustDialogState } from '../parsers/TrustDialogParser.js'
import type { ConditionAction } from './core/contract.js'

export type CodexApprovalMetadata = {
  callId: string | null
  commandParts: string[]
  workdir: string | null
}

export type CodexApprovalState = ScreenApproval & {
  callId?: string | null
  commandParts?: string[]
  workdir?: string | null
}

// Re-export the wire action union from the vendored core instead of maintaining
// a local copy. The custom action shape gained `payload?: unknown` for the
// conditions resolver path; duplicating it here made Codex's public barrel drift
// from the package's own core contract even though Codex does not emit a custom
// action today.
export type {
  ConditionAction,
  ConditionPtyAction,
  ConditionCustomAction,
} from './core/contract.js'

export type CodexTrustDialogCondition = {
  kind: 'codex.trust-dialog'
  state: CodexTrustDialogState
  actions: ConditionAction[]
}

export type CodexApprovalCondition = {
  kind: 'codex.approval'
  state: CodexApprovalState
  actions: ConditionAction[]
}

export type CodexCondition =
  | CodexTrustDialogCondition
  | CodexApprovalCondition

export type CodexConditionKind = CodexCondition['kind']

export type CodexConditionMap = Partial<{
  [K in CodexConditionKind]: Extract<CodexCondition, { kind: K }>
}>

export type CodexConditionSnapshot = {
  provider: 'codex'
  conditions: CodexConditionMap
  ts: number
}

// The per-tick input bundle every Codex condition module detects against.
//
// WHY it lives in types.ts (not evaluateCodexConditions.ts where it used to).
// The modules (trustDialog.ts, approval.ts) need this type, and they are imported
// BY evaluateCodexConditions.ts. If the type stayed in evaluateCodexConditions.ts
// the modules would import it from there while it imports the modules — a cycle.
// types.ts is the leaf both sides already depend on, so it's the cycle-free home.
// evaluateCodexConditions.ts re-exports it so its old import path keeps working.
export type CodexConditionInputs = {
  trustDialog: CodexTrustDialogState
  approval: ScreenApproval | null
  approvalMetadata?: CodexApprovalMetadata | null
}
