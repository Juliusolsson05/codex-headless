#!/usr/bin/env tsx
/**
 * testing/verify.ts — automated Codex parser regression tests.
 *
 * Usage:
 *   npx tsx src/testing/verify.ts recordings/<dir>
 *   npx tsx src/testing/verify.ts                     # all recordings
 */

import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'

import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless

import {
  extractCodexAssistantInProgress,
  extractCodexStreamingText,
} from '../parsers/ScreenParser.js'
import { terminalToMarkdown } from '../terminal/HeadlessTerminal.js'
import { evaluateCodexConditions } from '../conditions/index.js'

type RawEvent = { ts: number; data: string }
type Meta = { cols?: number; rows?: number }

let passed = 0
let failed = 0

function assert(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

function verifyConditionEvaluator(): void {
  console.log('\n── condition evaluator ──')
  const snapshot = evaluateCodexConditions({
    trustDialog: { visible: false },
    approval: {
      title: 'Would you like to run the following command?',
      reason: 'test',
      command: 'npm test',
      options: ['Yes', 'No'],
      selectedIndex: 0,
    },
    approvalMetadata: {
      callId: 'call-1',
      commandParts: ['npm', 'test'],
      workdir: '/tmp/project',
    },
  })
  assert('snapshot provider is codex', snapshot.provider === 'codex')
  assert(
    'approval condition is mapped',
    snapshot.conditions['codex.approval']?.state.command === 'npm test',
  )
  assert(
    'approval exposes pty actions',
    snapshot.conditions['codex.approval']?.actions.some(
      action => action.kind === 'pty' && action.id === 'approve',
    ) === true,
  )
  assert(
    'approval carries rollout metadata',
    snapshot.conditions['codex.approval']?.state.callId === 'call-1' &&
      snapshot.conditions['codex.approval']?.state.workdir === '/tmp/project',
  )
}

async function verifyRecording(dir: string): Promise<void> {
  console.log(`\n── ${dir} ──`)

  let meta: Meta = {}
  try { meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta } catch { /* ok */ }

  let events: RawEvent[]
  try {
    events = (await readFile(join(dir, 'raw.events.jsonl'), 'utf8'))
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as RawEvent)
  } catch {
    console.log('  (skipped — no raw.events.jsonl)')
    return
  }

  assert('has events', events.length > 0)
  if (events.length === 0) return

  const term = new Terminal({
    cols: meta.cols ?? 120, rows: meta.rows ?? 40,
    allowProposedApi: true, scrollback: 10000,
  })

  for (const ev of events) term.write(ev.data)
  await new Promise<void>(r => setTimeout(r, 50))

  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const plain = lines.join('\n')

  assert('screen non-empty', plain.length > 0)

  const stripped = extractCodexStreamingText(plain)
  assert('extractCodexStreamingText non-empty', stripped.length > 0)

  const md = terminalToMarkdown(term)
  assert('terminalToMarkdown non-empty', md.length > 0)

  // Codex uses • as assistant marker
  if (plain.includes('•')) {
    const assistant = extractCodexAssistantInProgress(plain)
    assert('extractCodexAssistantInProgress found content', assistant.length > 0)
    const assistantMd = extractCodexAssistantInProgress(md)
    assert('markdown extraction found content', assistantMd.length > 0)
  }
}

async function main(): Promise<void> {
  verifyConditionEvaluator()

  const arg = process.argv[2]
  if (arg) {
    await verifyRecording(arg)
  } else {
    let dirs: string[] = []
    try {
      const entries = await readdir('recordings')
      for (const e of entries) {
        const s = await stat(join('recordings', e))
        if (s.isDirectory()) dirs.push(join('recordings', e))
      }
    } catch {
      console.log('No recordings/ directory. Record a session first:')
      console.log('  npx tsx src/testing/record.ts')
      process.exit(0)
    }
    dirs.sort()
    for (const d of dirs) await verifyRecording(d)
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('[verify] fatal:', err); process.exit(1) })
