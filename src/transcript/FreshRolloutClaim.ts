import type {
  CodexMessageItem,
  CodexRolloutLine,
  CodexSessionMeta,
  CodexUserMessageEvent,
} from './TranscriptTypes.js'
import {
  extractCodexMessageText,
  isCodexEventMsg,
  isCodexMessageItem,
  isCodexResponseItem,
  isCodexSessionMeta,
} from './TranscriptTypes.js'

export type SubmittedPrompt = {
  text: string
  normalized: string
  ts: number
}

export type FreshRolloutCandidate = {
  filePath: string
  threadId: string | null
  cwd: string | null
  cliVersion: string | null
  userMessages: FreshRolloutUserMessage[]
  /**
   * WHY this legacy projection remains during the instrumentation stage:
   * Stage 0 must make the failed decision observable without changing it. The
   * claimant therefore continues to compare exactly the value it compared
   * before, while `userMessages` records the complete ordered evidence that
   * later fixture stages will use to replace this lossy projection.
   */
  firstUserMessage: string | null
  normalizedFirstUserMessage: string | null
}

export type FreshRolloutUserMessage = {
  source: 'event_msg' | 'response_item'
  lineIndex: number
  text: string
  normalized: string
}

export type FreshRolloutClaimEvidenceSnapshot = {
  localPromptCount: number
  localPromptFingerprints: string[]
  candidateCount: number
  sameCwdCandidateCount: number
  candidates: Array<{
    filePath: string
    threadId: string | null
    cliVersion: string | null
    cwdMatches: boolean
    selectedLegacyFingerprint: string | null
    userMessages: Array<{
      source: FreshRolloutUserMessage['source']
      lineIndex: number
      fingerprint: string
      matchesLocalPrompt: boolean
      selectedByLegacyProjection: boolean
    }>
  }>
}

export type FreshRolloutClaimDecision =
  | { type: 'hold'; reason: string }
  | { type: 'reject'; reason: string }
  | { type: 'accept'; filePath: string; prompt: SubmittedPrompt }
  | { type: 'ambiguous'; reason: string; filePaths: string[] }

