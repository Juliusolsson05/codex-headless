import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION_META_READ_BYTES = 256 * 1024

export const CODEX_ROLLOUT_FILENAME_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export type CodexRolloutLocation = {
  filePath: string
  generationId: string
  mtimeMs: number
}

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
  return (await findCodexRolloutByThreadId(sessionsRoot, threadId))?.filePath ?? null
}

export async function findCodexRolloutByThreadId(
  sessionsRoot: string,
  threadId: string,
): Promise<CodexRolloutLocation | null> {
  const requestedId = threadId.toLowerCase()
  if (!isUuid(requestedId)) return null

  const matches: CodexRolloutLocation[] = []
  await collectMatches(sessionsRoot, requestedId, matches, 0)
  matches.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath)
  )
  return matches[0] ?? null
}

async function collectMatches(
  directory: string,
  requestedId: string,
  matches: CodexRolloutLocation[],
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

    const match = await inspectExactGeneration(filePath, requestedId)
    if (match) matches.push(match)
  }
}

async function inspectExactGeneration(
  filePath: string,
  requestedId: string,
): Promise<CodexRolloutLocation | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) return null
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
      if (typeof id !== 'string' || id.toLowerCase() !== requestedId) {
        return null
      }
      return {
        filePath,
        generationId: `${fileStat.dev}:${fileStat.ino}`,
        mtimeMs: fileStat.mtimeMs,
      }
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return null
}

export async function readCodexRolloutGeneration(
  location: Pick<CodexRolloutLocation, 'filePath' | 'generationId'>,
): Promise<string> {
  let handle
  try {
    handle = await open(location.filePath, 'r')
    const fileStat = await handle.stat()
    const openedGenerationId = `${fileStat.dev}:${fileStat.ino}`
    if (!fileStat.isFile() || openedGenerationId !== location.generationId) {
      // WHY raw path/dev:ino values are authorization internals. This error may
      // cross the package's recorder-visible error channel, so it reports only
      // the failed invariant.
      throw new Error('Codex rollout generation mismatch during exact preparation')
    }
    // WHY read from this verified handle instead of readFile(path): lineage is
    // part of the authorization proof. An atomic rename after fstat may change
    // the directory entry, but it cannot change which inode this handle reads.
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(value)
}
