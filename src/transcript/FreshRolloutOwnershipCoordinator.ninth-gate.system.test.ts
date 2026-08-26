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

import { CodexHeadless } from '../CodexHeadless.js'
import type {
  FreshRolloutParticipantHandle,
} from './FreshRolloutOwnershipCoordinator.js'
import {
  acquireFreshRolloutCoordinator,
  emitFreshRolloutChangeAndDrainForTesting,
  inspectFreshRolloutTransportForTesting,
  suppressFreshRolloutChangeEventsForTesting,
} from './FreshRolloutOwnershipCoordinatorRegistry.js'
import {
  prepareCodexResumeRollout,
  type CodexResumeRolloutPreparation,
} from './CodexResumeRolloutPreparation.js'

type RecordedOwnershipFixture = {
  ownership: { localPromptToken: string }
  lines: Array<Record<string, unknown>>
}

type LifecycleSchedule = {
  recordedPackageHead: string
  ch01: {
    exact: { fixtureId: string }
    fresh: { fixtureId: string }
    lineage: { fixtureId: string; forkThreadId: string }
  }
  ch02: {
    fixtureId: string
    rolloutThreadId: string
    inactiveExpiryAdvanceMs: number
    rescanDeadlineMs: number
  }
  ch03: {
    fixtureId: string
    rolloutThreadId: string
    inactiveExpiryAdvanceMs: number
  }
}

const fixtureRoot = fileURLToPath(
  new URL('../../testing/fixtures/rollout-ownership/', import.meta.url),
)
// WHY the lifecycle artifact records only reviewed scheduler facts. Rollout
// bytes still come from the hashed real-provider corpus; keeping inode/event/
// timer order in a separate inspectable file prevents a later green repair from
// quietly rewriting the failure schedule inside its own implementation test.
const lifecycleSchedule = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../testing/fixtures/ninth-gate/rollout-lifecycle-93c6fcbe-recorded.json',
  import.meta.url,
)), 'utf8')) as LifecycleSchedule
const temporaryDirectories: string[] = []

function loadFixture(id: string): RecordedOwnershipFixture {
  return JSON.parse(
    readFileSync(`${fixtureRoot}${id}.json`, 'utf8'),
  ) as RecordedOwnershipFixture
}

function rolloutText(fixture: RecordedOwnershipFixture): string {
  return `${fixture.lines.map(line => JSON.stringify(line)).join('\n')}\n`
}

function fixtureThreadId(fixture: RecordedOwnershipFixture): string {
  const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
  const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
  if (typeof threadId !== 'string') {
    throw new Error('recorded rollout fixture has no thread id')
  }
  return threadId
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  return root
}

