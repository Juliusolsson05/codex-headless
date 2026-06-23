import assert from 'node:assert/strict'
import {
  collectRolloutLineageIds,
  decideResumeForkCandidate,
} from '../src/transcript/ResumeForkCandidate.js'

const cwd = '/repo'
const normalizeCwd = (value: string) => value

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: '2026-06-23T00:00:00Z', type, payload })
}

function candidateText(candidateCwd: string, ids: string[]): string {
  return [
    line('session_meta', { id: 'session-id', cwd: candidateCwd }),
    ...ids.map((id) => line('response_item', { id })),
  ].join('\n')
}

const initialText = [
  line('session_meta', { id: 'initial-session-id', cwd }),
  line('response_item', { id: 'msg_1' }),
  line('response_item', { id: 'msg_2' }),
  line('event_msg', { turn_id: 'turn_1' }),
  line('event_msg', { call_id: 'call_1' }),
].join('\n')

const lineageIds = new Set<string>()
collectRolloutLineageIds(initialText, lineageIds, 8000)
assert.deepEqual([...lineageIds].sort(), ['call_1', 'msg_1', 'msg_2', 'turn_1'])

{
  const decision = decideResumeForkCandidate({
    ownCwd: cwd,
    candidateText: candidateText('/other', ['msg_1', 'msg_2', 'turn_1']),
    initialPath: '/sessions/initial.jsonl',
    candidatePath: '/sessions/other-cwd.jsonl',
    lineageIds,
    requiredOverlapLimit: 3,
    normalizeCwd,
  })
  assert.equal(decision.type, 'reject')
  assert.equal(decision.reason, 'cwd-mismatch')
}

{
  const decision = decideResumeForkCandidate({
    ownCwd: cwd,
    candidateText: candidateText(cwd, ['sibling_1', 'sibling_2', 'sibling_3']),
    initialPath: '/sessions/initial.jsonl',
    candidatePath: '/sessions/sibling.jsonl',
    lineageIds,
    requiredOverlapLimit: 3,
    normalizeCwd,
  })
  assert.equal(decision.type, 'reject')
  assert.equal(decision.reason, 'insufficient-lineage-overlap')
  assert.equal(decision.lineageOverlap, 0)
  assert.equal(decision.requiredOverlap, 3)
  assert.match(decision.message ?? '', /treating it as an unrelated session/)
}

{
  const decision = decideResumeForkCandidate({
    ownCwd: cwd,
    candidateText: candidateText(cwd, ['msg_1', 'msg_2', 'turn_1']),
    initialPath: '/sessions/initial.jsonl',
    candidatePath: '/sessions/fork.jsonl',
    lineageIds,
    requiredOverlapLimit: 3,
    normalizeCwd,
  })
  assert.equal(decision.type, 'accept')
  assert.equal(decision.lineageOverlap, 3)
  assert.equal(decision.requiredOverlap, 3)
}

{
  const decision = decideResumeForkCandidate({
    ownCwd: cwd,
    candidateText: candidateText(cwd, ['msg_1']),
    initialPath: '/sessions/empty.jsonl',
    candidatePath: '/sessions/same-cwd.jsonl',
    lineageIds: new Set(),
    requiredOverlapLimit: 3,
    normalizeCwd,
  })
  assert.equal(decision.type, 'reject')
  assert.equal(decision.reason, 'missing-lineage')
  assert.match(decision.message ?? '', /cannot verify lineage/)
}

console.log('test-resume-fork-candidate passed')
