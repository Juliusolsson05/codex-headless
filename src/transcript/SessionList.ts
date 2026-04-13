import { readdir, stat, open } from 'fs/promises'
import { join } from 'path'

import { getCodexSessionsDir } from './ProjectDir.js'
import {
  type CodexRolloutLine,
  type CodexSessionMeta,
  type CodexMessageItem,
  type CodexUserMessageEvent,
  isCodexSessionMeta,
  isCodexResponseItem,
  isCodexEventMsg,
  extractCodexMessageText,
} from './TranscriptTypes.js'

// Codex session lister — walks ~/.codex/sessions/YYYY/MM/DD/ for
// rollout-*.jsonl files and extracts summary metadata for the resume
// picker. Parallel to sessionList.ts (Claude's lister) but reads a
// different directory structure and different JSONL field names.
//
// Codex rollout files are named:
//   rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
//
// The first line of each file is a session_meta entry with the UUID,
// cwd, timestamp, and git info. User messages appear as either:
//   - event_msg with payload.type === 'user_message' (TUI-driven), or
//   - response_item with type=='message' and role=='user' (replay /
//     forked / resumed turns).
//
// The previous implementation regex-grabbed the first "text" field
// from the head bytes. That happens to work because session_meta has
// no "text" field and the first response_item that does is usually the
// user prompt — but it's accidental. Any future field named "text" in
// session_meta or turn_context would break it silently. We now decode
// each JSONL line with the typed guards and pick the first real user
// message in document order.

export type CodexSessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize: number
  cwd?: string
  gitBranch?: string
  createdAt?: number
}

export type ListCodexSessionsOptions = {
  limit?: number
}

// Head budget covers session_meta plus the first few entries — the
// first user message is almost always within the first ~16 KB of a
// rollout. If we don't find one within the head we fall back to the
// session id; we don't pay to scan the whole file just for a label.
const HEAD_BYTES = 16 * 1024

// Rollout filename pattern: rollout-<timestamp>-<uuid>.jsonl
const ROLLOUT_RE = /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * List codex sessions, newest first. Walks the date-bucketed
 * sessions directory recursively, reads HEAD of each rollout file,
 * and extracts metadata via typed JSONL decoding.
 *
 * Unlike Claude's lister which is scoped to a single cwd, this
 * returns ALL sessions (codex doesn't partition by cwd). The
 * caller can filter by cwd if needed.
 */
export async function listCodexSessions(
  options: ListCodexSessionsOptions = {},
): Promise<CodexSessionInfo[]> {
  const limit = options.limit ?? 20
  const sessionsDir = getCodexSessionsDir()

  // Collect all rollout files recursively from the date tree.
  const files: Array<{ path: string; mtime: number; sessionId: string }> = []
  try {
    await walkForRollouts(sessionsDir, files)
  } catch {
    // Sessions dir doesn't exist yet — no codex sessions recorded.
    return []
  }

  // Sort newest first so we can early-exit once we've filled `limit`.
  files.sort((a, b) => b.mtime - a.mtime)

  const sessions: CodexSessionInfo[] = []
  for (const f of files) {
    if (sessions.length >= limit) break
    const info = await parseCodexSession(f)
    if (info) sessions.push(info)
  }
  return sessions
}

/**
 * Recursively walk the date tree and collect rollout files.
 * Codex stores sessions as:
 *   sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * We walk up to 3 levels of date directories + the leaf files.
 */
async function walkForRollouts(
  dir: string,
  out: Array<{ path: string; mtime: number; sessionId: string }>,
  depth = 0,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      const s = await stat(full)
      if (s.isDirectory() && depth < 3) {
        await walkForRollouts(full, out, depth + 1)
      } else if (s.isFile()) {
        const match = ROLLOUT_RE.exec(name)
        if (match) {
          out.push({
            path: full,
            mtime: s.mtime.getTime(),
            sessionId: match[2],
          })
        }
      }
    } catch {
      // Skip unreadable entries.
    }
  }
}

