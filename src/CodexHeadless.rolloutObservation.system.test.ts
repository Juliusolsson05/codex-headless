import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CodexHeadless,
  type CodexRolloutEntryObservation,
} from './CodexHeadless.js'
import { fingerprintProviderSession } from './transcript/ProviderSessionFingerprint.js'

const temporaryDirectories: string[] = []

function fakePty(): IPty {
  return {
    write: () => undefined,
    resize: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
}

function makeRollout(lines: readonly Record<string, unknown>[]): {
  file: string
  generationId: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'codex-rollout-observation-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'rollout.jsonl')
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  const stats = statSync(file)
  return { file, generationId: `${stats.dev}:${stats.ino}` }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(predicate()).toBe(true)
}

function startPrivateTail(
  headless: CodexHeadless,
  file: string,
  generationId: string,
): () => Promise<void> {
  return (headless as unknown as {
    tailFile(path: string, expectedGenerationId: string): () => Promise<void>
  }).tailFile(file, generationId)
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('Codex rollout observation sidecar', () => {
  it('joins the recorded session_meta UUID only through the provider-owned fingerprint', async () => {
    // The first line is sanitized from the 2026-08-30 incident rollout. The
    // second keeps the native session_meta shape but deliberately violates the
    // provider UUID contract, proving raw or malformed values cannot cross the
    // sidecar boundary.
    const providerSessionId = '01a053a8-0611-7711-9ca3-f69f130764ab'
    const lines = [
      { type: 'session_meta', payload: { id: providerSessionId } },
      { type: 'session_meta', payload: { id: 'not-a-provider-uuid' } },
    ]
    const { file, generationId } = makeRollout(lines)
    const headless = new CodexHeadless({ pty: fakePty(), cwd: '/recorded/worktree' })
    const observations: CodexRolloutEntryObservation[] = []
    headless.on('rollout-entry', (_line, _file, observation) => observations.push(observation))
    const stopTail = startPrivateTail(headless, file, generationId)

    await waitFor(() => observations.length === 2)
    expect(observations).toEqual([
      {
        fileGenerationId: generationId,
        rolloutByteOffset: 0,
        providerSessionMetaFingerprint: fingerprintProviderSession(providerSessionId),
      },
      {
        fileGenerationId: generationId,
        rolloutByteOffset: Buffer.byteLength(`${JSON.stringify(lines[0])}\n`),
      },
    ])

    await stopTail()
    await headless.stop()
  })

  it('keeps the absolute physical offset when a downstream listener throws', async () => {
    const lines = [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ]
    const { file, generationId } = makeRollout(lines)
    const headless = new CodexHeadless({ pty: fakePty(), cwd: '/recorded/worktree' })
    const observations: CodexRolloutEntryObservation[] = []
    let deliveries = 0
    headless.on('rollout-entry', (_line, _path, observation) => {
      deliveries += 1
      if (deliveries === 1) throw new Error('recorded consumer failure')
      observations.push(observation)
    })
    const stopTail = startPrivateTail(headless, file, generationId)

    await waitFor(() => observations.length === 1)
    expect(observations[0]).toMatchObject({
      rolloutByteOffset: Buffer.byteLength(`${JSON.stringify(lines[0])}\n`),
    })

    await stopTail()
    await headless.stop()
  })
})
