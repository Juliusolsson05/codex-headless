#!/usr/bin/env tsx
/**
 * testing/replay.ts — replay a recorded Codex session and run parsers.
 *
 * Usage:
 *   npx tsx src/testing/replay.ts recordings/<dir>            # final state
 *   npx tsx src/testing/replay.ts recordings/<dir> --frames   # every frame
 */

import { readFile } from 'fs/promises'
import { join } from 'path'

import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless

import {
  extractCodexAssistantInProgress,
  extractCodexStreamingText,
} from '../parsers/ScreenParser.js'
import { terminalToMarkdown } from '../terminal/HeadlessTerminal.js'

type RawEvent = { ts: number; data: string }
type Meta = { cols?: number; rows?: number }

const SEP = '─'.repeat(78)
const box = (title: string, body: string) => `${SEP}\n${title}\n${SEP}\n${body}\n`

function snapshot(term: InstanceType<typeof Terminal>): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: tsx src/testing/replay.ts <recordingDir> [--frames]')
    process.exit(1)
  }

  const dumpFrames = process.argv.includes('--frames')

  let meta: Meta = {}
  try { meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta } catch { /* ok */ }

  const events: RawEvent[] = (await readFile(join(dir, 'raw.events.jsonl'), 'utf8'))
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as RawEvent)

  console.log(box('META', JSON.stringify(meta, null, 2)))
  console.log(`${events.length} raw events\n`)
  if (events.length === 0) { console.error('empty recording'); process.exit(1) }

  const term = new Terminal({
    cols: meta.cols ?? 120, rows: meta.rows ?? 40,
    allowProposedApi: true, scrollback: 10000,
  })

  const writeAndFlush = (data: string): Promise<void> =>
    new Promise(resolve => term.write(data, () => resolve()))

  if (dumpFrames) {
    let prev = ''
    for (let i = 0; i < events.length; i++) {
      await writeAndFlush(events[i].data)
      const screen = snapshot(term)
      if (screen === prev) continue
      prev = screen
      const assistant = extractCodexAssistantInProgress(screen)
      const mdScreen = terminalToMarkdown(term)
      const assistantMd = extractCodexAssistantInProgress(mdScreen)
      console.log(box(`FRAME ${i + 1}/${events.length}  (+${events[i].ts - events[0].ts}ms)`, ''))
      console.log('--- raw screen ---')
      console.log(screen)
      console.log('\n--- extractCodexAssistantInProgress (plain) ---')
      console.log(assistant || '(empty)')
      console.log('\n--- extractCodexAssistantInProgress (markdown) ---')
      console.log(assistantMd || '(empty)')
      console.log()
    }
    return
  }

  for (const ev of events) term.write(ev.data)
  await new Promise<void>(r => setTimeout(r, 50))

  const screen = snapshot(term)
  const mdScreen = terminalToMarkdown(term)

  console.log(box('FINAL RAW SCREEN', screen))
  console.log(box('extractCodexStreamingText', extractCodexStreamingText(screen)))
  console.log(box('extractCodexAssistantInProgress (plain)', extractCodexAssistantInProgress(screen) || '(none)'))
  console.log(box('extractCodexAssistantInProgress (markdown)', extractCodexAssistantInProgress(mdScreen) || '(none)'))
}

main().catch(err => { console.error('[replay] fatal:', err); process.exit(1) })
