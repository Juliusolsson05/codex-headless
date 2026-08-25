import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  FreshRolloutOwnershipCoordinator,
  type FreshRolloutLease,
} from './FreshRolloutOwnershipCoordinator.js'
import {
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
  type FreshRolloutCandidate,
} from './FreshRolloutClaim.js'

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
})