/**
 * Extract metadata from a single rollout file's HEAD by typed JSONL
 * decoding. Reads the head bytes once, splits on newlines, decodes
 * each complete line, and pulls:
 *   - session_meta -> cwd, git.branch, timestamp
 *   - first user message -> summary text
 *
 * The last line of the head buffer is dropped because it may be
 * truncated mid-JSON.
 */
async function parseCodexSession(
  file: { path: string; mtime: number; sessionId: string },
): Promise<CodexSessionInfo | null> {
  let fd
  try {
    fd = await open(file.path, 'r')
    const s = await fd.stat()
    if (s.size === 0) return null

    const headLen = Math.min(HEAD_BYTES, s.size)
    const headBuf = Buffer.alloc(headLen)
    await fd.read(headBuf, 0, headLen, 0)
    const head = headBuf.toString('utf8')

    const lines = head.split('\n')
    // If we read a partial file and the last line is incomplete,
    // drop it — we can't trust a truncated JSON object.
    if (headLen < s.size && lines.length > 0) lines.pop()

    let meta: CodexSessionMeta | null = null
    let userText: string | null = null

    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      let parsed: CodexRolloutLine
      try {
        parsed = JSON.parse(line) as CodexRolloutLine
      } catch {
        // A garbled line shouldn't kill the whole summary — keep going.
        continue
      }

      if (!meta && isCodexSessionMeta(parsed)) {
        meta = parsed.payload
        continue
      }

      if (!userText) {
        userText = extractUserMessageText(parsed)
      }

      if (meta && userText) break
    }

    let createdAt: number | undefined
    if (meta?.timestamp) {
      const parsedTs = Date.parse(meta.timestamp)
      if (!Number.isNaN(parsedTs)) createdAt = parsedTs
    }

    let summary = userText ?? ''
    if (summary.length > 200) summary = summary.slice(0, 200).trimEnd() + '…'
    if (!summary) summary = file.sessionId.slice(0, 8)

    return {
      sessionId: file.sessionId,
      summary,
      lastModified: file.mtime,
      fileSize: s.size,
      cwd: meta?.cwd,
      gitBranch: meta?.git?.branch,
      createdAt,
    }
  } catch {
    return null
  } finally {
    await fd?.close().catch(() => {})
  }
}

/**
 * Pull a user-facing prompt string from any rollout line that could
 * carry one. Two shapes occur in practice:
 *
 *   1. event_msg / payload.type === 'user_message' — emitted by the
 *      TUI when the user submits text from the composer. The string
 *      lives at payload.message.
 *
 *   2. response_item / type === 'message' / role === 'user' — emitted
 *      when Codex replays prior turns into the next request, or when
 *      the session was forked / resumed. Text lives in
 *      content[*].input_text.
 *
 * We strip a couple of known wrapper markers Codex uses internally
 * (`<user_input>...</user_input>` and the `USER_MESSAGE_BEGIN/END`
 * sentinels) so the picker shows the actual prompt text, not the
 * wire framing. Returns null if this line isn't a user message.
 */
function extractUserMessageText(line: CodexRolloutLine): string | null {
  if (isCodexEventMsg(line)) {
    const evt = line.payload as CodexUserMessageEvent
    if (evt?.type === 'user_message' && typeof evt.message === 'string') {
      return cleanUserText(evt.message)
    }
  }
  if (isCodexResponseItem(line)) {
    const item = line.payload
    if (item.type === 'message' && (item as CodexMessageItem).role === 'user') {
      const text = extractCodexMessageText(item as CodexMessageItem)
      if (text) return cleanUserText(text)
    }
  }
  return null
}

const USER_INPUT_OPEN = /<user_input>\s*/i
const USER_INPUT_CLOSE = /\s*<\/user_input>/i
const USER_MESSAGE_BEGIN = /USER_MESSAGE_BEGIN[\r\n]*/
const USER_MESSAGE_END = /[\r\n]*USER_MESSAGE_END/

function cleanUserText(text: string): string {
  return text
    .replace(USER_INPUT_OPEN, '')
    .replace(USER_INPUT_CLOSE, '')
    .replace(USER_MESSAGE_BEGIN, '')
    .replace(USER_MESSAGE_END, '')
    .trim()
}
