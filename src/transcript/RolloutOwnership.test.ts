import { describe, expect, it } from 'vitest'

import {
  decideFreshRolloutClaim,
  extractSubmittedPromptFromWrite,
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
  type FreshRolloutCandidate,
  type SubmittedPrompt,
} from './FreshRolloutClaim.js'
import {
  collectRolloutLineageIds,
  decideResumeForkCandidate,
} from './ResumeForkCandidate.js'

const cwd = '/repo'
const normalizeCwd = (value: string) => value

function prompt(text: string): SubmittedPrompt {
  return {
    text,
    normalized: normalizePromptForOwnership(text),
    ts: 1,
  }
}

function freshCandidate(
  filePath: string,
  message: string | null,
  candidateCwd = cwd,
): FreshRolloutCandidate {
  return {
    filePath,
    threadId: filePath,
    cwd: candidateCwd,
    firstUserMessage: message,
    normalizedFirstUserMessage: message
      ? normalizePromptForOwnership(message)
      : null,
  }
}

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: '2026-06-23T00:00:00Z', type, payload })
}

function rolloutText(id: string, message: string, candidateCwd = cwd): string {
  return [
    line('session_meta', {
      id,
      cwd: candidateCwd,
      originator: 'codex-tui',
      cli_version: 'test',
      source: 'cli',
    }),
    line('event_msg', { type: 'user_message', message }),
  ].join('\n')
}

function resumeCandidateText(candidateCwd: string, ids: string[]): string {
  return [
    line('session_meta', { id: 'session-id', cwd: candidateCwd }),
    ...ids.map(id => line('response_item', { id })),
  ].join('\n')
}

describe('fresh rollout ownership', () => {
  it('extracts submitted terminal prompts without treating control keys as prompts', () => {
    expect(extractSubmittedPromptFromWrite('\x1b[200~hello\nworld\x1b[201~\r')).toBe(
      'hello\nworld',
    )
    expect(extractSubmittedPromptFromWrite('hello\r')).toBe('hello')
    expect(extractSubmittedPromptFromWrite('\x1b[A')).toBeNull()
  })

  it('parses the first user message and normalizes transport wrappers', () => {
    const parsed = parseFreshRolloutCandidate(
      '/tmp/rollout.jsonl',
      rolloutText('thread-one', '<user_input>Hello   world</user_input>'),
    )

    expect(parsed).toMatchObject({
      threadId: 'thread-one',
      cwd,
      normalizedFirstUserMessage: 'Hello world',
    })
  })

  it('fails closed until a same-directory rollout matches a locally submitted prompt', () => {
    expect(decideFreshRolloutClaim({
      ownCwd: cwd,
      prompts: [],
      candidates: [freshCandidate('/tmp/a.jsonl', 'sibling prompt')],
      normalizeCwd,
    })).toMatchObject({ type: 'hold' })

    expect(decideFreshRolloutClaim({
      ownCwd: cwd,
      prompts: [prompt('my prompt')],
      candidates: [freshCandidate('/tmp/a.jsonl', 'sibling prompt')],
      normalizeCwd,
    })).toMatchObject({ type: 'hold' })

    expect(decideFreshRolloutClaim({
      ownCwd: cwd,
      prompts: [prompt('my prompt')],
      candidates: [freshCandidate('/tmp/a.jsonl', 'my prompt', '/other')],
      normalizeCwd,
    })).toMatchObject({ type: 'hold' })
  })

  it('accepts the unique matching rollout and rejects timing-based ambiguity', () => {
    expect(decideFreshRolloutClaim({
      ownCwd: cwd,
      prompts: [prompt('my prompt')],
      candidates: [freshCandidate('/tmp/a.jsonl', 'my   prompt')],
      normalizeCwd,
    })).toMatchObject({ type: 'accept', filePath: '/tmp/a.jsonl' })

    expect(decideFreshRolloutClaim({
      ownCwd: cwd,
      prompts: [prompt('shared prompt')],
      candidates: [
        freshCandidate('/tmp/a.jsonl', 'shared prompt'),
        freshCandidate('/tmp/b.jsonl', 'shared prompt'),
      ],
      normalizeCwd,
    })).toMatchObject({
      type: 'ambiguous',
      filePaths: ['/tmp/a.jsonl', '/tmp/b.jsonl'],
    })
  })
})

describe('resumed rollout ownership', () => {
  const initialText = [
    line('session_meta', { id: 'initial-session-id', cwd }),
    line('response_item', { id: 'msg_1' }),
    line('response_item', { id: 'msg_2' }),
    line('event_msg', { turn_id: 'turn_1' }),
    line('event_msg', { call_id: 'call_1' }),
  ].join('\n')

  function lineage(): Set<string> {
    const ids = new Set<string>()
    collectRolloutLineageIds(initialText, ids, 8_000)
    return ids
  }

  it('collects only history identifiers that can prove copied lineage', () => {
    expect([...lineage()].sort()).toEqual(['call_1', 'msg_1', 'msg_2', 'turn_1'])
  })

  it('rejects candidates from another directory or without trusted lineage', () => {
    expect(decideResumeForkCandidate({
      ownCwd: cwd,
      candidateText: resumeCandidateText('/other', ['msg_1', 'msg_2']),
      initialPath: '/sessions/initial.jsonl',
      candidatePath: '/sessions/other-cwd.jsonl',
      lineageIds: lineage(),
      requiredOverlapLimit: 3,
      normalizeCwd,
    })).toMatchObject({ type: 'reject', reason: 'cwd-mismatch' })

    expect(decideResumeForkCandidate({
      ownCwd: cwd,
      candidateText: resumeCandidateText(cwd, ['msg_1']),
      initialPath: '/sessions/empty.jsonl',
      candidatePath: '/sessions/same-cwd.jsonl',
      lineageIds: new Set(),
      requiredOverlapLimit: 3,
      normalizeCwd,
    })).toMatchObject({ type: 'reject', reason: 'missing-lineage' })
  })

  it('rejects a same-directory sibling and accepts a proven fork', () => {
    const trustedLineage = lineage()

    expect(decideResumeForkCandidate({
      ownCwd: cwd,
      candidateText: resumeCandidateText(cwd, ['sibling_1', 'sibling_2', 'sibling_3']),
      initialPath: '/sessions/initial.jsonl',
      candidatePath: '/sessions/sibling.jsonl',
      lineageIds: trustedLineage,
      requiredOverlapLimit: 3,
      normalizeCwd,
    })).toMatchObject({
      type: 'reject',
      reason: 'insufficient-lineage-overlap',
      lineageOverlap: 0,
      requiredOverlap: 3,
    })

    expect(decideResumeForkCandidate({
      ownCwd: cwd,
      candidateText: resumeCandidateText(cwd, ['msg_1', 'msg_2', 'turn_1']),
      initialPath: '/sessions/initial.jsonl',
      candidatePath: '/sessions/fork.jsonl',
      lineageIds: trustedLineage,
      requiredOverlapLimit: 3,
      normalizeCwd,
    })).toEqual({ type: 'accept', lineageOverlap: 3, requiredOverlap: 3 })
  })
})
