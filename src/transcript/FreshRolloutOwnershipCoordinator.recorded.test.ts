import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  FreshRolloutOwnershipCoordinator,
  type FreshRolloutLease,
  type FreshRolloutParticipantDecision,
} from './FreshRolloutOwnershipCoordinator.js'
import {
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
  type FreshRolloutCandidate,
} from './FreshRolloutClaim.js'
import { collectRolloutLineageIds } from './ResumeForkCandidate.js'

type RecordedOwnershipFixture = {
  id: string
  ownership: { localPromptToken: string | null }
  lines: Array<Record<string, unknown>>
}

const fixtureRoot = fileURLToPath(
  new URL('../../testing/fixtures/rollout-ownership/', import.meta.url),
)

function loadFixture(id: string): RecordedOwnershipFixture {
  return JSON.parse(
    readFileSync(`${fixtureRoot}${id}.json`, 'utf8'),
  ) as RecordedOwnershipFixture
}

function candidateFromFixture(
  fixture: RecordedOwnershipFixture,
): FreshRolloutCandidate {
  const candidate = parseFreshRolloutCandidate(
    `/recorded/${fixture.id}.jsonl`,
    fixture.lines.map(line => JSON.stringify(line)).join('\n'),
  )
  if (!candidate) throw new Error(`${fixture.id} did not parse as a candidate`)
  return candidate
}

function promptFromFixture(fixture: RecordedOwnershipFixture): string {
  const prompt = fixture.ownership.localPromptToken
  if (!prompt) throw new Error(`${fixture.id} does not declare a local prompt`)
  return prompt
}

function coordinator(): FreshRolloutOwnershipCoordinator {
  return new FreshRolloutOwnershipCoordinator({
    normalizeCwd: value => value,
    normalizePath: value => value,
  })
}

function register(
  owner: FreshRolloutOwnershipCoordinator,
  participantId: string,
  leases: FreshRolloutLease[],
) {
  return owner.registerParticipant({
    participantId,
    cwd: '/recorded/worktree',
    onLease: lease => leases.push(lease),
  })
}

