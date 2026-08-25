import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IPty } from 'node-pty'

import { afterEach, describe, expect, it } from 'vitest'

import { normalizePromptForOwnership } from './FreshRolloutClaim.js'
import { acquireFreshRolloutCoordinator } from './FreshRolloutOwnershipCoordinatorRegistry.js'
import { CodexHeadless } from '../CodexHeadless.js'

type RecordedOwnershipFixture = {
  ownership: { localPromptToken: string }
  lines: Array<Record<string, unknown>>
}

const fixtureRoot = fileURLToPath(
  new URL('../../testing/fixtures/rollout-ownership/', import.meta.url),
)
const temporaryDirectories: string[] = []

function loadFixture(id: string): RecordedOwnershipFixture {
  return JSON.parse(
    readFileSync(`${fixtureRoot}${id}.json`, 'utf8'),
  ) as RecordedOwnershipFixture
}

function rolloutText(fixture: RecordedOwnershipFixture): string {
  return `${fixture.lines.map(line => JSON.stringify(line)).join('\n')}\n`
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('process-wide fresh rollout watcher', () => {
  it('shares sequential candidate visibility across two live acquisitions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-owner-'))
    temporaryDirectories.push(root)
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const errors: Error[] = []
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: (error: Error) => errors.push(error),
    }
    const alphaAcquisition = await acquireFreshRolloutCoordinator(options)
    const betaAcquisition = await acquireFreshRolloutCoordinator(options)
    const alpha = loadFixture('concurrent-01491-alpha')
    const beta = loadFixture('concurrent-01491-beta')
    const alphaLeases: string[] = []
    const betaLeases: string[] = []
    const alphaHandle = alphaAcquisition.coordinator.registerParticipant({
      participantId: `alpha-${root}`,
      cwd: '/recorded/worktree',
      onLease: lease => alphaLeases.push(lease.filePath),
    })
    const betaHandle = betaAcquisition.coordinator.registerParticipant({
      participantId: `beta-${root}`,
      cwd: '/recorded/worktree',
      onLease: lease => betaLeases.push(lease.filePath),
    })

    expect(alphaAcquisition.coordinator).toBe(betaAcquisition.coordinator)
    alphaHandle.registerPrompt(alpha.ownership.localPromptToken)
    betaHandle.registerPrompt(alpha.ownership.localPromptToken)

    const alphaPath = join(
      day,
      'rollout-2026-08-24T00-00-00-00000000-0000-4000-8000-000000000001.jsonl',
    )
    writeFileSync(alphaPath, rolloutText(alpha))
    expect(await waitFor(() =>
      alphaAcquisition.coordinator.inspect().observedCandidateCount === 1,
    )).toBe(true)
    expect(alphaLeases).toEqual([])
    expect(betaLeases).toEqual([])

    // WHY beta keeps its recorded wrapper/order and changes only the reviewed
    // equality class: the collision policy needs identical private prompt text,
    // but inventing a second rollout wire shape would recreate the original
    // false-confidence problem this corpus exists to prevent.
    const betaPrompt = normalizePromptForOwnership(beta.ownership.localPromptToken)
    const collidingLines = beta.lines.map(line => {
      const copy = structuredClone(line)
      const payload = copy.payload as {
        type?: unknown
        message?: unknown
        role?: unknown
        content?: Array<{ type?: unknown; text?: unknown }>
      } | undefined
      if (payload?.type === 'user_message' &&
        typeof payload.message === 'string' &&
        normalizePromptForOwnership(payload.message) === betaPrompt) {
        payload.message = alpha.ownership.localPromptToken
      }
      if (payload?.role === 'user' && Array.isArray(payload.content)) {
        for (const item of payload.content) {
          if (typeof item.text === 'string' &&
            normalizePromptForOwnership(item.text) === betaPrompt) {
            item.text = alpha.ownership.localPromptToken
          }
        }
      }
      return copy
    })
    const betaPath = join(
      day,
      'rollout-2026-08-24T00-00-01-00000000-0000-4000-8000-000000000002.jsonl',
    )
    writeFileSync(
      betaPath,
      `${collidingLines.map(line => JSON.stringify(line)).join('\n')}\n`,
    )
    expect(await waitFor(() =>
      alphaAcquisition.coordinator.inspect().observedCandidateCount === 2,
    )).toBe(true)
    expect(alphaLeases).toEqual([])
    expect(betaLeases).toEqual([])
    expect(errors).toEqual([])

    alphaHandle.unregister()
    betaHandle.unregister()
    await alphaAcquisition.release()
    await betaAcquisition.release()
  })

  it('routes the recorded subagent through exact identity before tailing', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-exact-owner-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    writeFileSync(rolloutPath, rolloutText(fixture))
    const dataListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(
      event: { exitCode: number; signal?: number },
    ) => void>()
    const pty = {
      write: () => undefined,
      resize: () => undefined,
      onData: (listener: (data: string) => void) => {
        dataListeners.add(listener)
        return { dispose: () => dataListeners.delete(listener) }
      },
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListeners.add(listener)
        return { dispose: () => exitListeners.delete(listener) }
      },
    } as unknown as IPty
    const headless = new CodexHeadless({
      pty,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const seenThreadIds: string[] = []
    headless.on('rollout-entry', line => {
      if (line.type !== 'session_meta') return
      const id = (line.payload as { id?: unknown }).id
      if (typeof id === 'string') seenThreadIds.push(id)
    })

    try {
      await headless.start()
      expect(await waitFor(() => seenThreadIds.includes(threadId))).toBe(true)
      expect(headless.getSessionMeta()?.id).toBe(threadId)
    } finally {
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })
})
