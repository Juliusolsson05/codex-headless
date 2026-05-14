import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { join, resolve as resolvePath } from 'path'

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
  /**
   * If set, only return sessions whose recorded `session_meta.cwd`
   * matches this directory (after `path.resolve` normalization on
   * both sides). Optional so existing callers that genuinely want
   * the global list — e.g. the rendering-debug harness in
   * `session:list-all` — keep working unchanged.
   *
   * WHY this exists: Codex sessions live in a single date-bucketed
   * directory regardless of which cwd they were originally created
   * in, while the Agent Code resume picker is invoked per-cwd and the
   * caller expects per-cwd results (Claude's lister works that way).
   * Without this filter, the picker silently mixed sessions from
   * every project the user had ever used Codex in. A user resuming
   * what looked like a "this project" session would land on a
   * different-cwd rollout, hit the upstream `cwd_prompt` modal, and
   * have their first prompt eaten by it.
   */
  cwd?: string
}

// We only need the early metadata and the first user-facing prompt for the
// resume picker, but "early" cannot mean "first N bytes" anymore.
//
// WHY this is line-count bounded instead of byte-count bounded:
// recent Codex builds put the full base instructions and active developer
// context inside the very first `session_meta` JSONL object. In this repo that
// line can easily exceed 16 KB. The old byte-head reader would split the first
// JSON object mid-line, drop it as "possibly truncated", and then every
// cwd-filtered resume picker saw `cwd === undefined`, which made it look like
// there were no Codex sessions at all. JSONL's real framing unit is a complete
// line, so we stream complete lines and stop after enough early events to get
// the summary. This keeps the picker cheap without assuming provider metadata
// has a stable byte size.
const MAX_SUMMARY_LINES = 80

// Rollout filename pattern: rollout-<timestamp>-<uuid>.jsonl
const ROLLOUT_RE = /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * List codex sessions, newest first. Walks the date-bucketed
 * sessions directory recursively, reads HEAD of each rollout file,
 * and extracts metadata via typed JSONL decoding.
 *
 * Codex stores all sessions in a single date tree regardless of cwd.
 * Pass `options.cwd` to scope the result to a specific working
 * directory — required for parity with Claude's per-cwd lister and
 * for the Agent Code resume picker. Without it the result is global.
 */
export async function listCodexSessions(
  options: ListCodexSessionsOptions = {},
): Promise<CodexSessionInfo[]> {
  const limit = options.limit ?? 20
  // Normalize the requested cwd once. `path.resolve` collapses a
  // trailing slash and any `..` segments so two stylistic variants
  // of the same path compare equal. We don't `realpath` because that
  // would resolve symlinks and we want to match the literal cwd that
  // Codex recorded — which itself wasn't realpath'd on write.
  const filterCwd = options.cwd ? resolvePath(options.cwd) : null
  const sessionsDir = getCodexSessionsDir()

  // Collect all rollout files recursively from the date tree.
  const files: Array<{ path: string; mtime: number; sessionId: string }> = []
  try {
    await walkForRollouts(sessionsDir, files)
  } catch {
    // Sessions dir doesn't exist yet — no codex sessions recorded.
    return []
  }

  // Sort newest first so we surface the most-recent matches and can
  // early-exit once we've filled `limit`. With cwd filtering we keep
  // walking past where we'd otherwise stop — only `limit` matched
  // sessions counts, not `limit` files visited. Bounded by `files.length`.
  files.sort((a, b) => b.mtime - a.mtime)

  const sessions: CodexSessionInfo[] = []
  for (const f of files) {
    if (sessions.length >= limit) break
    const info = await parseCodexSession(f)
    if (!info) continue
    if (filterCwd) {
      // Drop entries whose recorded cwd doesn't match. Sessions whose
      // session_meta couldn't be decoded (info.cwd is undefined) are
      // also dropped under filtering — we'd rather miss a malformed
      // rollout than mislead the user into resuming the wrong dir.
      if (!info.cwd) continue
      if (resolvePath(info.cwd) !== filterCwd) continue
    }
    sessions.push(info)
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
 * Extract metadata from the early rollout lines by typed JSONL
 * decoding. Streams complete JSONL records and pulls:
 *   - session_meta -> cwd, git.branch, timestamp
 *   - first user message -> summary text
 */
async function parseCodexSession(
  file: { path: string; mtime: number; sessionId: string },
): Promise<CodexSessionInfo | null> {
  try {
    const s = await stat(file.path)
    if (s.size === 0) return null

    let meta: CodexSessionMeta | null = null
    let userText: string | null = null
    let replayUserText: string | null = null
    let lineCount = 0

    const stream = createReadStream(file.path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })

    try {
      for await (const raw of lines) {
        lineCount += 1
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
          if (userText) break
          continue
        }

        if (!userText && isCodexEventMsg(parsed)) {
          userText = extractEventUserMessageText(parsed)
        }

        if (!replayUserText && isCodexResponseItem(parsed)) {
          replayUserText = extractReplayUserMessageText(parsed)
        }

        if (meta && userText) break
        if (lineCount >= MAX_SUMMARY_LINES) break
      }
    } finally {
      lines.close()
      stream.destroy()
    }

    // If the first useful user prompt is further down the file than our cheap
    // summary scan, still show the session. The resume command only needs the
    // provider session id; summary text is just a label.
    if (!meta && !userText && !replayUserText) {
      return {
        sessionId: file.sessionId,
        summary: file.sessionId.slice(0, 8),
        lastModified: file.mtime,
        fileSize: s.size,
      }
    }

    let createdAt: number | undefined
    if (meta?.timestamp) {
      const parsedTs = Date.parse(meta.timestamp)
      if (!Number.isNaN(parsedTs)) createdAt = parsedTs
    }

    let summary = userText ?? replayUserText ?? ''
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
  }
}

/**
 * Pull user-facing prompt strings out of Codex rollout records.
 *
 * WHY this is split into event-vs-replay helpers instead of one generic
 * "first user message" extractor:
 *
 * New Codex rollouts can include large startup/context `response_item` entries
 * with role === "user" before the actual typed prompt. Those are real protocol
 * messages, but they are terrible resume-picker labels because every session
 * looks like the repo's AGENTS.md/environment block. The terminal-originated
 * `event_msg:user_message` is the best label when present. We still keep the
 * response_item path as a fallback for replay/fork/resume files that may not
 * contain an event_msg near the head.
 *
 * We strip a couple of known wrapper markers Codex uses internally
 * (`<user_input>...</user_input>` and the `USER_MESSAGE_BEGIN/END`
 * sentinels) so the picker shows the actual prompt text, not wire framing.
 */
function extractEventUserMessageText(line: CodexRolloutLine): string | null {
  const evt = line.payload as CodexUserMessageEvent
  if (evt?.type === 'user_message' && typeof evt.message === 'string') {
    return cleanUserText(evt.message)
  }
  return null
}

function extractReplayUserMessageText(line: CodexRolloutLine): string | null {
  const item = line.payload
  if (item.type === 'message' && (item as CodexMessageItem).role === 'user') {
    const text = extractCodexMessageText(item as CodexMessageItem)
    if (text) return cleanUserText(text)
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
