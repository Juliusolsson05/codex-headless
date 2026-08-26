import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseFreshRolloutCandidate } from './FreshRolloutClaim.js'
import { FreshRolloutOwnershipCoordinator } from './FreshRolloutOwnershipCoordinator.js'
import {
  acquireFreshRolloutCoordinator,
  inspectFreshRolloutTransportForTesting,
} from './FreshRolloutOwnershipCoordinatorRegistry.js'
import { collectRolloutLineageIds } from './ResumeForkCandidate.js'

type RecordedOwnershipFixture = {
  lines: Array<Record<string, unknown>>
}

type TenthGateReview = {
  heads: { codexHeadless: string }
  confirmedFindings: string[]
}

const exactFixturePath = fileURLToPath(new URL(
  '../../testing/fixtures/rollout-ownership/' +
    'subagent-0149-exact-attachment.json',
  import.meta.url,
))
const reviewPath = fileURLToPath(new URL(
  '../../testing/fixtures/tenth-gate/review-a057cd69-recorded.json',
  import.meta.url,
))
const fixture = JSON.parse(
  readFileSync(exactFixturePath, 'utf8'),
) as RecordedOwnershipFixture
const review = JSON.parse(readFileSync(reviewPath, 'utf8')) as TenthGateReview
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

describe('tenth-gate recorded ownership schedules', () => {
  it('rejects a resume-lineage generation first observed before registration', () => {
    expect(review.heads.codexHeadless.startsWith('6c6336b')).toBe(true)
    expect(review.confirmedFindings).toContain(
      'pre-registration-resume-lineage',
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'))

    const filePath = `/recorded/sessions/rollout-preexisting-${fixtureThreadId()}.jsonl`
    const candidate = parseFreshRolloutCandidate(filePath, rolloutText())
    if (!candidate?.cwd) throw new Error('recorded exact candidate has no cwd')
    const lineageIds = new Set<string>()
    collectRolloutLineageIds(rolloutText(), lineageIds, 8000)
    expect(lineageIds.size).toBeGreaterThanOrEqual(3)

    const coordinator = new FreshRolloutOwnershipCoordinator({
      normalizeCwd: value => value,
      normalizePath: value => value,
    })
    const observation = coordinator.beginCandidateObservation(filePath, {
      generationId: 'recorded-preexisting-generation',
      birthtimeMs: Date.now() - 1000,
    })
    coordinator.commitCandidateObservation(observation, candidate)
    const leases: string[] = []
    const participant = coordinator.registerResumeParticipant({
      participantId: 'recorded-new-resume',
      cwd: candidate.cwd,
      lineageIds,
      requiredOverlapLimit: 3,
      onLease: lease => leases.push(lease.filePath),
    })

    // WHY birth time is deliberately inside the fresh participant's recorded
    // five-second grace. A resume participant is registered before its PTY
    // exists, so an already-observed sibling cannot have been created by that
    // PTY even when its copied lineage and cwd are otherwise a perfect match.
    expect(leases).toEqual([])
    participant.unregister()
  })

  it('evicts an unchanged raw path after later exact terminalization', async () => {
    expect(review.confirmedFindings).toContain(
      'later-terminalization-transport-retention',
    )
    const root = temporaryRoot('codex-tenth-terminalization-')
    const day = join(root, '2026', '08', '26')
    mkdirSync(day, { recursive: true })
    const threadId = fixtureThreadId()
    const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    writeFileSync(rolloutPath, rolloutText())
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const terminalizer = await acquireFreshRolloutCoordinator(options)
    const liveSibling = await acquireFreshRolloutCoordinator(options)
    const ownerId = `recorded-exact-owner-${root}`

    try {
      expect(await waitFor(() =>
        terminalizer.coordinator.inspect().observedCandidateCount === 1 &&
        inspectFreshRolloutTransportForTesting(
          liveSibling.coordinator,
        ).knownPathCount === 1,
      )).toBe(true)
      expect(terminalizer.coordinator.reservePath({
        ownerId,
        filePath: rolloutPath,
        kind: 'exact-id',
        proofIdentity: threadId,
      })).toBe(true)

      // WHY no append follows the exact reservation in the recorded schedule.
      // The maintenance pass must inspect terminal policy before treating an
      // unchanged fingerprint as a reason to retain its UUID-bearing path.
      expect(await waitFor(() =>
        inspectFreshRolloutTransportForTesting(
          liveSibling.coordinator,
        ).knownPathCount === 0 &&
        inspectFreshRolloutTransportForTesting(
          liveSibling.coordinator,
        ).lastFingerprintCount === 0,
      )).toBe(true)
    } finally {
      terminalizer.coordinator.retireOwnerLeases(ownerId, true)
      await terminalizer.release()
      await liveSibling.release()
    }
  }, 10_000)
})