describe('recorded process-wide fresh rollout ownership', () => {
  it('holds both identical claimants across sequential candidate delivery and withdrawal', () => {
    const alpha = loadFixture('concurrent-01491-alpha')
    const beta = loadFixture('concurrent-01491-beta')
    const alphaCandidate = candidateFromFixture(alpha)
    const betaCandidate = candidateFromFixture(beta)
    const alphaPrompt = promptFromFixture(alpha)
    const betaPrompt = normalizePromptForOwnership(promptFromFixture(beta))
    const collidingBeta: FreshRolloutCandidate = {
      ...betaCandidate,
      userMessages: betaCandidate.userMessages.map(message =>
        message.normalized === betaPrompt
          ? {
              ...message,
              text: alphaPrompt,
              normalized: normalizePromptForOwnership(alphaPrompt),
            }
          : message,
      ),
    }
    const owner = coordinator()
    const alphaLeases: FreshRolloutLease[] = []
    const betaLeases: FreshRolloutLease[] = []
    const alphaHandle = register(owner, 'alpha', alphaLeases)
    const betaHandle = register(owner, 'beta', betaLeases)

    // WHY both prompt intents are registered before the first candidate: this
    // is the exact runtime fact the old private watcher maps could not see.
    // Delivering only alpha's file first recreates the dangerous callback
    // order without replacing the recorded rollout structure with an imagined
    // JSON literal.
    alphaHandle.registerPrompt(alphaPrompt)
    betaHandle.registerPrompt(alphaPrompt)
    owner.observeCandidate(alphaCandidate)

    expect(alphaLeases).toEqual([])
    expect(betaLeases).toEqual([])
    expect(owner.inspect()).toMatchObject({
      activeParticipantCount: 2,
      leasedPathCount: 0,
      historicallyContestedPathCount: 1,
    })

    owner.observeCandidate(collidingBeta)
    expect(alphaLeases).toEqual([])
    expect(betaLeases).toEqual([])
    expect(owner.inspect()).toMatchObject({
      leasedPathCount: 0,
      historicallyContestedPathCount: 2,
    })

    // WHY withdrawal cannot manufacture evidence: once two live PTYs were
    // equally entitled to a path, choosing the survivor would merely turn
    // process scheduling into identity after the fact.
    betaHandle.unregister()
    expect(alphaLeases).toEqual([])
    expect(owner.inspect()).toMatchObject({
      activeParticipantCount: 1,
      leasedPathCount: 0,
      historicallyContestedPathCount: 2,
    })
  })

  it('leases the recorded distinct prompts correctly in reverse discovery order', () => {
    const alpha = loadFixture('concurrent-01491-alpha')
    const beta = loadFixture('concurrent-01491-beta')
    const owner = coordinator()
    const alphaLeases: FreshRolloutLease[] = []
    const betaLeases: FreshRolloutLease[] = []
    const alphaHandle = register(owner, 'alpha', alphaLeases)
    const betaHandle = register(owner, 'beta', betaLeases)

    alphaHandle.registerPrompt(promptFromFixture(alpha))
    betaHandle.registerPrompt(promptFromFixture(beta))
    owner.observeCandidate(candidateFromFixture(beta))
    owner.observeCandidate(candidateFromFixture(alpha))

    expect(alphaLeases).toMatchObject([{
      participantId: 'alpha',
      filePath: '/recorded/concurrent-01491-alpha.jsonl',
    }])
    expect(betaLeases).toMatchObject([{
      participantId: 'beta',
      filePath: '/recorded/concurrent-01491-beta.jsonl',
    }])
    expect(owner.inspect()).toMatchObject({ leasedPathCount: 2 })
  })

  it('does not let a late identical prompt claim previously observed evidence', () => {
    const alpha = loadFixture('concurrent-01491-alpha')
    const owner = coordinator()
    const alphaLeases: FreshRolloutLease[] = []
    const lateLeases: FreshRolloutLease[] = []
    const alphaHandle = register(owner, 'alpha', alphaLeases)
    const lateHandle = register(owner, 'late', lateLeases)

    alphaHandle.registerPrompt(promptFromFixture(alpha))
    owner.observeCandidate(candidateFromFixture(alpha))
    lateHandle.registerPrompt(promptFromFixture(alpha))

    // WHY this is safe without a quiet-period timer: the late participant's
    // bytes had not reached its PTY when this durable message was first seen.
    // It therefore could not have authored the already-leased rollout.
    expect(alphaLeases).toHaveLength(1)
    expect(lateLeases).toEqual([])
    expect(owner.inspect()).toMatchObject({ leasedPathCount: 1 })
  })

  it('releases pending participants without leaving live coordinator membership', () => {
    const owner = coordinator()
    const handle = register(owner, 'pending', [])

    handle.registerPrompt('a prompt with no rollout yet')
    handle.unregister()
    handle.unregister()

    expect(owner.inspect()).toMatchObject({
      activeParticipantCount: 0,
      leasedPathCount: 0,
    })
  })

  it('keeps a stopped recorded owner as a contender for its delayed file generation', () => {
    const fixture = loadFixture('concurrent-01491-alpha')
    const candidate = candidateFromFixture(fixture)
    const owner = coordinator()
    const stoppedLeases: FreshRolloutLease[] = []
    const siblingLeases: FreshRolloutLease[] = []
    const siblingDecisions: FreshRolloutParticipantDecision[] = []
    const stopped = register(owner, 'stopped-owner', stoppedLeases)
    stopped.registerPrompt(promptFromFixture(fixture))
    stopped.unregister()
    // WHY generation is deliberately after local teardown: Codex can flush a
    // new rollout after the PTY wrapper stops. Treating stop time as identity
    // would hand those delayed bytes to a later identical-prompt sibling.
    const candidateBirthtimeMs = Date.now() + 1
    const sibling = owner.registerParticipant({
      participantId: 'live-sibling',
      cwd: '/recorded/worktree',
      onLease: lease => siblingLeases.push(lease),
      onDecision: decision => siblingDecisions.push(decision),
    })
    sibling.registerPrompt(promptFromFixture(fixture))
    const observation = owner.beginCandidateObservation(candidate.filePath, {
      birthtimeMs: candidateBirthtimeMs,
      byteLength: 1,
      generationId: 'recorded-generation',
    })

    owner.commitCandidateObservation(observation, candidate)

    expect(stoppedLeases).toEqual([])
    expect(siblingLeases).toEqual([])
    expect(owner.inspect()).toMatchObject({
      historicallyContestedPathCount: 1,
      leasedPathCount: 0,
    })
    sibling.registerPrompt('a later unrelated prompt triggers recomputation')
    expect(siblingDecisions.at(-1)).toMatchObject({
      decision: 'ambiguous',
      reason: 'ownership-contended',
      historicallyContestedCandidateCount: 1,
      matchingCandidateCount: 1,
      tailAuthorized: false,
    })
    expect(siblingDecisions.at(-1)?.matchingCandidateFingerprints).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ])
  })

  it('keeps the stopped owner through the production post-drain compaction boundary', () => {
    const fixture = loadFixture('concurrent-01491-alpha')
    const candidate = candidateFromFixture(fixture)
    const owner = coordinator()
    const stopped = register(owner, 'compacted-owner', [])
    const siblingLeases: FreshRolloutLease[] = []
    stopped.registerPrompt(promptFromFixture(fixture))
    stopped.unregister()

    // WHY this call is the missing production boundary: the final watcher
    // release drains current reads before the parent kills Codex. A provider
    // flush can therefore create its rollout after this compaction returns.
    owner.compactInactiveState()
    const sibling = register(owner, 'post-compact-sibling', siblingLeases)
    sibling.registerPrompt(promptFromFixture(fixture))
    const observation = owner.beginCandidateObservation(candidate.filePath, {
      birthtimeMs: Date.now() + 1,
      generationId: 'post-drain-provider-flush',
    })
    owner.commitCandidateObservation(observation, candidate)

    expect(siblingLeases).toEqual([])
    expect(owner.inspect()).toMatchObject({
      historicallyContestedPathCount: 1,
      leasedPathCount: 0,
    })
  })

  it('gives recorded copied lineage precedence over a fresh prompt equality', () => {
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const candidate = candidateFromFixture(fixture)
    const copiedPrompt = candidate.userMessages.at(-1)?.text
    if (!copiedPrompt) throw new Error('recorded exact fixture has no copied prompt')
    const lineageIds = new Set<string>()
    collectRolloutLineageIds(
      fixture.lines.map(line => JSON.stringify(line)).join('\n'),
      lineageIds,
      8000,
    )
    if (lineageIds.size === 0) {
      throw new Error('recorded exact fixture has no lineage ids')
    }
    const owner = coordinator()
    const freshLeases: FreshRolloutLease[] = []
    const resumeLeases: FreshRolloutLease[] = []
    const fresh = register(owner, 'fresh-sibling', freshLeases)
    fresh.registerPrompt(copiedPrompt)

    owner.registerResumeParticipant({
      participantId: 'resume-owner',
      cwd: '/recorded/worktree',
      lineageIds,
      requiredOverlapLimit: 3,
      onLease: lease => resumeLeases.push(lease),
    })

    owner.observeCandidate(candidate)

    expect(freshLeases).toEqual([])
    expect(resumeLeases).toMatchObject([{
      participantId: 'resume-owner',
      filePath: candidate.filePath,
    }])
  })

  it('does not let an unrelated resume claimant starve a recorded fresh rollout', () => {
    const resumeFixture = loadFixture('subagent-0149-exact-attachment')
    const freshFixture = loadFixture('modern-0149-agents-first')
    const freshCandidate = candidateFromFixture(freshFixture)
    const resumeLineageIds = new Set<string>()
    collectRolloutLineageIds(
      resumeFixture.lines.map(line => JSON.stringify(line)).join('\n'),
      resumeLineageIds,
      8000,
    )
    const owner = coordinator()
    const resumeLeases: FreshRolloutLease[] = []
    const freshLeases: FreshRolloutLease[] = []
    owner.registerResumeParticipant({
      participantId: 'unrelated-resume',
      cwd: '/recorded/worktree',
      lineageIds: resumeLineageIds,
      requiredOverlapLimit: 3,
      onLease: lease => resumeLeases.push(lease),
    })
    const fresh = register(owner, 'independent-fresh', freshLeases)
    fresh.registerPrompt(promptFromFixture(freshFixture))

    // WHY a resume participant is not a root-wide lock: only copied lineage is
    // stronger than prompt equality. Treating its mere presence as precedence
    // would trade the crosswire bug for silent starvation of unrelated PTYs.
    owner.observeCandidate(freshCandidate)

    expect(resumeLeases).toEqual([])
    expect(freshLeases).toMatchObject([{
      participantId: 'independent-fresh',
      filePath: freshCandidate.filePath,
    }])
  })

  it('holds a recorded lineage candidate claimed by two resume participants', () => {
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const candidate = candidateFromFixture(fixture)
    const lineageIds = new Set<string>()
    collectRolloutLineageIds(
      fixture.lines.map(line => JSON.stringify(line)).join('\n'),
      lineageIds,
      8000,
    )
    const owner = coordinator()
    const firstLeases: FreshRolloutLease[] = []
    const secondLeases: FreshRolloutLease[] = []
    for (const [participantId, leases] of [
      ['resume-first', firstLeases],
      ['resume-second', secondLeases],
    ] as const) {
      owner.registerResumeParticipant({
        participantId,
        cwd: '/recorded/worktree',
        lineageIds,
        requiredOverlapLimit: 3,
        onLease: lease => leases.push(lease),
      })
    }

    // WHY copied provider IDs prove lineage but do not distinguish two local
    // owners with the same history. Scheduling either callback would recreate
    // the same process-order identity bug fixed for equal fresh prompts.
    owner.observeCandidate(candidate)

    expect(firstLeases).toEqual([])
    expect(secondLeases).toEqual([])
    expect(owner.inspect()).toMatchObject({
      historicallyContestedPathCount: 1,
      leasedPathCount: 0,
    })
  })

  it('leases when a later immutable prefix first reveals the recorded prompt', () => {
    const fixture = loadFixture('modern-0149-agents-first')
    const candidate = candidateFromFixture(fixture)
    const prompt = normalizePromptForOwnership(promptFromFixture(fixture))
    const incomplete: FreshRolloutCandidate = {
      ...candidate,
      userMessages: candidate.userMessages.filter(
        message => message.normalized !== prompt,
      ),
    }
    const owner = coordinator()
    const leases: FreshRolloutLease[] = []
    const handle = register(owner, 'growing-prefix', leases)
    owner.observeCandidate(incomplete)
    handle.registerPrompt(promptFromFixture(fixture))

    owner.observeCandidate(candidate)

    expect(leases).toMatchObject([{
      participantId: 'growing-prefix',
      filePath: candidate.filePath,
    }])
  })

  it('quarantines a recorded prefix that loses previously observed lineage', () => {
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const candidate = candidateFromFixture(fixture)
    if (candidate.lineageIds.length === 0) {
      throw new Error('recorded exact fixture has no lineage ids')
    }
    const owner = coordinator()
    owner.observeCandidate(candidate)

    // WHY the second observation retains the real recording's cwd, thread,
    // prompts, and path while removing only copied IDs. JSONL is append-only;
    // this shape therefore represents a physical truncation/rewrite, not a
    // plausible new provider format that should inherit the older proof.
    owner.observeCandidate({ ...candidate, lineageIds: [] })

    expect(owner.inspect()).toMatchObject({
      quarantinedPathCount: 1,
      leasedPathCount: 0,
    })
  })

  it('preserves an earlier prompt-bearing observation when a later read is reserved', () => {
    const fixture = loadFixture('modern-0149-agents-first')
    const candidate = candidateFromFixture(fixture)
    const owner = coordinator()
    const leases: FreshRolloutLease[] = []
    const handle = register(owner, 'causal-owner', leases)
    const first = owner.beginCandidateObservation(candidate.filePath, {
      birthtimeMs: Date.now(),
      byteLength: 1,
      generationId: 'same-recorded-generation',
    })
    handle.registerPrompt(promptFromFixture(fixture))
    const second = owner.beginCandidateObservation(candidate.filePath, {
      birthtimeMs: first.birthtimeMs ?? undefined,
      byteLength: 2,
      generationId: 'same-recorded-generation',
    })

    // WHY reads are serialized in production, so O1 still completes before O2.
    // Reserving O2 cannot erase the fact that P was already inside O1's durable
    // byte boundary before this participant registered the same prompt.
    owner.commitCandidateObservation(first, candidate)
    owner.commitCandidateObservation(second, candidate)

    expect(leases).toEqual([])
    expect(owner.inspect()).toMatchObject({ leasedPathCount: 0 })
  })

  it('rejects a recorded old generation for an active fresh participant', () => {
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const candidate = candidateFromFixture(fixture)
    const copiedPrompt = candidate.userMessages.at(-1)?.text
    if (!copiedPrompt) throw new Error('recorded exact fixture has no copied prompt')
    const owner = coordinator()
    const leases: FreshRolloutLease[] = []
    const fresh = register(owner, 'fresh-after-old-exact', leases)
    fresh.registerPrompt(copiedPrompt)
    const observation = owner.beginCandidateObservation(candidate.filePath, {
      // WHY X predates A outside the same approved generation grace used for
      // stopped owners. A later change event transports X; it does not make X
      // a file that A's provider process could have created.
      birthtimeMs: Date.now() - 10_000,
      generationId: 'recorded-old-exact-generation',
    })

    owner.commitCandidateObservation(observation, candidate)

    expect(leases).toEqual([])
    expect(owner.inspect()).toMatchObject({ leasedPathCount: 0 })
  })

  it('rejects a recorded stale generation when filesystem birth time is unavailable', () => {
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const candidate = candidateFromFixture(fixture)
    const copiedPrompt = candidate.userMessages.at(-1)?.text
    if (!copiedPrompt) throw new Error('recorded exact fixture has no copied prompt')
    const owner = coordinator()
    const staleAware = owner as FreshRolloutOwnershipCoordinator & {
      rememberStaleCandidateGeneration?: (
        filePath: string,
        generationId: string,
      ) => void
    }
    const generationId = 'recorded-no-birthtime-old-generation'

    // WHY this is the information production sees during the ignored initial
    // scan: mtime proves the path+inode predates every participant, but the
    // filesystem reports no birth time. A later change must carry that stale
    // generation fact forward instead of replacing it with observation time.
    expect(staleAware.rememberStaleCandidateGeneration).toBeTypeOf('function')
    if (!staleAware.rememberStaleCandidateGeneration) return
    staleAware.rememberStaleCandidateGeneration(candidate.filePath, generationId)

    const leases: FreshRolloutLease[] = []
    const fresh = register(owner, 'fresh-after-no-birthtime-old-exact', leases)
    fresh.registerPrompt(copiedPrompt)
    const changedObservation = owner.beginCandidateObservation(candidate.filePath, {
      generationId,
      // Deliberately omit birthtimeMs exactly as snapshotFile does when stat
      // returns zero on a filesystem without creation-time support.
    })
    owner.commitCandidateObservation(changedObservation, candidate)

    expect(leases).toEqual([])
    expect(owner.inspect()).toMatchObject({ leasedPathCount: 0 })
  })

  it('reports an opaque ignored-fork decision for insufficient recorded lineage', () => {
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const candidate = candidateFromFixture(fixture)
    const lineageIds = new Set<string>()
    collectRolloutLineageIds(
      fixture.lines.map(line => JSON.stringify(line)).join('\n'),
      lineageIds,
      8000,
    )
    const decisions: Array<{
      reason: string
      lineageOverlap: number
      requiredOverlap: number
      candidateFingerprint: string
    }> = []
    const owner = coordinator()
    const resumeOwner = owner as FreshRolloutOwnershipCoordinator & {
      registerResumeParticipant(options: {
        participantId: string
        cwd: string
        lineageIds: ReadonlySet<string>
        requiredOverlapLimit: number
        onLease: (lease: FreshRolloutLease) => void
        onDecision: (decision: {
          reason: string
          lineageOverlap: number
          requiredOverlap: number
          candidateFingerprint: string
        }) => void
      }): { unregister(): void }
    }
    resumeOwner.registerResumeParticipant({
      participantId: 'diagnostic-resume',
      cwd: '/recorded/worktree',
      lineageIds,
      requiredOverlapLimit: 3,
      onLease: () => undefined,
      onDecision: (decision: {
        reason: string
        lineageOverlap: number
        requiredOverlap: number
        candidateFingerprint: string
      }) => decisions.push(decision),
    })

    // WHY removing copied equality classes is the smallest recorded mutation
    // that exercises the old reachable rejection. Paths, cwd, prompts, entry
    // order, and provider wrappers remain sourced from the real fixture.
    owner.observeCandidate({ ...candidate, lineageIds: [] })

    expect(decisions).toMatchObject([{
      reason: 'insufficient-lineage-overlap',
      lineageOverlap: 0,
      requiredOverlap: 3,
      candidateFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }])
    const serialized = JSON.stringify(decisions)
    expect(serialized).not.toContain(candidate.filePath)
    expect(serialized).not.toContain(candidate.threadId)
    for (const lineageId of lineageIds) expect(serialized).not.toContain(lineageId)
  })

  it('allows exact identity to reopen a cleanly retired path but not overlap it', () => {
    const owner = coordinator()
    const filePath = '/recorded/exact.jsonl'
    const proofIdentity = '00000000-0000-4000-8000-000000000001'

    expect(owner.reservePath({
      ownerId: 'first', filePath, kind: 'exact-id', proofIdentity,
    })).toBe(true)
    expect(owner.reservePath({
      ownerId: 'overlap', filePath, kind: 'exact-id', proofIdentity,
    })).toBe(false)
    owner.retireOwnerLeases('first', true)
    expect(owner.reservePath({
      ownerId: 'reopen', filePath, kind: 'exact-id', proofIdentity,
    })).toBe(true)
  })

  it('tombstones a path when the tail consumer fails after lease publication', () => {
    const fixture = loadFixture('modern-0147-environment-first')
    const candidate = candidateFromFixture(fixture)
    const owner = coordinator()
    const handle = owner.registerParticipant({
      participantId: 'failing-tail-owner',
      cwd: '/recorded/worktree',
      onLease: () => { throw new Error('recorded tail-open failure') },
    })
    handle.registerPrompt(promptFromFixture(fixture))

    owner.observeCandidate(candidate)

    // WHY callback publication is the uncertainty boundary: tailFile may have
    // opened resources before throwing. Releasing this path would permit a
    // second consumer to overlap a partially initialized first tail.
    expect(owner.reservePath({
      ownerId: 'retry-owner',
      filePath: candidate.filePath,
      kind: 'exact-id',
      proofIdentity: candidate.threadId ?? undefined,
    })).toBe(false)
    expect(owner.inspect()).toMatchObject({ activeParticipantCount: 0 })
  })

  it('reports ownership state without paths, provider ids, cwd, or prompt text', () => {
    const fixture = loadFixture('modern-0149-agents-first')
    const candidate = candidateFromFixture(fixture)
    const prompt = promptFromFixture(fixture)
    const owner = coordinator()
    const decisions: FreshRolloutParticipantDecision[] = []
    const handle = owner.registerParticipant({
      participantId: 'diagnostic-owner',
      cwd: '/recorded/worktree',
      onLease: () => undefined,
      onDecision: decision => decisions.push(decision),
    })

    handle.registerPrompt(prompt)
    owner.observeCandidate(candidate)

    expect(decisions.at(-1)).toMatchObject({
      decision: 'accept',
      reason: 'path-leased',
      localPromptCount: 1,
      candidateCount: 1,
      sameCwdCandidateCount: 1,
      tailAuthorized: true,
    })
    const serialized = JSON.stringify(decisions)
    expect(serialized).not.toContain(prompt)
    expect(serialized).not.toContain(candidate.filePath)
    expect(serialized).not.toContain(candidate.threadId)
    expect(serialized).not.toContain(candidate.cwd)
  })

  it('quarantines recorded evidence when the bounded reader was exhausted', () => {
    const fixture = loadFixture('modern-0149-large-bootstrap-first')
    const candidate = candidateFromFixture(fixture)
    const owner = coordinator()
    const leases: FreshRolloutLease[] = []
    const handle = register(owner, 'read-cap-owner', leases)
    handle.registerPrompt(promptFromFixture(fixture))
    const observation = owner.beginCandidateObservation(candidate.filePath)

    owner.commitCandidateObservation(observation, candidate, {
      readCapExceeded: true,
    })

    expect(leases).toEqual([])
    expect(owner.inspect()).toMatchObject({
      quarantinedPathCount: 1,
      leasedPathCount: 0,
    })
  })

  it('compacts raw recorded evidence after cleanup while retaining opaque tombstones', () => {
    const fixture = loadFixture('modern-0147-environment-first')
    const candidate = candidateFromFixture(fixture)
    const prompt = promptFromFixture(fixture)
    const owner = coordinator()
    const handle = register(owner, 'retention-owner', [])
    handle.registerPrompt(prompt)
    owner.observeCandidate(candidate)
    handle.unregister()
    owner.retireOwnerLeases('retention-owner', true)
    owner.compactInactiveState(Date.now() + 6000)

    const retained = JSON.stringify(owner.inspectRetentionForTesting())
    expect(retained).not.toContain(prompt)
    expect(retained).not.toContain(candidate.filePath)
    expect(retained).not.toContain(candidate.cwd)
    expect(retained).not.toContain(candidate.threadId)
    for (const message of candidate.userMessages) {
      expect(retained).not.toContain(message.text)
    }
    expect(retained).toContain('retired-clean')
    expect(retained).not.toContain('"hasLeaseCallback":true')
  })
})
