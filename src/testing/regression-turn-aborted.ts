#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { CodexHeadless } from '../CodexHeadless.js'
import type { CodexRolloutLine } from '../transcript/TranscriptTypes.js'

class FakePty extends EventEmitter {
  write(_data: string): void {}
  resize(_cols: number, _rows: number): void {}
  kill(_signal?: string): void {}
}

async function main(): Promise<void> {
  const pty = new FakePty()
  const headless = new CodexHeadless({
    pty: pty as never,
    cwd: process.cwd(),
  })

  const completed: string[] = []
  const stopped: Array<{ turnId: string; stopReason: string | null }> = []
  headless.semantic.on('turn_completed', ev => completed.push(ev.turnId))
  headless.semantic.on('turn_stopped', ev => {
    stopped.push({ turnId: ev.turnId, stopReason: ev.stopReason })
  })

  const ingest = (line: CodexRolloutLine) =>
    (headless as unknown as { ingestRolloutIntoSemantic(line: CodexRolloutLine): void })
      .ingestRolloutIntoSemantic(line)

  const turnId = '019dab0b-44c3-7372-85c3-e36edc68d728'
  ingest({
    timestamp: '2026-04-20T13:19:16.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId, started_at: 1776691156 },
  })
  ingest({
    timestamp: '2026-04-20T13:19:23.763Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: 'I’ve got the exact edit set: one bridge fix...',
    },
  })
  ingest({
    timestamp: '2026-04-20T13:19:32.541Z',
    type: 'event_msg',
    payload: {
      type: 'turn_aborted',
      turn_id: turnId,
      reason: 'interrupted',
      completed_at: 1776691172,
      duration_ms: 36854,
    },
  })

  assert.deepEqual(stopped, [{ turnId, stopReason: 'interrupted' }])
  assert.deepEqual(completed, [turnId])
  assert.equal(
    (headless as unknown as { liveSemanticTurnId: string | null }).liveSemanticTurnId,
    null,
  )

  console.log('ok - codex turn_aborted seals the live semantic turn')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
