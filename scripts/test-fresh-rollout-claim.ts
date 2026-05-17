import assert from 'node:assert/strict'
import {
  decideFreshRolloutClaim,
  extractSubmittedPromptFromWrite,
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
  type FreshRolloutCandidate,
  type SubmittedPrompt,
} from '../src/transcript/FreshRolloutClaim.js'

const cwd = '/repo'
const normalizeCwd = (value: string) => value

function prompt(text: string): SubmittedPrompt {
  return {
    text,
    normalized: normalizePromptForOwnership(text),
    ts: 1,
  }
}

function candidate(
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

function rolloutText(id: string, message: string, candidateCwd = cwd): string {
  return [
    JSON.stringify({
      timestamp: '2026-05-17T00:00:00Z',
      type: 'session_meta',
      payload: {
        id,
        timestamp: '2026-05-17T00:00:00Z',
        cwd: candidateCwd,
        originator: 'codex-tui',
        cli_version: 'test',
        source: 'cli',
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-17T00:00:01Z',
      type: 'event_msg',
      payload: { type: 'user_message', message },
    }),
  ].join('\n')
}

assert.equal(
  extractSubmittedPromptFromWrite('\x1b[200~hello\nworld\x1b[201~\r'),
  'hello\nworld',
)
assert.equal(extractSubmittedPromptFromWrite('hello\r'), 'hello')
assert.equal(extractSubmittedPromptFromWrite('\x1b[A'), null)

const parsed = parseFreshRolloutCandidate(
  '/tmp/rollout.jsonl',
  rolloutText('thread-one', '<user_input>Hello   world</user_input>'),
)
assert(parsed)
assert.equal(parsed.threadId, 'thread-one')
assert.equal(parsed.cwd, cwd)
assert.equal(parsed.normalizedFirstUserMessage, 'Hello world')

{
  const decision = decideFreshRolloutClaim({
    ownCwd: cwd,
    prompts: [],
    candidates: [candidate('/tmp/a.jsonl', 'sibling prompt')],
    normalizeCwd,
  })
  assert.equal(decision.type, 'hold')
}

{
  const decision = decideFreshRolloutClaim({
    ownCwd: cwd,
    prompts: [prompt('my prompt')],
    candidates: [candidate('/tmp/a.jsonl', 'sibling prompt')],
    normalizeCwd,
  })
  assert.equal(decision.type, 'hold')
}

{
  const decision = decideFreshRolloutClaim({
    ownCwd: cwd,
    prompts: [prompt('my prompt')],
    candidates: [candidate('/tmp/a.jsonl', 'my   prompt')],
    normalizeCwd,
  })
  assert.equal(decision.type, 'accept')
  assert.equal(decision.filePath, '/tmp/a.jsonl')
}

{
  const decision = decideFreshRolloutClaim({
    ownCwd: cwd,
    prompts: [prompt('shared prompt')],
    candidates: [
      candidate('/tmp/a.jsonl', 'shared prompt'),
      candidate('/tmp/b.jsonl', 'shared prompt'),
    ],
    normalizeCwd,
  })
  assert.equal(decision.type, 'ambiguous')
}

{
  const decision = decideFreshRolloutClaim({
    ownCwd: cwd,
    prompts: [prompt('my prompt')],
    candidates: [candidate('/tmp/a.jsonl', 'my prompt', '/other')],
    normalizeCwd,
  })
  assert.equal(decision.type, 'hold')
}

console.log('test-fresh-rollout-claim passed')
