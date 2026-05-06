import type { ScreenApproval } from '../parsers/ApprovalParser.js'
import type { CodexTrustDialogState } from '../parsers/TrustDialogParser.js'

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

export type ConditionPtyAction = {
  kind: 'pty'
  id: string
  label: string
  data: string
}

export type ConditionCustomAction = {
  kind: 'custom'
  id: string
  label: string
  name: string
}

export type ConditionAction = ConditionPtyAction | ConditionCustomAction

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

export type CodexSwitchModelPromptCondition = {
  kind: 'codex.switch-model-prompt'
  state: {
    visible: true
    message: string
    selectedIndex?: number
    options?: string[]
  }
  actions: ConditionAction[]
}

export type CodexCondition =
  | CodexTrustDialogCondition
  | CodexApprovalCondition
  | CodexSwitchModelPromptCondition

export type CodexConditionKind = CodexCondition['kind']

export type CodexConditionMap = Partial<{
  [K in CodexConditionKind]: Extract<CodexCondition, { kind: K }>
}>

export type CodexConditionSnapshot = {
  provider: 'codex'
  conditions: CodexConditionMap
  ts: number
}
