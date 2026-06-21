export {
  evaluateCodexConditions,
  codexConditionSnapshotKey,
  type CodexConditionInputs,
} from './evaluateCodexConditions.js'
export { approvalModule, buildCodexApprovalCondition } from './approval.js'
export { trustDialogModule, buildCodexTrustDialogCondition } from './trustDialog.js'
export { CODEX_MODULES } from './modules.js'

// Re-export the generic headless evaluator from the vendored core so consumers
// that want to drive Codex conditions through the registry (e.g. CodexHeadless's
// long-lived latch) import it from the conditions barrel rather than reaching
// into ./core directly.
export { makeEvaluator } from './core/evaluator.js'
export type { ConditionEvaluator } from './core/evaluator.js'

export type {
  CodexApprovalCondition,
  CodexApprovalMetadata,
  CodexApprovalState,
  CodexCondition,
  CodexConditionKind,
  CodexConditionMap,
  CodexConditionSnapshot,
  CodexSwitchModelPromptCondition,
  CodexTrustDialogCondition,
  ConditionAction,
  ConditionCustomAction,
  ConditionPtyAction,
} from './types.js'
