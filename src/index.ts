// codex-headless — programmatic control of OpenAI Codex via headless terminal.
//
// Mirrors claude-code-headless API surface where possible. Provider-specific
// differences (different screen parser, different transcript format, different
// command set) live in the parsers and transcript modules.

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
  diffLines,
  type DiffLine,
} from './parsers/LineDiff.js'

export {
  detectCodexTrustDialog,
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  type CodexTrustDialogState,
} from './parsers/TrustDialogParser.js'

// --- Transcript (codex-specific) ---
export * from './transcript/TranscriptTypes.js'
