import { appendFileSync, mkdtempSync, renameSync, truncateSync, writeFileSync } from 'fs'
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

function makeFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'tailer-test-')), 'rollout.jsonl')
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
  while (openTailers.length > 0) await openTailers.pop()?.close()
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