function inertPty(): IPty {
  return {
    write: () => undefined,
    resize: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

function installRecordedExactRollout(options: {
  codexHome: string
  fixture: RecordedOwnershipFixture
  threadId?: string
}): { rolloutPath: string; sessionsRoot: string; threadId: string } {
  const sessionsRoot = join(options.codexHome, 'sessions')
  const day = join(sessionsRoot, '2026', '08', '24')
  mkdirSync(day, { recursive: true })
  const threadId = options.threadId ?? fixtureThreadId(options.fixture)
  const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
  writeFileSync(rolloutPath, rolloutText(options.fixture))
  return { rolloutPath, sessionsRoot, threadId }
}

afterEach(() => {
  vi.useRealTimers()
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('ninth-gate rollout lifecycle recordings', () => {
  describe('CH-01 synchronous no-tail-open retry', () => {
    it('cleanly releases the recorded exact lease when initial tail construction throws', async () => {
      const codexHome = temporaryRoot('codex-ch01-exact-')
      const fixture = loadFixture(lifecycleSchedule.ch01.exact.fixtureId)
      const { sessionsRoot, threadId } = installRecordedExactRollout({
        codexHome,
        fixture,
      })
      const preparation = await prepareCodexResumeRollout({
        sessionsDir: sessionsRoot,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      const headless = new CodexHeadless({
        pty: inertPty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: preparation,
      })
      const internal = headless as unknown as {
        tailFile(filePath: string, generationId?: string | null): () => Promise<void>
      }
      internal.tailFile = () => {
        // WHY this throw is before any stop closure exists. The Stage 29
        // lifecycle schedule distinguishes it from an asynchronous close
        // failure after a watcher/file descriptor may have escaped; treating
        // both as uncertain permanently bricks an otherwise safe exact retry.
        throw new Error('recorded synchronous exact tail construction failure')
      }
      const retry: { value: CodexResumeRolloutPreparation | null } = {
        value: null,
      }

      try {
        await expect(headless.start()).rejects.toThrow(
          /synchronous exact tail construction failure/,
        )
        await expect(prepareCodexResumeRollout({
          sessionsDir: sessionsRoot,
          cwd: '/recorded/worktree',
          resumeThreadId: threadId,
        }).then(value => {
          retry.value = value
          return value
        })).resolves.toBeDefined()
      } finally {
        await retry.value?.dispose(true)
        await headless.stop()
      }
    })

    it('cleanly releases the recorded fresh lease when tail construction throws', async () => {
      const codexHome = temporaryRoot('codex-ch01-fresh-')
      const previousCodexHome = process.env.CODEX_HOME
      process.env.CODEX_HOME = codexHome
      const fixture = loadFixture(lifecycleSchedule.ch01.fresh.fixtureId)
      const threadId = fixtureThreadId(fixture)
      const sessionsRoot = join(codexHome, 'sessions')
      const day = join(sessionsRoot, '2026', '08', '24')
      mkdirSync(day, { recursive: true })
      const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
      const headless = new CodexHeadless({
        pty: inertPty(),
        cwd: '/recorded/worktree',
      })
      const internal = headless as unknown as {
        freshRolloutParticipant: FreshRolloutParticipantHandle | null
        tailFile(filePath: string, generationId?: string | null): () => Promise<void>
      }
      let tailConstructionAttempts = 0
      internal.tailFile = () => {
        tailConstructionAttempts += 1
        // WHY the coordinator callback is synchronous. This exact failure
        // happens before CodexHeadless receives a physical-tail stop closure,
        // so the lease is cleanly retryable even though a later close failure
        // from the same callback boundary would remain uncertain.
        throw new Error('recorded synchronous fresh tail construction failure')
      }
      const retry: { value: CodexResumeRolloutPreparation | null } = {
        value: null,
      }

      try {
        await headless.start()
        internal.freshRolloutParticipant?.registerPrompt(
          fixture.ownership.localPromptToken,
        )
        writeFileSync(rolloutPath, rolloutText(fixture))
        expect(await waitFor(() => tailConstructionAttempts === 1)).toBe(true)

        await expect(prepareCodexResumeRollout({
          sessionsDir: sessionsRoot,
          cwd: '/recorded/worktree',
          resumeThreadId: threadId,
        }).then(value => {
          retry.value = value
          return value
        })).resolves.toBeDefined()
      } finally {
        await retry.value?.dispose(true)
        await headless.stop()
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = previousCodexHome
      }
    })

    it('cleanly releases the recorded lineage lease when fork tail construction throws', async () => {
      const codexHome = temporaryRoot('codex-ch01-lineage-')
      const fixture = loadFixture(lifecycleSchedule.ch01.lineage.fixtureId)
      const { sessionsRoot, threadId } = installRecordedExactRollout({
        codexHome,
        fixture,
      })
      const forkThreadId = lifecycleSchedule.ch01.lineage.forkThreadId
      const forkFixture = structuredClone(fixture)
      const sessionMeta = forkFixture.lines.find(line => line.type === 'session_meta')
      ;(sessionMeta!.payload as { id: string }).id = forkThreadId
      const forkDay = join(sessionsRoot, '2026', '08', '24')
      const forkPath = join(
        forkDay,
        `rollout-recorded-${forkThreadId}.jsonl`,
      )
      const preparation = await prepareCodexResumeRollout({
        sessionsDir: sessionsRoot,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      const headless = new CodexHeadless({
        pty: inertPty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: preparation,
      })
      const internal = headless as unknown as {
        tailFile(filePath: string, generationId?: string | null): () => Promise<void>
      }
      const openExactTail = internal.tailFile.bind(headless)
      let forkTailConstructionAttempts = 0
      internal.tailFile = (filePath, generationId) => {
        if (filePath.endsWith(`${forkThreadId}.jsonl`)) {
          forkTailConstructionAttempts += 1
          // WHY X is already physically open, but Y is not. The failed switch
          // must leave X live and retire only Y cleanly; tombstoning Y because
          // the older X has resources conflates two independent path leases.
          throw new Error('recorded synchronous lineage tail construction failure')
        }
        return openExactTail(filePath, generationId)
      }
      const retry: { value: CodexResumeRolloutPreparation | null } = {
        value: null,
      }

      try {
        await headless.start()
        writeFileSync(forkPath, rolloutText(forkFixture))
        expect(await waitFor(() => forkTailConstructionAttempts === 1, 5000))
          .toBe(true)

        await expect(prepareCodexResumeRollout({
          sessionsDir: sessionsRoot,
          cwd: '/recorded/worktree',
          resumeThreadId: forkThreadId,
        }).then(value => {
          retry.value = value
          return value
        })).resolves.toBeDefined()
      } finally {
        await retry.value?.dispose(true)
        await headless.stop()
      }
    }, 15_000)
  })

  it('CH-02 rescans an unresolved recorded candidate after unrelated compaction misses its append event', async () => {
    const root = temporaryRoot('codex-ch02-rescan-')
    const fixture = loadFixture(lifecycleSchedule.ch02.fixtureId)
    const prompt = fixture.ownership.localPromptToken
    const promptLineIndex = fixture.lines.findIndex(line =>
      JSON.stringify(line).includes(prompt),
    )
    if (promptLineIndex <= 0) {
      throw new Error('recorded fixture has no appendable prompt boundary')
    }
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(
      day,
      `rollout-recorded-${lifecycleSchedule.ch02.rolloutThreadId}.jsonl`,
    )
    const bootstrap = fixture.lines.slice(0, promptLineIndex)
    const appended = fixture.lines.slice(promptLineIndex)
    writeFileSync(
      rolloutPath,
      `${bootstrap.map(line => JSON.stringify(line)).join('\n')}\n`,
    )
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const expiringAcquisition = await acquireFreshRolloutCoordinator(options)
    const liveAcquisition = await acquireFreshRolloutCoordinator(options)
    const expiring = expiringAcquisition.coordinator.registerParticipant({
      participantId: `unrelated-expiring-${root}`,
      cwd: '/recorded/worktree',
      onLease: () => undefined,
    })
    const leases: string[] = []
    const live = liveAcquisition.coordinator.registerParticipant({
      participantId: `unresolved-live-${root}`,
      cwd: '/recorded/worktree',
      onLease: lease => leases.push(lease.filePath),
    })

    try {
      expect(await waitFor(() =>
        liveAcquisition.coordinator.inspect().observedCandidateCount === 1,
      )).toBe(true)
      live.registerPrompt(prompt)

      // WHY this removes only the append notification. The Stage 29 schedule
      // records that filesystem watchers may omit/coalesce this event; the
      // existing 500ms rescan is the independent recovery path under test.
      // Closing the watcher would test shutdown instead and deleting the file
      // would invent provider behavior not present in the recorded rollout.
      suppressFreshRolloutChangeEventsForTesting(
        liveAcquisition.coordinator,
      )
      vi.useFakeTimers()
      expiring.unregister()
      await expiringAcquisition.release()
      await vi.advanceTimersByTimeAsync(
        lifecycleSchedule.ch02.inactiveExpiryAdvanceMs,
      )
      vi.useRealTimers()

      appendFileSync(
        rolloutPath,
        `${appended.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      expect(await waitFor(
        () => leases.length === 1,
        lifecycleSchedule.ch02.rescanDeadlineMs,
      )).toBe(true)
      expect(leases).toEqual([rolloutPath])
    } finally {
      vi.useRealTimers()
      expiring.unregister()
      live.unregister()
      liveAcquisition.coordinator.retireOwnerLeases(
        `unresolved-live-${root}`,
        true,
      )
      await expiringAcquisition.release()
      await liveAcquisition.release()
    }
  }, 10_000)

  it('CH-03 does not re-retain a terminal recorded candidate after a delayed event', async () => {
    const root = temporaryRoot('codex-ch03-terminal-retention-')
    const fixture = loadFixture(lifecycleSchedule.ch03.fixtureId)
    const prompt = fixture.ownership.localPromptToken
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(
      day,
      `rollout-recorded-${lifecycleSchedule.ch03.rolloutThreadId}.jsonl`,
    )
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const expiringAcquisition = await acquireFreshRolloutCoordinator(options)
    const liveAcquisition = await acquireFreshRolloutCoordinator(options)
    const expiring = expiringAcquisition.coordinator.registerParticipant({
      participantId: `terminal-unrelated-expiring-${root}`,
      cwd: '/recorded/worktree',
      onLease: () => undefined,
    })
    const leases: string[] = []
    const terminalOwnerId = `terminal-live-${root}`
    const terminal = liveAcquisition.coordinator.registerParticipant({
      participantId: terminalOwnerId,
      cwd: '/recorded/worktree',
      onLease: lease => leases.push(lease.filePath),
    })

    try {
      terminal.registerPrompt(prompt)
      writeFileSync(rolloutPath, rolloutText(fixture))
      expect(await waitFor(() => leases.length === 1)).toBe(true)

      vi.useFakeTimers()
      expiring.unregister()
      await expiringAcquisition.release()
      await vi.advanceTimersByTimeAsync(
        lifecycleSchedule.ch03.inactiveExpiryAdvanceMs,
      )
      expect(inspectFreshRolloutTransportForTesting(
        liveAcquisition.coordinator,
      )).toMatchObject({ knownPathCount: 0, lastFingerprintCount: 0 })

      // WHY the event was admitted before transport compaction but delivered
      // after it in the Stage 29 schedule. Re-emitting the real candidate path
      // changes only callback/timer order. The candidate is already leased and
      // therefore terminal; a late callback may confirm that fact but must not
      // resurrect its UUID-bearing path in watcher retention indefinitely.
      await emitFreshRolloutChangeAndDrainForTesting(
        liveAcquisition.coordinator,
        rolloutPath,
      )
      expect(inspectFreshRolloutTransportForTesting(
        liveAcquisition.coordinator,
      )).toMatchObject({ knownPathCount: 0, lastFingerprintCount: 0 })
    } finally {
      vi.useRealTimers()
      expiring.unregister()
      terminal.unregister()
      liveAcquisition.coordinator.retireOwnerLeases(terminalOwnerId, true)
      await expiringAcquisition.release()
      await liveAcquisition.release()
    }
  }, 10_000)
})
