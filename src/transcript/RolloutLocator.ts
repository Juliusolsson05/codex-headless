import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION_META_READ_BYTES = 256 * 1024

export const CODEX_ROLLOUT_FILENAME_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * Resolve one exact Codex provider thread to its newest verified rollout.
 *
 * WHY filename equality is necessary but insufficient: the sessions tree is
 * global and can retain copied, partially written, or manually restored files.
 * Resume/subagent attachment has stronger identity than fresh prompt matching,
 * so it must prove requested ID == filename UUID == session_meta.id before it
 * bypasses fresh arbitration. Every consumer shares this function so history
 * loading and live resume cannot disagree on duplicate selection.
 */
export async function findCodexRolloutPathByThreadId(
  sessionsRoot: string,
  threadId: string,
): Promise<string | null> {
  const requestedId = threadId.toLowerCase()
  if (!isUuid(requestedId)) return null

  const matches: Array<{ filePath: string; mtimeMs: number }> = []
  await collectMatches(sessionsRoot, requestedId, matches, 0)
  matches.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath)
  )
  return matches[0]?.filePath ?? null
}

async function collectMatches(
  directory: string,
  requestedId: string,
  matches: Array<{ filePath: string; mtimeMs: number }>,
  depth: number,
): Promise<void> {
  if (depth > 3) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const filePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectMatches(filePath, requestedId, matches, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    const filename = CODEX_ROLLOUT_FILENAME_RE.exec(entry.name)
    if (filename?.[2]?.toLowerCase() !== requestedId) continue

    const metadataId = await readSessionMetaId(filePath)
    if (metadataId?.toLowerCase() !== requestedId) continue
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat?.isFile()) continue
    matches.push({ filePath, mtimeMs: fileStat.mtimeMs })
  }
}

async function readSessionMetaId(filePath: string): Promise<string | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(SESSION_META_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const prefix = buffer.subarray(0, bytesRead).toString('utf8')
    for (const rawLine of prefix.split('\n')) {
      if (!rawLine.trim()) continue
      let line: unknown
      try {
        line = JSON.parse(rawLine)
      } catch {
        continue
      }
      if (!line || typeof line !== 'object') continue
      const record = line as { type?: unknown; payload?: unknown }
      if (record.type !== 'session_meta' || !record.payload ||
        typeof record.payload !== 'object') {
        continue
      }
      const id = (record.payload as { id?: unknown }).id
      return typeof id === 'string' ? id : null
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return null
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(value)
}
