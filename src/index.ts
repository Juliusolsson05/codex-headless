// codex-headless — programmatic control of OpenAI Codex via headless terminal.
//
// Mirrors claude-code-headless API surface where possible. Provider-specific
// differences (different screen parser, different transcript format, different
// command set) live in the parsers and transcript modules.

// --- Main API ---
export {
  CodexHeadless,
  type CodexHeadlessOptions,
  type CodexHeadlessEvents,
  type CodexHeadlessEvent,
  type CodexActivityEvent,
  type CodexIdleEvent,
  type CodexScreenEvent,
  type CodexRolloutEntryEvent,
  type CodexTrustDialogEvent,
  type CodexExitEvent,
} from './CodexHeadless.js'

// --- Terminal (shared primitive, identical to claude-code-headless) ---
export {
  HeadlessTerminal,
  type HeadlessTerminalOptions,
  type HeadlessTerminalEvents,
  type ScreenSnapshot,
  terminalToMarkdown,
} from './terminal/HeadlessTerminal.js'

// --- Parsers (codex-specific) ---
export {
  type CodexWorkingState,
  detectCodexWorkingState,
  extractCodexStreamingText,
  extractCodexAssistantInProgress,
  detectCodexActivity,
  isCodexChromeLine,
  isCodexDividerLine,
  isCodexPromptLine,
  isCodexUserPromptLine,
  isCodexStatusLine,
  isCodexIntermediateChromeLine,
} from './parsers/ScreenParser.js'

export {
  detectCodexApproval,
  isApprovalOverlayVisible,
  type ScreenApproval,
} from './parsers/ApprovalParser.js'

export {
  diffLines,
  type DiffLine,
} from './parsers/LineDiff.js'

export {
  detectCodexTrustDialog,
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  type CodexTrustDialogState,
} from './parsers/TrustDialogParser.js'

// --- Session directory + listing ---
export {
  getCodexHome,
  getCodexSessionsDir,
} from './transcript/ProjectDir.js'

export {
  listCodexSessions,
  type CodexSessionInfo,
} from './transcript/SessionList.js'

// --- Transcript (codex-specific) ---
export {
  // Rollout envelope
  type CodexRolloutLine,
  // RolloutItem variants
  type CodexSessionMeta,
  type CodexTurnContext,
  type CodexCompactedItem,
  // ResponseItem variants
  type CodexResponseItem,
  type CodexMessageItem,
  type CodexContentItem,
  type CodexFunctionCallItem,
  type CodexFunctionCallOutputItem,
  type CodexLocalShellCallItem,
  type CodexReasoningItem,
  type CodexCustomToolCallItem,
  type CodexCustomToolCallOutputItem,
  type CodexWebSearchCallItem,
  type CodexOtherItem,
  // EventMsg variants
  type CodexEventMsg,
  type CodexTurnStartedEvent,
  type CodexTurnCompleteEvent,
  type CodexUserMessageEvent,
  type CodexAgentMessageEvent,
  type CodexAgentMessageDeltaEvent,
  type CodexTokenCountEvent,
  type CodexExecCommandBeginEvent,
  type CodexExecCommandEndEvent,
  type CodexExecCommandOutputDeltaEvent,
  type CodexExecApprovalRequestEvent,
  type CodexMcpToolCallBeginEvent,
  type CodexMcpToolCallEndEvent,
  type CodexErrorEvent,
  // Type guards + helpers
  isCodexConversationEntry,
  isCodexResponseItem,
  isCodexEventMsg,
  isCodexSessionMeta,
  extractCodexMessageText,
  parseCodexFunctionArgs,
} from './transcript/TranscriptTypes.js'

// --- Channels (three-channel truth model) ---
//
// Subscribe to `codex.semantic`, `codex.screen`, and `codex.committed`
// on a CodexHeadless instance for the split surface. The `semantic`
// channel is authoritative-by-default — it is sourced from Codex's
// rollout `event_msg` deltas when available, and falls back to screen
// parsing only during the narrow window before the rollout file has
// caught up. Existing flat events (`screen`, `activity`, …) still
// fire for backwards compatibility.
export {
  SemanticChannel as CodexSemanticChannel,
  type SemanticChannelEvents as CodexSemanticChannelEvents,
} from './channels/SemanticChannel.js'
export {
  ScreenChannel as CodexScreenChannel,
  type ScreenChannelEvents as CodexScreenChannelEvents,
} from './channels/ScreenChannel.js'
export {
  CommittedChannel as CodexCommittedChannel,
  type CommittedChannelEvents as CodexCommittedChannelEvents,
} from './channels/CommittedChannel.js'
export type {
  SemanticSource as CodexSemanticSource,
  SemanticConfidence as CodexSemanticConfidence,
  SemanticEvent as CodexSemanticEvent,
  SemanticTurnStartedEvent as CodexSemanticTurnStartedEvent,
  SemanticTurnDeltaEvent as CodexSemanticTurnDeltaEvent,
  SemanticTurnCompletedEvent as CodexSemanticTurnCompletedEvent,
  SemanticSourceChangedEvent as CodexSemanticSourceChangedEvent,
  SemanticToolStartedEvent as CodexSemanticToolStartedEvent,
  SemanticToolOutputDeltaEvent as CodexSemanticToolOutputDeltaEvent,
  SemanticToolCompletedEvent as CodexSemanticToolCompletedEvent,
  ScreenEvent as CodexChannelScreenEvent,
  ScreenSnapshotEvent as CodexScreenSnapshotEvent,
  ScreenActivityEvent as CodexScreenActivityEvent,
  ScreenTrustDialogEvent as CodexChannelTrustDialogEvent,
  ScreenApprovalEvent as CodexScreenApprovalEvent,
  CommittedEvent as CodexCommittedEvent,
  CommittedTurnEvent as CodexCommittedTurnEvent,
  CommittedResponseItemEvent as CodexCommittedResponseItemEvent,
  CommittedSessionMetaEvent as CodexCommittedSessionMetaEvent,
  CommittedRolloutLineEvent as CodexCommittedRolloutLineEvent,
} from './channels/types.js'
