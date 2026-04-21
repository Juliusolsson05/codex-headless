// Codex JSONL "rollout" transcript types.
//
// Derived from two sources:
//   1. codex-rs/protocol/src/protocol.rs — the Rust enum definitions
//      (RolloutItem, EventMsg, ResponseItem) are the source of truth
//   2. Real rollout files captured via the debugger recording
//
// The on-disk format is:
//   { "timestamp": "<ISO 8601>", "type": "<tag>", "payload": {...} }
//
// where `type` is the serde tag from `#[serde(tag = "type", content = "payload")]`
// on the RolloutItem enum.
//
// We type these precisely enough to render a feed but loosely enough
// that unknown fields don't break parsing. Use the type guards at
// runtime.
//
// Pure types + guards — no runtime, no Node, no DOM.

// ---------------------------------------------------------------------------
// Rollout envelope — every line in the JSONL
// ---------------------------------------------------------------------------

export type CodexRolloutLine = {
  timestamp: string
  type: string
  payload: unknown
}

// ---------------------------------------------------------------------------
// RolloutItem variants (from protocol.rs:2747 RolloutItem enum)
// ---------------------------------------------------------------------------

// type = "session_meta"
export type CodexSessionMeta = {
  id: string
  timestamp: string
  cwd: string
  originator: string       // "codex-tui" | "codex"
  cli_version: string
  source: string           // "cli" | "app_server"
  model_provider?: string  // "openai"
  agent_nickname?: string
  agent_role?: string
  agent_path?: string
  base_instructions?: { text: string }
  forked_from_id?: string
  memory_mode?: string
  dynamic_tools?: unknown
  git?: {
    branch?: string
    commit?: string
    dirty?: boolean
  }
}

// type = "turn_context"
export type CodexTurnContext = {
  turn_id: string
  cwd: string
  current_date: string
  timezone: string
  approval_policy: string  // "on-request" | "auto-approve" | etc.
  sandbox_policy: {
    type: string           // "workspace-write"
    writable_roots: string[]
    network_access: boolean
  }
}

// type = "compacted"
export type CodexCompactedItem = {
  message: string
  replacement_history?: CodexResponseItem[]
}

// ---------------------------------------------------------------------------
// ResponseItem variants (from models.rs:188 ResponseItem enum)
// ---------------------------------------------------------------------------

// type = "response_item", payload.type discriminates further

export type CodexResponseItem =
  | CodexMessageItem
  | CodexFunctionCallItem
  | CodexFunctionCallOutputItem
  | CodexLocalShellCallItem
  | CodexReasoningItem
  | CodexCustomToolCallItem
  | CodexCustomToolCallOutputItem
  | CodexWebSearchCallItem
  | CodexOtherItem

/** Message — user, assistant, developer, or system text. */
export type CodexMessageItem = {
  type: 'message'
  id?: string
  role: string             // "user" | "assistant" | "developer" | "system"
  content: CodexContentItem[]
  end_turn?: boolean
  phase?: string           // "commentary" | "final_answer" | etc.
}

/** Content items within a message. */
export type CodexContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string; annotations?: unknown[] }
  | { type: 'refusal'; refusal: string }
  | { type: string; [k: string]: unknown }

/** FunctionCall — OpenAI Responses API function call. */
export type CodexFunctionCallItem = {
  type: 'function_call'
  name: string
  namespace?: string
  arguments: string        // JSON string
  call_id: string
}

/** FunctionCallOutput — result of a function call. */
export type CodexFunctionCallOutputItem = {
  type: 'function_call_output'
  call_id: string
  output: string | CodexFunctionCallOutputContent[]
}

export type CodexFunctionCallOutputContent = {
  type: string             // "text" | "image" | etc.
  text?: string
  [k: string]: unknown
}

/** LocalShellCall — exec_command via the local shell tool. */
export type CodexLocalShellCallItem = {
  type: 'local_shell_call'
  call_id?: string
  status: string           // "completed" | "in_progress"
  action: {
    type: string           // "exec" | "exec_command"
    cmd?: string[]
    workdir?: string
    timeout_seconds?: number
  }
}

/** Reasoning — thinking/chain-of-thought (content is encrypted/hidden). */
export type CodexReasoningItem = {
  type: 'reasoning'
  id?: string
  summary: Array<{ type: string; text: string }>
  content?: unknown
  encrypted_content?: string
}

/** CustomToolCall — MCP or dynamic tool calls. */
export type CodexCustomToolCallItem = {
  type: 'custom_tool_call'
  call_id: string
  name: string
  input: string            // JSON string
  status?: string
}

