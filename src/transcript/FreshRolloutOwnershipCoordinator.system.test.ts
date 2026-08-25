import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  it('does not retain a raw sessions root in the process-global registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-private-root-'))
    temporaryDirectories.push(root)
    const acquisition = await acquireFreshRolloutCoordinator({
      sessionsRoot: root,
      normalizeCwd: value => value,
      normalizePath: value => value,
      onError: () => undefined,
    })
    await acquisition.release()

    const symbol = Symbol.for(
      'codex-headless.fresh-rollout-ownership-coordinator-registry',
    )
    const registry = (globalThis as typeof globalThis & {
      [symbol]?: { roots: Map<string, unknown> }
    })[symbol]
    expect(registry).toBeDefined()
    const serialized = JSON.stringify([...registry!.roots.entries()])
    expect(serialized).not.toContain(root)
    for (const key of registry!.roots.keys()) {
      expect(key).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('serializes overlapping headless stop calls around one tail cleanup', async () => {
    const pty = {
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty
    const headless = new CodexHeadless({
      pty,
      cwd: '/recorded/worktree',
    })
    let cleanupCalls = 0
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
    ;(headless as unknown as {
      stopRolloutTail: (() => Promise<void>) | null
    }).stopRolloutTail = async () => {
      cleanupCalls += 1
      await cleanupGate
    }

    const first = headless.stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = headless.stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cleanupCalls).toBe(1)
    releaseCleanup()
    await Promise.all([first, second])
  })

  it('makes explicit stop join cleanup already started by terminal exit', async () => {
    const pty = {
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty
    const headless = new CodexHeadless({
      pty,
      cwd: '/recorded/worktree',
    })
    let cleanupCalls = 0
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
    ;(headless as unknown as {
      stopRolloutTail: (() => Promise<void>) | null
    }).stopRolloutTail = async () => {
      cleanupCalls += 1
      await cleanupGate
    }
    const exitCleanup = (headless as unknown as {
      cleanup(): Promise<void>
    }).cleanup()
    await new Promise(resolve => setTimeout(resolve, 0))
    let stopSettled = false
    const explicitStop = headless.stop().then(() => { stopSettled = true })
    await new Promise(resolve => setTimeout(resolve, 0))

    // WHY a null stopRolloutTail does not mean cleanup finished: the exit path
    // takes the function before awaiting it. stop() must join that in-flight
    // promise so the parent cannot kill the PTY before lease retirement.
    expect(cleanupCalls).toBe(1)
    expect(stopSettled).toBe(false)
    releaseCleanup()
    await Promise.all([exitCleanup, explicitStop])
  })

  it('closes a recorded exact tail acquired after a pre-start stop', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-pre-start-stop-'))
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
    writeFileSync(
      join(day, `rollout-recorded-${threadId}.jsonl`),
      rolloutText(fixture),
    )
    const makePty = (): IPty => ({
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }) as unknown as IPty
    const cancelled = new CodexHeadless({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    let replacement: CodexHeadless | null = null

    try {
      // WHY SessionManager has this exact ordering when cancellation wins its
      // race with provider startup. start() still finishes its awaited setup,
      // but must close that late acquisition before its second stop arrives.
      await cancelled.stop()
      await cancelled.start()

      replacement = new CodexHeadless({
        pty: makePty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      await expect(replacement.start()).resolves.toMatchObject({
        sessionsDir: join(codexHome, 'sessions'),
      })
    } finally {
      await replacement?.stop()
      await cancelled.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('does not assign later appended prompt bytes to an earlier watcher sequence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-prefix-'))
    temporaryDirectories.push(root)
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const fixture = loadFixture('modern-0149-agents-first')
    const prompt = fixture.ownership.localPromptToken
    const promptLineIndex = fixture.lines.findIndex(line =>
      JSON.stringify(line).includes(prompt),
    )
    if (promptLineIndex <= 0) {
      throw new Error('recorded fixture has no appendable prompt boundary')
    }
    const rolloutPath = join(
      day,
      'rollout-prefix-00000000-0000-4000-8000-000000000003.jsonl',
    )
    const bootstrap = fixture.lines.slice(0, promptLineIndex)
    const appended = fixture.lines.slice(promptLineIndex)
    writeFileSync(
      rolloutPath,
      `${bootstrap.map(line => JSON.stringify(line)).join('\n')}\n`,
    )

    const errors: Error[] = []
    const acquisition = await acquireFreshRolloutCoordinator({
      sessionsRoot: root,
      normalizeCwd: value => value,
      normalizePath: value => value,
      onError: error => errors.push(error),
    })
    const leases: string[] = []
    const handle = acquisition.coordinator.registerParticipant({
      participantId: `prefix-${root}`,
      cwd: '/recorded/worktree',
      onLease: lease => leases.push(lease.filePath),
    })

    try {
      // WHY the file and its initial watcher observation predate the prompt:
      // this reproduces the actual queued-read race. Only the later append's
      // immutable byte boundary is causally eligible to prove ownership.
      handle.registerPrompt(prompt)
      appendFileSync(
        rolloutPath,
        `${appended.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      expect(await waitFor(() => leases.length === 1)).toBe(true)
      expect(leases).toEqual([rolloutPath])
      expect(errors).toEqual([])
    } finally {
      handle.unregister()
      acquisition.coordinator.retireOwnerLeases(`prefix-${root}`, true)
      await acquisition.release()
    }
  })

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
    try {
      const startAndStop = async (): Promise<void> => {
        const headless = new CodexHeadless({
          pty,
          cwd: '/recorded/worktree',
          resumeThreadId: threadId,
        })
        const seenPaths: string[] = []
        headless.on('rollout-entry', (_line, filePath) => {
          seenPaths.push(filePath)
        })
        try {
          await headless.start()
          expect(await waitFor(() => seenPaths.includes(rolloutPath))).toBe(true)
        } finally {
          await headless.stop()
        }
      }

      await startAndStop()
      // WHY this happens in one Node process: the regression was a permanent
      // process-global lease, so a new test process would hide the failure.
      await startAndStop()
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('reopens the original exact path after a recorded lineage switch closes it', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-lineage-switch-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMetaIndex = fixture.lines.findIndex(line => line.type === 'session_meta')
    const sessionMeta = fixture.lines[sessionMetaIndex]
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const forkThreadId = '00000000-0000-4000-8000-000000000044'
    const forkLines = structuredClone(fixture.lines)
    ;(forkLines[sessionMetaIndex]!.payload as { id: string }).id = forkThreadId
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const initialPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    const forkPath = join(day, `rollout-recorded-${forkThreadId}.jsonl`)
    writeFileSync(initialPath, rolloutText(fixture))

    const makePty = (): IPty => ({
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }) as unknown as IPty
    const resumed = new CodexHeadless({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const forkFiles: string[] = []
    resumed.on('rollout-entry', (_line, filePath) => {
      // normalizeCwd resolves macOS /var through /private/var before the shared
      // coordinator publishes a lease; the UUID-bearing basename is the exact
      // identity fact this assertion needs.
      if (filePath.endsWith(`${forkThreadId}.jsonl`)) forkFiles.push(filePath)
    })
    let reopened: CodexHeadless | null = null
    const reopenedPaths: string[] = []

    try {
      await resumed.start()
      writeFileSync(
        forkPath,
        `${forkLines.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      expect(await waitFor(() => forkFiles.length > 0, 5000)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 100))

      // WHY A remains live on Y while B opens X: a lease belongs to a physical
      // tail, not forever to every path a logical resumed session once used.
      // Reopening X must wait for X's close, but not for A's eventual stop.
      reopened = new CodexHeadless({
        pty: makePty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      reopened.on('rollout-entry', (_line, filePath) => {
        reopenedPaths.push(filePath)
      })
      await expect(reopened.start()).resolves.toMatchObject({
        sessionsDir: join(codexHome, 'sessions'),
      })
      // WHY the recorded 600-line rollout is intentionally not flattened for
      // this assertion: JsonlTailer bootstraps the last 200 lines, while the
      // session_meta lives on line one. Receiving entries from X proves that X
      // was reopened without teaching the test an impossible metadata promise.
      expect(await waitFor(() => reopenedPaths.includes(initialPath))).toBe(true)
    } finally {
      await reopened?.stop()
      await resumed.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  }, 15_000)
})
