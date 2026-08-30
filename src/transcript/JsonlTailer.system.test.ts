import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileTailer } from './JsonlTailer.js'

// Regression tests for the scoped-unwatch fix (agent-code residue plan P0,
// 2026-07). The bug: close() called unwatchFile(path) with NO listener
// argument — Node removes EVERY stat-watcher for that path process-wide.
// agent-code's replaceSession spawns the new session before killing the
// old, and on in-place resume both tail the SAME rollout file, so the old
// session's close deterministically killed the new pane's watcher: the
// "dead committed channel" / "prompt stuck in queue" bug family. Prompts
// were in the rollout 12ms after submit and never ingested.

const openTailers: FileTailer<unknown>[] = []
const temporaryDirectories: string[] = []

function makeFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tailer-test-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'rollout.jsonl')
  writeFileSync(file, JSON.stringify({ seq: 0 }) + '\n')
  return file
}

function tail(file: string, out: number[], watchdogMs?: number, onError?: (e: Error) => void): FileTailer<{ seq: number }> {
  const t = new FileTailer<{ seq: number }>(file, e => out.push(e.seq), onError, watchdogMs ? { watchdogMs } : undefined)
  openTailers.push(t as FileTailer<unknown>)
  return t
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return pred()
}

afterEach(async () => {
  try {
    while (openTailers.length > 0) await openTailers.pop()?.close()
  } finally {
    // WHY cleanup is in finally rather than after close(): a watcher failure
    // is exactly the scenario these tests exercise. Leaving the fixture behind
    // when close throws makes later files depend on the order Vitest chose.
    while (temporaryDirectories.length > 0) {
      rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
    }
  }
})