/** CustomToolCallOutput — result from MCP/dynamic tools. */
export type CodexCustomToolCallOutputItem = {
  type: 'custom_tool_call_output'
  call_id: string
  name?: string
  output: string | CodexFunctionCallOutputContent[]
}

/** WebSearchCall — web search triggered by the model. */
export type CodexWebSearchCallItem = {
  type: 'web_search_call'
  status?: string
  action?: { type: string; query: string }
}

/** Fallback for unknown response item types. */
export type CodexOtherItem = {
  type: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// EventMsg variants (from protocol.rs:1357 EventMsg enum)
// ---------------------------------------------------------------------------

// type = "event_msg", payload.type discriminates further

export type CodexEventMsg =
  | CodexTurnStartedEvent
  | CodexTurnCompleteEvent
  | CodexTurnAbortedEvent
  | CodexUserMessageEvent
  | CodexAgentMessageEvent
  | CodexAgentMessageDeltaEvent
  | CodexTokenCountEvent
  | CodexExecCommandBeginEvent
  | CodexExecCommandEndEvent
  | CodexExecCommandOutputDeltaEvent
  | CodexExecApprovalRequestEvent
  | CodexMcpToolCallBeginEvent
  | CodexMcpToolCallEndEvent
  | CodexErrorEvent
  | CodexGenericEvent

export type CodexTurnStartedEvent = {
  type: 'task_started' | 'turn_started'
  turn_id: string
  started_at: number
  model_context_window?: number
  collaboration_mode_kind?: string
}

export type CodexTurnCompleteEvent = {
  type: 'task_complete' | 'turn_complete'
  turn_id: string
}

export type CodexTurnAbortedEvent = {
  type: 'turn_aborted'
  turn_id: string
  reason?: string
  completed_at?: number
  duration_ms?: number
}

export type CodexUserMessageEvent = {
  type: 'user_message'
  message?: string
  kind?: string            // "plain"
  text_elements?: unknown[]
  local_images?: unknown[]
}

export type CodexAgentMessageEvent = {
  type: 'agent_message'
  message?: string
}

export type CodexAgentMessageDeltaEvent = {
  type: 'agent_message_delta'
  delta?: string
}

export type CodexTokenCountEvent = {
  type: 'token_count'
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

export type CodexExecCommandBeginEvent = {
  type: 'exec_command_begin'
  call_id?: string
  command?: string[]
  workdir?: string
}

export type CodexExecCommandEndEvent = {
  type: 'exec_command_end'
  call_id?: string
  exit_code?: number
}

export type CodexExecCommandOutputDeltaEvent = {
  type: 'exec_command_output_delta'
  call_id?: string
  delta?: string
}

export type CodexExecApprovalRequestEvent = {
  type: 'exec_approval_request'
  call_id?: string
  command?: string[]
  workdir?: string
}

export type CodexMcpToolCallBeginEvent = {
  type: 'mcp_tool_call_begin'
  call_id?: string
  server_name?: string
  tool_name?: string
}

export type CodexMcpToolCallEndEvent = {
  type: 'mcp_tool_call_end'
  call_id?: string
  server_name?: string
  tool_name?: string
}

export type CodexErrorEvent = {
  type: 'error'
  message: string
  code?: string
}

/** Fallback for event types we don't render yet. */
export type CodexGenericEvent = {
  type: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isCodexConversationEntry(line: CodexRolloutLine): boolean {
  return line.type === 'response_item' || line.type === 'event_msg'
}

export function isCodexResponseItem(line: CodexRolloutLine): line is CodexRolloutLine & { payload: CodexResponseItem } {
  return line.type === 'response_item'
}

export function isCodexEventMsg(line: CodexRolloutLine): line is CodexRolloutLine & { payload: CodexEventMsg } {
  return line.type === 'event_msg'
}

export function isCodexSessionMeta(line: CodexRolloutLine): line is CodexRolloutLine & { payload: CodexSessionMeta } {
  return line.type === 'session_meta'
}

/** Extract text content from a CodexMessageItem's content array. */
export function extractCodexMessageText(item: CodexMessageItem): string {
  return item.content
    .map(c => {
      if (c.type === 'input_text' || c.type === 'output_text') return c.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Parse the JSON arguments string from a function call. */
export function parseCodexFunctionArgs(args: string): Record<string, unknown> {
  try { return JSON.parse(args) as Record<string, unknown> }
  catch { return {} }
}
