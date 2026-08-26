import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FreshRolloutOwnershipCoordinator } from './FreshRolloutOwnershipCoordinator.js'
import {
  acquireFreshRolloutCoordinator,
  emitFreshRolloutChangeAndDrainForTesting,
  inspectFreshRolloutTransportForTesting,
  suppressFreshRolloutChangeEventsForTesting,
} from './FreshRolloutOwnershipCoordinatorRegistry.js'

const NO_BIRTH_TIME_TARGET = Symbol.for(
  'codex-headless.eleventh-gate.no-birth-time-target',
)
const REGISTRY_SYMBOL = Symbol.for(
  'codex-headless.fresh-rollout-ownership-coordinator-registry',
)

// WHY the reviewed counterexample is specifically a filesystem that cannot
// report creation time. macOS normally supplies birthtimeMs, so relying on the
// host would silently exercise the healthy branch. This wrapper changes only
// that one stat field for one recorded path; chokidar, file bytes, inode,
// timestamps, and every other fs operation remain real.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const value = actual.statSync(...args)
      const configured = (globalThis as typeof globalThis & {
        [NO_BIRTH_TIME_TARGET]?: string
      })[NO_BIRTH_TIME_TARGET]
      const requested = typeof args[0] === 'string' ? resolve(args[0]) : null
      if (!configured || requested !== configured || !value) return value
      return new Proxy(value, {
        get(target, property, receiver) {
          if (property === 'birthtimeMs') return 0
          return Reflect.get(target, property, receiver)
        },
      })
    },
  }
})

type RecordedOwnershipFixture = {
  provenance: { sourceLabel: string }
  lines: Array<Record<string, unknown>>
}

type EleventhGateReview = {
  heads: { codexHeadless: string }
  confirmedFindings: string[]
}

const exactFixturePath = fileURLToPath(new URL(
  '../../testing/fixtures/rollout-ownership/' +
    'subagent-0149-exact-attachment.json',
  import.meta.url,
))
const reviewPath = fileURLToPath(new URL(
  '../../testing/fixtures/eleventh-gate/review-9a5f3e22-recorded.json',
  import.meta.url,
))
const fixture = JSON.parse(
  readFileSync(exactFixturePath, 'utf8'),
) as RecordedOwnershipFixture
const review = JSON.parse(
  readFileSync(reviewPath, 'utf8'),
) as EleventhGateReview
const temporaryDirectories: string[] = []

function rolloutText(): string {
  return `${fixture.lines.map(line => JSON.stringify(line)).join('\n')}\n`
}

function fixtureThreadId(): string {
  const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
  const id = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
  if (typeof id !== 'string') throw new Error('recorded exact fixture has no id')
  return id
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  return root
}

function installExactRollout(root: string): string {
  const day = join(root, '2026', '08', '26')
  mkdirSync(day, { recursive: true })
  const filePath = join(day, `rollout-recorded-${fixtureThreadId()}.jsonl`)
  writeFileSync(filePath, rolloutText())
  return filePath
}

function registryGlobal(): object | null {
  return (globalThis as typeof globalThis & {
    [REGISTRY_SYMBOL]?: object
  })[REGISTRY_SYMBOL] ?? null
}

function transportCounts(
  coordinator: FreshRolloutOwnershipCoordinator,
): { knownPathCount: number; lastFingerprintCount: number } {
  const inspection = inspectFreshRolloutTransportForTesting(coordinator)
  // WHY this contract projects only the two retention counts under review.
  // The bridge snapshot also carries count-only lifecycle evidence for older
  // watcher tests; destructuring prevents an exact equality assertion from
  // accidentally coupling CH-13 to those adjacent counters.
  return {
    knownPathCount: inspection.knownPathCount,
    lastFingerprintCount: inspection.lastFingerprintCount,
  }
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  return predicate()
}

