import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  decideFreshRolloutClaim,
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
  summarizeFreshRolloutClaimEvidence,
  type FreshRolloutCandidate,
  type SubmittedPrompt,
} from './FreshRolloutClaim.js'

type RecordedOwnershipFixture = {
  schemaVersion: 1
  id: string
  provenance: {
    cliVersion: string
    sessionClass: 'fresh' | 'resume' | 'subagent'
  }
  ownership: {
    localPromptToken: string | null
    expectedLegacyDecision: 'accept' | 'hold' | 'not-applicable'
    expectedTargetDecision: 'accept' | 'hold' | 'ambiguous' | 'not-applicable'
  }
  lines: Array<Record<string, unknown>>
}

const fixtureRoot = fileURLToPath(
  new URL('../../testing/fixtures/rollout-ownership/', import.meta.url),
)

const freshFixtureIds = [
  'legacy-0145-event-user',
  'modern-0147-environment-first',
  'modern-0149-large-bootstrap-first',
  'modern-0149-agents-first',
  'concurrent-01491-alpha',
  'concurrent-01491-beta',
] as const

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

function promptFromFixture(fixture: RecordedOwnershipFixture): SubmittedPrompt {
  const text = fixture.ownership.localPromptToken
  if (!text) throw new Error(`${fixture.id} does not declare a local prompt`)
  return {
    text,
    normalized: normalizePromptForOwnership(text),
    ts: 1,
  }
}

function decide(
  fixture: RecordedOwnershipFixture,
  candidates: FreshRolloutCandidate[],
) {
  return decideFreshRolloutClaim({
    ownCwd: '/recorded/worktree',
    prompts: [promptFromFixture(fixture)],
    candidates,
    normalizeCwd: value => value,
  })
}

describe('recorded fresh rollout ownership corpus', () => {
  it.each(freshFixtureIds)(
    'reaches the recorded target decision for %s',
    fixtureId => {
      const fixture = loadFixture(fixtureId)
      const decision = decide(fixture, [candidateFromFixture(fixture)])

      // WHY the expected result is read from fixture provenance instead of
      // repeated as a test literal: the outcome table was reviewed before the
      // implementation stage and is generated beside the recorded wire shape.
      // This test must constrain the claimant to that prior semantic judgment,
      // not silently bless whatever algorithm gets written next.
      expect(decision.type).toBe(fixture.ownership.expectedTargetDecision)
    },
  )

  it('attributes both recorded same-CWD siblings only to their own prompt', () => {
    const alpha = loadFixture('concurrent-01491-alpha')
    const beta = loadFixture('concurrent-01491-beta')
    const candidates = [
      candidateFromFixture(alpha),
      candidateFromFixture(beta),
    ]

    expect(decide(alpha, candidates)).toMatchObject({
      type: 'accept',
      filePath: '/recorded/concurrent-01491-alpha.jsonl',
    })
    expect(decide(beta, candidates)).toMatchObject({
      type: 'accept',
      filePath: '/recorded/concurrent-01491-beta.jsonl',
    })
  })

  it('returns to hold when the later recorded ownership evidence is removed or changed', () => {
    const fixture = loadFixture('modern-0149-agents-first')
    const prompt = promptFromFixture(fixture)
    const candidate = candidateFromFixture(fixture)
    const withoutMatch = {
      ...candidate,
      userMessages: candidate.userMessages.filter(
        message => message.normalized !== prompt.normalized,
      ),
    }
    const withChangedMatch = {
      ...candidate,
      userMessages: candidate.userMessages.map(message =>
        message.normalized === prompt.normalized
          ? {
              ...message,
              text: `${message.text}_CHANGED`,
              normalized: `${message.normalized}_CHANGED`,
            }
          : message,
      ),
    }

    expect(decide(fixture, [withoutMatch])).toMatchObject({ type: 'hold' })
    expect(decide(fixture, [withChangedMatch])).toMatchObject({ type: 'hold' })
  })

  it('fails closed when both recorded sibling candidates carry the same local prompt', () => {
    const alpha = loadFixture('concurrent-01491-alpha')
    const beta = loadFixture('concurrent-01491-beta')
    const alphaPrompt = promptFromFixture(alpha)
    const betaPrompt = promptFromFixture(beta)
    const alphaCandidate = candidateFromFixture(alpha)
    const betaCandidate = candidateFromFixture(beta)
    const collidingBeta = {
      ...betaCandidate,
      userMessages: betaCandidate.userMessages.map(message =>
        message.normalized === betaPrompt.normalized
          ? {
              ...message,
              text: alphaPrompt.text,
              normalized: alphaPrompt.normalized,
            }
          : message,
      ),
    }

    expect(decide(alpha, [alphaCandidate, collidingBeta])).toMatchObject({
      type: 'ambiguous',
      filePaths: [
        '/recorded/concurrent-01491-alpha.jsonl',
        '/recorded/concurrent-01491-beta.jsonl',
      ],
    })
  })

  it('diagnoses the later real match without exposing recorded text', () => {
    const fixture = loadFixture('modern-0149-agents-first')
    const candidate = candidateFromFixture(fixture)
    const prompt = promptFromFixture(fixture)
    const evidence = summarizeFreshRolloutClaimEvidence({
      ownCwd: '/recorded/worktree',
      prompts: [prompt],
      candidates: [candidate],
      normalizeCwd: value => value,
      fingerprint: normalized => normalized === prompt.normalized
        ? 'local-prompt'
        : 'not-local',
    })

    expect(evidence).toMatchObject({
      candidateCount: 1,
      sameCwdCandidateCount: 1,
      candidates: [{
        userMessages: expect.arrayContaining([
          expect.objectContaining({
            matchesLocalPrompt: true,
            selectedByLegacyProjection: false,
          }),
        ]),
      }],
    })
    expect(JSON.stringify(evidence)).not.toContain(
      fixture.ownership.localPromptToken,
    )
  })
})
