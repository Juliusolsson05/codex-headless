type JsonRecord = Record<string, unknown>

const USER_INPUT_OPEN = /<user_input>\s*/gi
const USER_INPUT_CLOSE = /\s*<\/user_input>/gi
const USER_MESSAGE_BEGIN = /USER_MESSAGE_BEGIN[\r\n]*/g
const USER_MESSAGE_END = /[\r\n]*USER_MESSAGE_END/g

/**
 * Frozen oracle for the fresh-rollout rule that existed before the ordered
 * evidence change.
 *
 * WHY this deliberately duplicates parsing and normalization: the extractor
 * must prove that a real modern recording changed from historical `hold` to
 * target `accept`. Importing the production parser or claimant makes that check
 * circular; any future production edit would silently rewrite history and bless
 * its own fixture. Keep this module boring, dependency-free, and test-only.
 */
export function decideLegacyFreshRollout(
  rolloutText: string,
  ownCwd: string,
  localPrompt: string,
): 'accept' | 'hold' {
  let sessionCwd: string | null = null
  let turnCwd: string | null = null
  let firstEventUserMessage: string | null = null
  let firstReplayUserMessage: string | null = null

  for (const rawLine of rolloutText.split('\n')) {
    if (!rawLine.trim()) continue
    let line: JsonRecord
    try {
      line = JSON.parse(rawLine) as JsonRecord
    } catch {
      continue
    }
    const payload = asRecord(line.payload)
    if (!payload) continue

    if (line.type === 'session_meta' && sessionCwd === null &&
      typeof payload.cwd === 'string') {
      sessionCwd = payload.cwd
      continue
    }
    if (line.type === 'turn_context' && turnCwd === null &&
      typeof payload.cwd === 'string') {
      turnCwd = payload.cwd
      continue
    }
    if (line.type === 'event_msg' && payload.type === 'user_message' &&
      firstEventUserMessage === null && typeof payload.message === 'string') {
      firstEventUserMessage = payload.message
      continue
    }
    if (line.type === 'response_item' && payload.type === 'message' &&
      payload.role === 'user' && firstReplayUserMessage === null) {
      const content = Array.isArray(payload.content) ? payload.content : []
      const text = content
        .map(item => {
          const record = asRecord(item)
          return record && typeof record.text === 'string' ? record.text : ''
        })
        .filter(Boolean)
        .join('\n')
      if (text) firstReplayUserMessage = text
    }
  }

  const cwd = sessionCwd ?? turnCwd
  const selected = firstEventUserMessage ?? firstReplayUserMessage
  if (!cwd || cwd !== ownCwd || !selected) return 'hold'
  return normalizeLegacy(selected) === normalizeLegacy(localPrompt)
    ? 'accept'
    : 'hold'
}

function normalizeLegacy(text: string): string {
  return text
    .replace(USER_INPUT_OPEN, '')
    .replace(USER_INPUT_CLOSE, '')
    .replace(USER_MESSAGE_BEGIN, '')
    .replace(USER_MESSAGE_END, '')
    .trim()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object'
    ? value as JsonRecord
    : null
}