function projectReflectiveReachability(options: {
  globalValue: object
  coordinator: FreshRolloutOwnershipCoordinator
  rawPath: string
  participantId: string
}): Record<string, boolean> {
  const visited = new WeakSet<object>()
  const projection = {
    globalValueIsFrozen: Object.isFrozen(options.globalValue),
    reachableMap: false,
    reachableSet: false,
    reachableHmacKey: false,
    reachableCoordinator: false,
    reachableRawPath: false,
    reachableParticipantId: false,
  }

  const visit = (value: unknown, propertyName: string | null, depth: number): void => {
    if (typeof value === 'string') {
      projection.reachableRawPath ||= value === options.rawPath
      projection.reachableParticipantId ||= value === options.participantId
      return
    }
    if ((typeof value !== 'object' && typeof value !== 'function') ||
      value === null || depth > 8) return
    if (value === options.coordinator) projection.reachableCoordinator = true
    if (Buffer.isBuffer(value) && propertyName === 'hmacKey') {
      projection.reachableHmacKey = true
    }
    if (visited.has(value)) return
    visited.add(value)
    if (value instanceof Map) {
      projection.reachableMap = true
      for (const [key, entry] of value) {
        visit(key, null, depth + 1)
        visit(entry, null, depth + 1)
      }
    } else if (value instanceof Set) {
      projection.reachableSet = true
      for (const entry of value) visit(entry, null, depth + 1)
    }

    // WHY getters are not invoked: the finding is stronger than a hostile
    // accessor attack. Ordinary own data properties from the symbol alone
    // already reach every secret, so the projection stays deterministic and
    // cannot create side effects while proving the reflection boundary.
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (descriptor && 'value' in descriptor) {
        visit(descriptor.value, String(key), depth + 1)
      }
    }
  }
  visit(options.globalValue, null, 0)
  return projection
}

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as typeof globalThis & {
    [NO_BIRTH_TIME_TARGET]?: string
  })[NO_BIRTH_TIME_TARGET]
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('eleventh-gate recorded registry and transport boundaries', () => {
  it('CH-11 exposes no registry maps, HMAC custody, coordinator, or raw identity through the global symbol', async () => {
    expect(review.heads.codexHeadless).toBe(
      '62d9b272a149845244a98d7ba11e977eff0da888',
    )
    expect(review.confirmedFindings).toContain(
      'global-registry-reflective-state',
    )
    const root = temporaryRoot('codex-eleventh-reflection-')
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const acquisition = await acquireFreshRolloutCoordinator(options)
    const sibling = await acquireFreshRolloutCoordinator(options)
    const participantId = `recorded-reflection-${fixtureThreadId()}`
    const participant = acquisition.coordinator.registerParticipant({
      participantId,
      cwd: '/recorded/worktree',
      onLease: () => undefined,
    })
    const rolloutPath = installExactRollout(root)

    try {
      expect(await waitFor(() =>
        acquisition.coordinator.inspect().observedCandidateCount === 1,
      )).toBe(true)
      // Adjacent control: the public coordinator remains usable and identifies
      // only counts. The failure below is specifically the process-global
      // reflection path, not watcher setup or candidate parsing.
      expect(acquisition.coordinator.inspect()).toMatchObject({
        activeParticipantCount: 1,
        observedCandidateCount: 1,
      })
      const globalValue = registryGlobal()
      if (!globalValue) throw new Error('eleventh-gate global bridge is missing')
      const globalDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        REGISTRY_SYMBOL,
      )
      expect(globalDescriptor).toMatchObject({
        value: globalValue,
        writable: false,
        configurable: false,
        enumerable: false,
      })
      // WHY Object.freeze() alone leaves the global symbol slot replaceable.
      // These side-effect-free Reflect operations prove a same-process module
      // cannot assign a counterfeit bridge or delete the shared authority and
      // force the next package copy to create a split-brain coordinator.
      expect(Reflect.set(globalThis, REGISTRY_SYMBOL, Object.freeze({})))
        .toBe(false)
      expect(Reflect.deleteProperty(globalThis, REGISTRY_SYMBOL)).toBe(false)
      expect(registryGlobal()).toBe(globalValue)
      const projection = projectReflectiveReachability({
        globalValue,
        coordinator: acquisition.coordinator,
        rawPath: rolloutPath,
        participantId,
      })

      expect(projection).toEqual({
        globalValueIsFrozen: true,
        reachableMap: false,
        reachableSet: false,
        reachableHmacKey: false,
        reachableCoordinator: false,
        reachableRawPath: false,
        reachableParticipantId: false,
      })
      // WHY removing the coordinator from the global bridge is necessary but
      // not sufficient: acquisitions intentionally return that coordinator to
      // their caller. Its HMAC custody must therefore survive reflection of the
      // reachable instance too. Other private arbitration maps are not the
      // global finding under review; this assertion isolates the cryptographic
      // key that TypeScript `private` previously stored as an own Buffer.
      expect(projectReflectiveReachability({
        globalValue: acquisition.coordinator,
        coordinator: acquisition.coordinator,
        rawPath: rolloutPath,
        participantId,
      }).reachableHmacKey).toBe(false)
    } finally {
      participant.unregister()
      await acquisition.release()
      await sibling.release()
    }
  })

  it('CH-13 evicts an unchanged stale no-birth generation once policy says it cannot be rescanned', async () => {
    expect(review.confirmedFindings).toContain(
      'stale-no-birth-unrescan-retention',
    )
    const root = temporaryRoot('codex-eleventh-no-birth-')
    const rolloutPath = installExactRollout(root)
    const oldTime = new Date(Date.now() - 10_000)
    utimesSync(rolloutPath, oldTime, oldTime)
    ;(globalThis as typeof globalThis & {
      [NO_BIRTH_TIME_TARGET]?: string
    })[NO_BIRTH_TIME_TARGET] = resolve(rolloutPath)
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const staleAcquisition = await acquireFreshRolloutCoordinator(options)
    const liveSibling = await acquireFreshRolloutCoordinator(options)
    const participant = staleAcquisition.coordinator.registerParticipant({
      participantId: `recorded-no-birth-${fixtureThreadId()}`,
      cwd: '/recorded/worktree',
      onLease: () => undefined,
    })

    try {
      expect(staleAcquisition.coordinator.inspect()).toMatchObject({
        activeParticipantCount: 1,
        observedCandidateCount: 0,
      })
      // Touching mtime asks the live watcher to reconsider the same inode and
      // exact recorded bytes. The stat wrapper omits only birth time, matching
      // the reviewed unsupported-filesystem schedule without inventing a
      // rollout append or a second generation.
      const touched = new Date()
      utimesSync(rolloutPath, touched, touched)
      expect(await waitFor(() =>
        staleAcquisition.coordinator.inspect().observedCandidateCount === 1,
      )).toBe(true)
      expect(staleAcquisition.coordinator.requiresCandidateRescan(
        rolloutPath,
      )).toBe(false)
      expect(staleAcquisition.coordinator.isCandidateTransportTerminal(
        rolloutPath,
      )).toBe(false)

      // WHY the fingerprint is intentionally unchanged from the admitted touch.
      // Maintenance currently checks terminality, then short-circuits on that
      // fingerprint before consulting the graph's false rescan bit. After two
      // real 500ms intervals the raw path/maps must be gone even though the
      // unrelated acquisition keeps the watcher alive.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
      expect(transportCounts(staleAcquisition.coordinator)).toEqual({
        knownPathCount: 0,
        lastFingerprintCount: 0,
      })
    } finally {
      participant.unregister()
      await staleAcquisition.release()
      await liveSibling.release()
    }
  }, 10_000)

  it('compacts a completed invalid path with no claimant while a watcher reference remains live', async () => {
    const root = temporaryRoot('codex-eleventh-invalid-orphan-')
    const day = join(root, '2026', '08', '26')
    mkdirSync(day, { recursive: true })
    const invalidPath = join(
      day,
      'rollout-invalid-00000000-0000-4000-8000-000000000139.jsonl',
    )
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const acquisition = await acquireFreshRolloutCoordinator(options)
    const liveSibling = await acquireFreshRolloutCoordinator(options)

    try {
      writeFileSync(invalidPath, '{"type":"not-a-rollout-candidate"}\n')
      await emitFreshRolloutChangeAndDrainForTesting(
        acquisition.coordinator,
        invalidPath,
      )
      expect(acquisition.coordinator.inspect().observedCandidateCount).toBe(0)
      // WHY joining the opaque read queue proves “missing candidate” now means
      // a completed invalid parse, not a callback that has not run yet. It must
      // be retained until maintenance applies policy, then disappear even
      // though two acquisition references keep chokidar itself alive.
      expect(inspectFreshRolloutTransportForTesting(
        acquisition.coordinator,
      )).toMatchObject({ knownPathCount: 1, activeWatcherCount: 1 })
      expect(await waitFor(() =>
        inspectFreshRolloutTransportForTesting(
          acquisition.coordinator,
        ).knownPathCount === 0,
      )).toBe(true)
      expect(inspectFreshRolloutTransportForTesting(
        acquisition.coordinator,
      )).toMatchObject({
        knownPathCount: 0,
        lastFingerprintCount: 0,
        activeWatcherCount: 1,
      })
    } finally {
      await acquisition.release()
      await liveSibling.release()
    }
  }, 10_000)

  it('keeps a completed incomplete path for an active claimant rescan', async () => {
    const root = temporaryRoot('codex-eleventh-incomplete-live-')
    const day = join(root, '2026', '08', '26')
    mkdirSync(day, { recursive: true })
    const incompletePath = join(
      day,
      'rollout-incomplete-00000000-0000-4000-8000-000000000140.jsonl',
    )
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const acquisition = await acquireFreshRolloutCoordinator(options)
    const participant = acquisition.coordinator.registerParticipant({
      participantId: 'recorded-live-incomplete-claimant',
      cwd: '/recorded/worktree',
      onLease: () => undefined,
    })

    try {
      writeFileSync(incompletePath, '')
      await emitFreshRolloutChangeAndDrainForTesting(
        acquisition.coordinator,
        incompletePath,
      )
      expect(acquisition.coordinator.inspect().observedCandidateCount).toBe(0)
      suppressFreshRolloutChangeEventsForTesting(acquisition.coordinator)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
      expect(inspectFreshRolloutTransportForTesting(
        acquisition.coordinator,
      ).knownPathCount).toBe(1)

      // WHY change-event admission is removed before these recorded bytes are
      // appended. Observing the candidate proves the retained raw path powered
      // the independent 500ms rescan; a false policy for every missing
      // candidate would compact it and make this recovery impossible.
      writeFileSync(incompletePath, rolloutText())
      expect(await waitFor(() =>
        acquisition.coordinator.inspect().observedCandidateCount === 1,
      )).toBe(true)
    } finally {
      participant.unregister()
      await acquisition.release()
    }
  }, 10_000)
})
