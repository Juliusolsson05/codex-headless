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

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
} from './FreshRolloutClaim.js'
import { acquireFreshRolloutCoordinator } from './FreshRolloutOwnershipCoordinatorRegistry.js'
import {
  prepareCodexResumeRollout,
  type CodexResumeRolloutPreparation,
} from './CodexResumeRolloutPreparation.js'
import { normalizeRolloutOwnershipPath } from './OwnershipNormalization.js'
import { CodexHeadless } from '../CodexHeadless.js'
import * as codexHeadlessApi from '../index.js'

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

function prepareRecordedResume(options: {
  codexHome: string
  cwd: string
  resumeThreadId: string
}): Promise<CodexResumeRolloutPreparation> {
  return prepareCodexResumeRollout({
    sessionsDir: join(options.codexHome, 'sessions'),
    cwd: options.cwd,
    resumeThreadId: options.resumeThreadId,
  })
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
  vi.useRealTimers()
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
    const cancelledPreparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const cancelled = new CodexHeadless({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: cancelledPreparation,
    })
    let replacement: CodexHeadless | null = null

    try {
      // WHY SessionManager has this exact ordering when cancellation wins its
      // race with provider startup. start() still finishes its awaited setup,
      // but must close that late acquisition before its second stop arrives.
      await cancelled.stop()
      await cancelled.start()

      const replacementPreparation = await prepareRecordedResume({
        codexHome,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      replacement = new CodexHeadless({
        pty: makePty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: replacementPreparation,
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

  it('prepares recorded resume lineage before a reconstructed fork can exist', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-pre-spawn-resume-'))
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
    const forkThreadId = '00000000-0000-4000-8000-000000000055'
    const forkLines = structuredClone(fixture.lines)
    ;(forkLines[sessionMetaIndex]!.payload as { id: string }).id = forkThreadId
    const sessionsRoot = join(codexHome, 'sessions')
    const day = join(sessionsRoot, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, `rollout-recorded-${threadId}.jsonl`),
      rolloutText(fixture),
    )
    const errors: Error[] = []
    const freshAcquisition = await acquireFreshRolloutCoordinator({
      sessionsRoot,
      normalizeCwd: normalizeRolloutOwnershipPath,
      normalizePath: normalizeRolloutOwnershipPath,
      onError: error => errors.push(error),
    })
    const freshLeases: string[] = []
    const fresh = freshAcquisition.coordinator.registerParticipant({
      participantId: `pre-spawn-fresh-${codexHome}`,
      cwd: '/recorded/worktree',
      onLease: lease => freshLeases.push(lease.filePath),
    })
    const parsedFork = parseFreshRolloutCandidate(
      `/recorded/${fixture.ownership.localPromptToken ?? 'exact'}.jsonl`,
      rolloutText(fixture),
    )
    const copiedPrompt = parsedFork?.userMessages.at(-1)?.text
    if (!copiedPrompt) throw new Error('recorded exact fixture has no copied prompt')
    fresh.registerPrompt(copiedPrompt)
    const prepare = (codexHeadlessApi as unknown as {
      prepareCodexResumeRollout?: (options: {
        sessionsDir: string
        cwd: string
        resumeThreadId: string
      }) => Promise<unknown>
    }).prepareCodexResumeRollout
    let preparation: unknown = null
    let resumed: CodexHeadless | null = null

    try {
      // WHY preparation must complete before the consumer spawns Codex: Y can
      // be created immediately by that process, while headless.start() still
      // has asynchronous locator/file reads ahead of lineage registration.
      expect(prepare).toBeTypeOf('function')
      if (!prepare) return
      preparation = await prepare({
        sessionsDir: sessionsRoot,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      const makePty = (): IPty => ({
        write: () => undefined,
        resize: () => undefined,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
      }) as unknown as IPty
      const PreparedCodexHeadless = CodexHeadless as unknown as new (options: {
        pty: IPty
        cwd: string
        resumeThreadId: string
        resumeRolloutPreparation: unknown
      }) => CodexHeadless
      resumed = new PreparedCodexHeadless({
        pty: makePty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: preparation,
      })
      const forkPaths: string[] = []
      resumed.on('rollout-entry', (_line, filePath) => {
        if (filePath.endsWith(`${forkThreadId}.jsonl`)) forkPaths.push(filePath)
      })

      // This write stands in for the already-spawned provider. The sibling
      // watcher is intentionally live before Y exists, reproducing the gate's
      // callback ordering without an imagined rollout wire shape.
      writeFileSync(
        join(day, `rollout-recorded-${forkThreadId}.jsonl`),
        `${forkLines.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      await resumed.start()

      expect(await waitFor(() => forkPaths.length > 0, 5000)).toBe(true)
      expect(freshLeases).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await resumed?.stop()
      await (preparation as { dispose?: () => Promise<void> } | null)?.dispose?.()
      fresh.unregister()
      freshAcquisition.coordinator.retireOwnerLeases(
        `pre-spawn-fresh-${codexHome}`,
        true,
      )
      await freshAcquisition.release()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  }, 15_000)

  it('keeps exact resume alive when a buffered ignored-fork observer throws', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-buffered-diagnostic-'))
    temporaryDirectories.push(codexHome)
    const exact = loadFixture('subagent-0149-exact-attachment')
    const unrelated = loadFixture('modern-0149-agents-first')
    const exactMeta = exact.lines.find(line => line.type === 'session_meta')
    const unrelatedMeta = unrelated.lines.find(line => line.type === 'session_meta')
    const threadId = (exactMeta?.payload as { id?: unknown } | undefined)?.id
    const unrelatedThreadId = (
      unrelatedMeta?.payload as { id?: unknown } | undefined
    )?.id
    if (typeof threadId !== 'string' || typeof unrelatedThreadId !== 'string') {
      throw new Error('recorded diagnostic fixtures have no thread ids')
    }
    const sessionsRoot = join(codexHome, 'sessions')
    const day = join(sessionsRoot, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const exactPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    writeFileSync(exactPath, rolloutText(exact))
    const preparation = await prepareCodexResumeRollout({
      sessionsDir: sessionsRoot,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const monitor = await acquireFreshRolloutCoordinator({
      sessionsRoot,
      normalizeCwd: normalizeRolloutOwnershipPath,
      normalizePath: normalizeRolloutOwnershipPath,
      onError: () => undefined,
    })
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
      resumeRolloutPreparation: preparation,
    })
    const exactEntries: string[] = []
    resumed.on('rollout-entry', (_line, filePath) => {
      if (filePath === exactPath) exactEntries.push(filePath)
    })
    resumed.on('rollout-diagnostic', diagnostic => {
      if (diagnostic.type === 'resume-fork-ignored') {
        throw new Error('recorded diagnostic observer failure')
      }
    })

    try {
      const observedBefore = monitor.coordinator.inspect().observedCandidateCount
      writeFileSync(
        join(day, `rollout-recorded-${unrelatedThreadId}.jsonl`),
        rolloutText(unrelated),
      )
      // Waiting before start is essential: it proves the decision uses the
      // preparation's buffered replay path, not the coordinator's already
      // exception-isolated live callback path.
      expect(await waitFor(() =>
        monitor.coordinator.inspect().observedCandidateCount > observedBefore,
      )).toBe(true)

      await expect(resumed.start()).resolves.toMatchObject({ sessionsDir: sessionsRoot })
      expect(await waitFor(() => exactEntries.length > 0)).toBe(true)
    } finally {
      await resumed.stop()
      await preparation.dispose()
      await monitor.release()
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

  it('expires a stopped owner while a sibling acquisition keeps the root live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-live-sibling-'))
    temporaryDirectories.push(root)
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const stoppedAcquisition = await acquireFreshRolloutCoordinator(options)
    const siblingAcquisition = await acquireFreshRolloutCoordinator(options)
    const participantId = `stopped-with-live-sibling-${root}`
    const stopped = stoppedAcquisition.coordinator.registerParticipant({
      participantId,
      cwd: '/recorded/worktree',
      onLease: () => undefined,
    })
    const fixture = loadFixture('modern-0149-agents-first')
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, 'rollout-recorded-00000000-0000-4000-8000-000000000066.jsonl'),
      rolloutText(fixture),
    )
    expect(await waitFor(() =>
      stoppedAcquisition.coordinator.inspect().observedCandidateCount > 0,
    )).toBe(true)
    expect(
      (stoppedAcquisition.coordinator.inspectRetentionForTesting() as {
        candidates: Array<{ hasRawPath: boolean }>
      }).candidates.some(candidate => candidate.hasRawPath),
    ).toBe(true)
    vi.useFakeTimers()

    try {
      stopped.registerPrompt('recorded tombstone lifetime')
      stopped.unregister()
      await stoppedAcquisition.release()
      await vi.advanceTimersByTimeAsync(6000)

      // WHY root reference count is watcher transport, not participant
      // lifetime. A long-running sibling cannot retain every stopped prompt
      // HMAC forever merely because its own PTY still needs file events.
      expect(JSON.stringify(
        siblingAcquisition.coordinator.inspectRetentionForTesting(),
      )).not.toContain(participantId)
      expect(
        (siblingAcquisition.coordinator.inspectRetentionForTesting() as {
          candidates: Array<{ hasRawPath: boolean }>
        }).candidates.every(candidate => !candidate.hasRawPath),
      ).toBe(true)
      const symbol = Symbol.for(
        'codex-headless.fresh-rollout-ownership-coordinator-registry',
      )
      const registry = (globalThis as typeof globalThis & {
        [symbol]?: {
          roots: Map<string, {
            coordinator: unknown
            referenceCount: number
            watcher: unknown
          }>
        }
      })[symbol]
      const rootEntry = [...(registry?.roots.values() ?? [])].find(
        entry => entry.coordinator === siblingAcquisition.coordinator,
      )
      expect(rootEntry).toMatchObject({ referenceCount: 1 })
      expect(rootEntry?.watcher).not.toBeNull()
    } finally {
      vi.useRealTimers()
      await siblingAcquisition.release()
    }
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
        const preparation = await prepareRecordedResume({
          codexHome,
          cwd: '/recorded/worktree',
          resumeThreadId: threadId,
        })
        const headless = new CodexHeadless({
          pty,
          cwd: '/recorded/worktree',
          resumeThreadId: threadId,
          resumeRolloutPreparation: preparation,
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

  it('releases the resume watcher when its bounded window expires', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-resume-window-'))
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
    const makePty = (): IPty => ({
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }) as unknown as IPty
    const ctor = CodexHeadless as unknown as {
      RESUME_FORK_WATCH_MS: number
      new(options: {
        pty: IPty
        cwd: string
        resumeThreadId: string
        resumeRolloutPreparation: CodexResumeRolloutPreparation
      }): CodexHeadless
    }
    const previousWindow = ctor.RESUME_FORK_WATCH_MS
    ctor.RESUME_FORK_WATCH_MS = 25
    const symbol = Symbol.for(
      'codex-headless.fresh-rollout-ownership-coordinator-registry',
    )
    const registryBefore = (globalThis as typeof globalThis & {
      [symbol]?: { roots: Map<string, unknown> }
    })[symbol]
    const keysBefore = new Set(registryBefore?.roots.keys() ?? [])
    const preparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const headless = new ctor({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: preparation,
    })
    const seenPaths: string[] = []
    headless.on('rollout-entry', (_line, filePath) => seenPaths.push(filePath))

    try {
      await headless.start()
      expect(await waitFor(() => seenPaths.includes(rolloutPath))).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 75))
      const registry = (globalThis as typeof globalThis & {
        [symbol]?: {
          roots: Map<string, { referenceCount: number; watcher: unknown }>
        }
      })[symbol]
      const rootKey = [...(registry?.roots.keys() ?? [])]
        .find(key => !keysBefore.has(key))
      if (!rootKey) throw new Error('resume root was not registered')
      const rootEntry = registry!.roots.get(rootKey)

      // WHY the exact JsonlTailer and the candidate watcher have different
      // lifetimes. The former remains the committed channel for X; the latter
      // exists only for the bounded possibility of reconstructed Y.
      expect(rootEntry).toMatchObject({ referenceCount: 0, watcher: null })
      const beforeAppend = seenPaths.length
      appendFileSync(rolloutPath, `${JSON.stringify(fixture.lines.at(-1))}\n`)
      expect(await waitFor(() => seenPaths.length > beforeAppend)).toBe(true)
    } finally {
      ctor.RESUME_FORK_WATCH_MS = previousWindow
      await headless.stop()
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
    const resumedPreparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const resumed = new CodexHeadless({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: resumedPreparation,
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
      const reopenedPreparation = await prepareRecordedResume({
        codexHome,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      reopened = new CodexHeadless({
        pty: makePty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: reopenedPreparation,
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