const USER_INPUT_OPEN = /<user_input>\s*/gi
const USER_INPUT_CLOSE = /\s*<\/user_input>/gi
const USER_MESSAGE_BEGIN = /USER_MESSAGE_BEGIN[\r\n]*/g
const USER_MESSAGE_END = /[\r\n]*USER_MESSAGE_END/g
const BRACKETED_PASTE_RE = /\x1b\[200~([\s\S]*?)\x1b\[201~/g

// Keep this normalization intentionally aligned with renderer-side
// optimistic reconciliation instead of byte-for-byte JSONL matching.
// Codex can wrap user text (`<user_input>`, USER_MESSAGE sentinels)
// and serialize whitespace differently between terminal input,
// event_msg, and replayed response_item history. For ownership we need
// to answer "is this the same submitted prompt?", not "did two
// transports preserve identical bytes?".
export function normalizePromptForOwnership(text: string): string {
  return cleanUserText(text).normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function extractSubmittedPromptFromWrite(data: string): string | null {
  BRACKETED_PASTE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  let last: string | null = null
  while ((match = BRACKETED_PASTE_RE.exec(data)) !== null) {
    last = match[1] ?? ''
  }
  if (last !== null) return cleanUserText(last)

  if (!data.endsWith('\r')) return null
  if (data.includes('\x1b')) return null
  const text = data.slice(0, -1)
  if (!text.trim()) return null
  return cleanUserText(text)
}

export function parseFreshRolloutCandidate(
  filePath: string,
  text: string,
): FreshRolloutCandidate | null {
  let sessionMeta: CodexSessionMeta | null = null
  let turnContextCwd: string | null = null
  let eventUserText: string | null = null
  let replayUserText: string | null = null
  const userMessages: FreshRolloutUserMessage[] = []

  for (const [lineIndex, rawLine] of text.split('\n').entries()) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    let parsed: CodexRolloutLine
    try {
      parsed = JSON.parse(trimmed) as CodexRolloutLine
    } catch {
      continue
    }

    if (isCodexSessionMeta(parsed) && !sessionMeta) {
      sessionMeta = parsed.payload
      continue
    }

    if (parsed.type === 'turn_context' && !turnContextCwd) {
      const payload = parsed.payload as { cwd?: unknown } | null
      if (payload && typeof payload.cwd === 'string') {
        turnContextCwd = payload.cwd
      }
      continue
    }

    if (isCodexEventMsg(parsed)) {
      const userText = extractEventUserMessageText(parsed)
      if (userText !== null) {
        const normalized = normalizePromptForOwnership(userText)
        userMessages.push({
          source: 'event_msg',
          lineIndex,
          text: userText,
          normalized,
        })
        if (!eventUserText) eventUserText = userText
      }
      continue
    }

    if (isCodexResponseItem(parsed)) {
      const userText = extractReplayUserMessageText(parsed.payload)
      if (userText !== null) {
        const normalized = normalizePromptForOwnership(userText)
        userMessages.push({
          source: 'response_item',
          lineIndex,
          text: userText,
          normalized,
        })
        if (!replayUserText) replayUserText = userText
      }
    }
  }

  const cwd = sessionMeta?.cwd ?? turnContextCwd
  const firstUserMessage = eventUserText ?? replayUserText
  if (!sessionMeta && !cwd && !firstUserMessage) return null
  return {
    filePath,
    threadId: sessionMeta?.id ?? null,
    cwd: cwd ?? null,
    cliVersion: sessionMeta?.cli_version ?? null,
    userMessages,
    firstUserMessage: firstUserMessage ?? null,
    normalizedFirstUserMessage: firstUserMessage
      ? normalizePromptForOwnership(firstUserMessage)
      : null,
  }
}

export function summarizeFreshRolloutClaimEvidence(options: {
  ownCwd: string
  prompts: readonly SubmittedPrompt[]
  candidates: Iterable<FreshRolloutCandidate>
  normalizeCwd: (cwd: string) => string
  fingerprint: (normalizedText: string) => string
}): FreshRolloutClaimEvidenceSnapshot {
  const ownCwd = options.normalizeCwd(options.ownCwd)
  const candidates = Array.from(options.candidates)
  const localPromptFingerprints = options.prompts
    .filter(prompt => prompt.normalized.length > 0)
    .map(prompt => options.fingerprint(prompt.normalized))
  const localPrompts = new Set(options.prompts.map(prompt => prompt.normalized))

  // WHY diagnostics describe every ordered user observation instead of only
  // the claimant's projection: the 0.149 regression is invisible if telemetry
  // repeats the same lossy "first user message" assumption as the decision.
  // Equality is reported through a per-process salted fingerprint so bundles
  // reveal the ownership relationship without adding prompt/bootstrap text.
  const described = candidates.map(candidate => {
    const cwdMatches = candidate.cwd !== null &&
      options.normalizeCwd(candidate.cwd) === ownCwd
    return {
      filePath: candidate.filePath,
      threadId: candidate.threadId,
      cliVersion: candidate.cliVersion,
      cwdMatches,
      selectedLegacyFingerprint: candidate.normalizedFirstUserMessage
        ? options.fingerprint(candidate.normalizedFirstUserMessage)
        : null,
      userMessages: candidate.userMessages.map(message => ({
        source: message.source,
        lineIndex: message.lineIndex,
        fingerprint: options.fingerprint(message.normalized),
        matchesLocalPrompt: localPrompts.has(message.normalized),
        selectedByLegacyProjection:
          message.normalized === candidate.normalizedFirstUserMessage,
      })),
    }
  })

  return {
    localPromptCount: localPromptFingerprints.length,
    localPromptFingerprints,
    candidateCount: candidates.length,
    sameCwdCandidateCount: described.filter(candidate => candidate.cwdMatches).length,
    candidates: described,
  }
}

export function decideFreshRolloutClaim(options: {
  ownCwd: string
  prompts: readonly SubmittedPrompt[]
  candidates: Iterable<FreshRolloutCandidate>
  normalizeCwd: (cwd: string) => string
}): FreshRolloutClaimDecision {
  // Cwd is a necessary filter but never proof. Same-cwd sibling
  // agents are the exact failure mode this helper exists to stop, so
  // every accept below must be backed by a prompt that passed through
  // the owning CodexHeadless instance. Ambiguity also fails closed:
  // choosing the newest matching file would just reintroduce timing as
  // identity under a different name.
  const ownCwd = options.normalizeCwd(options.ownCwd)
  const sameCwd = Array.from(options.candidates).filter(candidate => {
    if (!candidate.cwd) return false
    return options.normalizeCwd(candidate.cwd) === ownCwd
  })

  if (sameCwd.length === 0) {
    return { type: 'hold', reason: 'no same-cwd rollout candidates yet' }
  }

  const prompts = options.prompts.filter(prompt => prompt.normalized.length > 0)
  if (prompts.length === 0) {
    return {
      type: 'hold',
      reason: 'no local submitted prompt recorded for fresh rollout ownership',
    }
  }

  const matches: Array<{
    candidate: FreshRolloutCandidate
    prompt: SubmittedPrompt
  }> = []
  for (const candidate of sameCwd) {
    if (!candidate.normalizedFirstUserMessage) continue
    const prompt = prompts.find(
      item => item.normalized === candidate.normalizedFirstUserMessage,
    )
    if (prompt) matches.push({ candidate, prompt })
  }

  if (matches.length === 0) {
    return {
      type: 'hold',
      reason: 'same-cwd candidates exist but none match a local submitted prompt',
    }
  }

  const uniquePaths = Array.from(
    new Set(matches.map(match => match.candidate.filePath)),
  )
  if (uniquePaths.length !== 1) {
    return {
      type: 'ambiguous',
      reason: 'multiple same-cwd rollout candidates match local submitted prompts',
      filePaths: uniquePaths,
    }
  }

  const [match] = matches
  return {
    type: 'accept',
    filePath: match.candidate.filePath,
    prompt: match.prompt,
  }
}

function extractEventUserMessageText(line: CodexRolloutLine): string | null {
  const evt = line.payload as CodexUserMessageEvent
  if (evt?.type === 'user_message' && typeof evt.message === 'string') {
    return cleanUserText(evt.message)
  }
  return null
}

function extractReplayUserMessageText(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null
  if (!isCodexMessageItem(item as CodexMessageItem)) return null
  const message = item as CodexMessageItem
  if (message.role !== 'user') return null
  const text = extractCodexMessageText(message)
  return text ? cleanUserText(text) : null
}

function cleanUserText(text: string): string {
  return text
    .replace(USER_INPUT_OPEN, '')
    .replace(USER_INPUT_CLOSE, '')
    .replace(USER_MESSAGE_BEGIN, '')
    .replace(USER_MESSAGE_END, '')
    .trim()
}