describe('FileTailer polling ownership', () => {
  it('a second tailer on the same path survives the first one closing', async () => {
    const file = makeFile()
    const seenByB: number[] = []
    const a = tail(file, [])
    tail(file, seenByB)

    // The exact production sequence: old session (A) closes while the
    // new session (B) tails the same rollout.
    await a.close()
    appendFileSync(file, JSON.stringify({ seq: 1 }) + '\n')
    appendFileSync(file, JSON.stringify({ seq: 2 }) + '\n')

    expect(await waitFor(() => seenByB.includes(2), 3000)).toBe(true)
    expect(seenByB).toContain(1)
  })

  it('delivers an append made immediately after construction exactly once', async () => {
    const file = makeFile()
    const seen: number[] = []
    tail(file, seen)
    appendFileSync(file, JSON.stringify({ seq: 1 }) + '\n')

    expect(await waitFor(() => seen.includes(1), 1000)).toBe(true)
    expect(seen.filter(seq => seq === 1)).toHaveLength(1)
  })

  it('preserves UTF-8 and absolute offsets when a poll ends inside a code point', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tailer-test-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'rollout.jsonl')
    writeFileSync(file, '')
    const seen: Array<{ text: string; offset: number }> = []
    const errors: Error[] = []
    const watcher = new FileTailer<{ text: string }>(
      file,
      (entry, metadata) => seen.push({ text: entry.text, offset: metadata.lineStartOffset }),
      error => errors.push(error),
    )
    openTailers.push(watcher as FileTailer<unknown>)

    const prefix = Buffer.from('{"text":"', 'utf8')
    const multibyte = Buffer.from('€', 'utf8')
    // WHY split the append at byte two of a three-byte character: StringDecoder
    // and ordinary human text normally hide this OS-level boundary. The tailer
    // advances by stat size, however, so the regression only appears when one
    // poll consumes an incomplete code point and the next poll supplies its
    // continuation byte.
    appendFileSync(file, Buffer.concat([prefix, multibyte.subarray(0, 2)]))
    await new Promise(resolve => setTimeout(resolve, 250))
    appendFileSync(file, Buffer.concat([
      multibyte.subarray(2),
      Buffer.from('"}\n{"text":"next"}\n', 'utf8'),
    ]))

    expect(await waitFor(() => seen.length === 2, 2000)).toBe(true)
    expect(errors).toEqual([])
    expect(seen).toEqual([
      { text: '€', offset: 0 },
      { text: 'next', offset: Buffer.byteLength('{"text":"€"}\n', 'utf8') },
    ])
  })

  it('restarts from byte zero after truncate-in-place and atomic replacement', async () => {
    const file = makeFile()
    const seen: number[] = []
    tail(file, seen)
    expect(await waitFor(() => seen.includes(0), 1000)).toBe(true)

    truncateSync(file, 0)
    appendFileSync(file, JSON.stringify({ seq: 1 }) + '\n')
    expect(await waitFor(() => seen.includes(1), 1000)).toBe(true)

    const replacement = `${file}.replacement`
    writeFileSync(replacement, JSON.stringify({ seq: 2 }) + '\n')
    renameSync(replacement, file)
    expect(await waitFor(() => seen.includes(2), 1000)).toBe(true)
  })

  it('never follows a pathname replacement after a generation-bound open', async () => {
    const file = makeFile()
    const initial = statSync(file)
    const expectedGenerationId = `${initial.dev}:${initial.ino}`
    const seen: number[] = []
    const errors: Error[] = []
    // WHY the cast keeps this red artifact runnable against the pre-fix public
    // type. The option is intentionally ignored by that implementation, so the
    // assertion below demonstrates replacement B being emitted under A's
    // authorization instead of reducing the regression to a compile failure.
    const options = { expectedGenerationId } as unknown as {
      bootstrapTailLines?: number
    }
    const watcher = new FileTailer<{ seq: number }>(
      file,
      entry => seen.push(entry.seq),
      error => errors.push(error),
      options,
    )
    openTailers.push(watcher as FileTailer<unknown>)
    expect(await waitFor(() => seen.includes(0), 1000)).toBe(true)

    // Same-inode append is the ordinary rollout path and must stay live.
    appendFileSync(file, JSON.stringify({ seq: 1 }) + '\n')
    expect(await waitFor(() => seen.includes(1), 1000)).toBe(true)

    const replacement = `${file}.replacement`
    writeFileSync(replacement, JSON.stringify({ seq: 2 }) + '\n')
    renameSync(replacement, file)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(seen).not.toContain(2)
    expect(errors).toHaveLength(1)
  })

  it('keeps absolute entry offsets stable across overlapping tail bootstraps', async () => {
    const file = makeFile()
    for (let seq = 1; seq <= 4; seq += 1) {
      appendFileSync(file, JSON.stringify({ seq }) + '\n')
    }
    const initial = statSync(file)
    const expectedGenerationId = `${initial.dev}:${initial.ino}`
    const first: Array<{ seq: number; offset: number }> = []
    const firstTail = new FileTailer<{ seq: number }>(
      file,
      (entry, metadata) => first.push({ seq: entry.seq, offset: metadata.lineStartOffset }),
      undefined,
      { bootstrapTailLines: 3, expectedGenerationId },
    )
    openTailers.push(firstTail as FileTailer<unknown>)
    expect(first.map(value => value.seq)).toEqual([2, 3, 4])
    await firstTail.close()

    appendFileSync(file, JSON.stringify({ seq: 5 }) + '\n')
    appendFileSync(file, JSON.stringify({ seq: 6 }) + '\n')
    const second: Array<{ seq: number; offset: number }> = []
    const secondTail = new FileTailer<{ seq: number }>(
      file,
      (entry, metadata) => second.push({ seq: entry.seq, offset: metadata.lineStartOffset }),
      undefined,
      { bootstrapTailLines: 5, expectedGenerationId },
    )
    openTailers.push(secondTail as FileTailer<unknown>)

    expect(second.map(value => value.seq)).toEqual([2, 3, 4, 5, 6])
    for (const seq of [2, 3, 4]) {
      expect(second.find(value => value.seq === seq)?.offset)
        .toBe(first.find(value => value.seq === seq)?.offset)
    }
    expect(new Set(second.map(value => value.offset)).size).toBe(second.length)
    expect(second.map(value => value.offset)).toEqual(
      [...second.map(value => value.offset)].sort((a, b) => a - b),
    )
  })

  it('does not emit callbacks after close resolves', async () => {
    const file = makeFile()
    const seen: number[] = []
    const watcher = tail(file, seen)
    await watcher.close()
    appendFileSync(file, JSON.stringify({ seq: 1 }) + '\n')
    await new Promise(r => setTimeout(r, 250))
    expect(seen).not.toContain(1)
  })
})
