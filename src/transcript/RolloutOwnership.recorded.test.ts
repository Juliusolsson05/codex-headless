import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  decideFreshRolloutClaim,
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
  type FreshRolloutCandidate,
  type SubmittedPrompt,
} from './FreshRolloutClaim.js'
import { decideLegacyFreshRollout } from './LegacyFreshRolloutOracle.js'
import { findCodexRolloutPathByThreadId } from './RolloutLocator.js'

type RecordedOwnershipFixture = {
  schemaVersion: 2
  id: string
  provenance: {
    sourceLabel: string
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
  it('executes every cataloged recorded fixture', () => {
    const committedFixtureIds = readdirSync(fixtureRoot)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .sort()

    // WHY corpus inventory is executable: the exact-id recording previously
    // appeared in catalog prose while no test loaded it. A future fixture must
    // choose a route explicitly instead of inflating an unexercised test count.
    expect(committedFixtureIds).toEqual([
      ...freshFixtureIds,
      'subagent-0149-exact-attachment',
    ].sort())
  })

  it.each([...freshFixtureIds, 'subagent-0149-exact-attachment'])(
    'publishes only opaque private-source provenance for %s',
    fixtureId => {
      const fixture = loadFixture(fixtureId)

      // WHY Codex filenames contain the provider thread UUID. Recording-based
      // tests need a reproducible private lookup bridge, but committing that
      // basename would turn a sanitized fixture into an identity disclosure.
      expect(fixture.provenance.sourceLabel).toMatch(
        /^recorded-source-[0-9a-f]{16}$/,
      )
      expect(fixture.provenance).not.toHaveProperty('sourceBasename')
    },
  )

  it.each(freshFixtureIds)(
    'independently reproduces the frozen legacy decision for %s',
    fixtureId => {
      const fixture = loadFixture(fixtureId)
      const prompt = promptFromFixture(fixture)
      const decision = decideLegacyFreshRollout(
        fixture.lines.map(line => JSON.stringify(line)).join('\n'),
        '/recorded/worktree',
        prompt.text,
      )

      // WHY this oracle may not share production parsing: these expectations
      // describe the behavior that failed on the recorded upstream format. A
      // mutable claimant cannot independently verify its own improvement.
      expect(decision).toBe(fixture.ownership.expectedLegacyDecision)
    },
  )

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

  it('resolves the recorded subagent only by exact filename and session metadata identity', async () => {
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded subagent fixture has no session_meta.id')
    }
    const root = mkdtempSync(join(tmpdir(), 'codex-exact-rollout-'))
    try {
      const olderDay = join(root, '2026', '08', '23')
      const newerDay = join(root, '2026', '08', '24')
      const invalidDay = join(root, '2026', '08', '25')
      mkdirSync(olderDay, { recursive: true })
      mkdirSync(newerDay, { recursive: true })
      mkdirSync(invalidDay, { recursive: true })
      const text = `${fixture.lines.map(line => JSON.stringify(line)).join('\n')}\n`
      const olderPath = join(olderDay, `rollout-older-${threadId}.jsonl`)
      const newerPath = join(newerDay, `rollout-newer-${threadId}.jsonl`)
      writeFileSync(olderPath, text)
      writeFileSync(newerPath, text)
      utimesSync(olderPath, new Date(1_000), new Date(1_000))
      utimesSync(newerPath, new Date(2_000), new Date(2_000))

      const invalidLines = structuredClone(fixture.lines)
      const invalidMeta = invalidLines.find(line => line.type === 'session_meta')
      if (invalidMeta?.payload && typeof invalidMeta.payload === 'object') {
        (invalidMeta.payload as { id: string }).id =
          '00000000-0000-4000-8000-000000000000'
      }
      const invalidPath = join(invalidDay, `rollout-invalid-${threadId}.jsonl`)
      writeFileSync(
        invalidPath,
        `${invalidLines.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      utimesSync(invalidPath, new Date(3_000), new Date(3_000))

      expect(await findCodexRolloutPathByThreadId(root, threadId)).toBe(newerPath)
      expect(await findCodexRolloutPathByThreadId(root, threadId.slice(0, -1)))
        .toBeNull()
      expect(await findCodexRolloutPathByThreadId(
        root,
        '00000000-0000-4000-8000-000000000000',
      )).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
