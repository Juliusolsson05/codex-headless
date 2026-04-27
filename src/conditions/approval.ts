import type { ScreenApproval } from '../parsers/ApprovalParser.js'
import type {
  CodexApprovalCondition,
  CodexApprovalMetadata,
  CodexApprovalState,
} from './types.js'

export function buildCodexApprovalCondition(
  state: ScreenApproval | null,
  metadata: CodexApprovalMetadata | null,
): CodexApprovalCondition | null {
  if (!state && !metadata) return null
  const fallbackMetadata = metadata ?? {
    callId: null,
    commandParts: [],
    workdir: null,
  }
  const mergedState: CodexApprovalState = state
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
  return {
    kind: 'codex.approval',
    state: mergedState,
    actions: [
      { kind: 'pty', id: 'approve', label: 'Approve', data: '\r' },
      { kind: 'pty', id: 'approve-always', label: 'Approve always', data: 'p' },
      { kind: 'pty', id: 'deny', label: 'Deny', data: '\x1b' },
    ],
  }
}
