import type { IPty } from 'node-pty'
import { readFileSync } from 'node:fs'

import { afterEach, expect, it } from 'vitest'

import { HeadlessTerminal } from '../terminal/HeadlessTerminal.js'
import { classifyCodexComposerState } from './ComposerState.js'

// agent-code#800 / #1313: a raw PTY recording of codex-cli 0.157.0 (see the
// fixture's `source`). Replayed through the real terminal so the dim
// attribute the classifier depends on comes from xterm's own parse of
// Codex's bytes, not from a hand-written row.
type Recording = { cols: number; rows: number; events: Array<{ t: number; dir: string; label?: string; data?: string }> }
const recording = JSON.parse(readFileSync(
  new URL('../../testing/fixtures/composer-0157/idle-draft-ctrlc.json', import.meta.url),
  'utf8',
)) as Recording
const at = (label: string) => recording.events.find(event => event.label === label)!.t

const terminals: HeadlessTerminal[] = []
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })

async function replayUntil(until: number): Promise<HeadlessTerminal> {
  const listeners = new Set<(data: string) => void>()
  const pty = {
    write: () => undefined,
    resize: () => undefined,
    onData: (listener: (data: string) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
  const terminal = new HeadlessTerminal({ pty, cols: recording.cols, rows: recording.rows, snapshotIntervalMs: 1 })
  terminals.push(terminal)
  terminal.attach()
  for (const event of recording.events) {
    if (event.dir === 'out' && event.t < until) for (const listener of listeners) listener(event.data!)
  }
  const deadline = Date.now() + 2000
  while (terminal.snapshotComposerCells() === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return terminal
}

it('reads the idle composer with its dim placeholder as empty', async () => {
  const terminal = await replayUntil(at('type-draft'))
  expect(terminal.snapshotPlain()).toContain('› Ask Codex to do anything')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).toBe('empty')
})

it('reads a typed draft as drafted', async () => {
  const terminal = await replayUntil(at('ctrl-c-1'))
  expect(terminal.snapshotPlain()).toContain('› please review the draft')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).toBe('drafted')
})

it('reads the composer as empty again after Ctrl+C clears the draft', async () => {
  const terminal = await replayUntil(at('ctrl-c-2'))
  expect(terminal.snapshotPlain()).not.toContain('please review the draft')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).toBe('empty')
})

// #54 review C: the second Ctrl+C paints `› Shutting down...` DIM and wipes
// the hint row. Cells alone read that as an empty composer; an empty-only
// caller would write into an exiting process.
it('never reads the quit frame as empty', async () => {
  // Cut right after the paint that shows `› Shutting down...` (#54 review
  // round 2 B: the exit event comes after the screen was cleared).
  const quit = recording.events.find(event => event.dir === 'out' && event.data!.includes('Shutting down'))!.t
  const terminal = await replayUntil(quit + 1)
  expect(terminal.snapshotPlain()).toContain('› Shutting down...')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).not.toBe('empty')
})

// #54 review round 2 (A, B, C): the status row carries the cwd, which is
// user-controlled, so a hint word in it must never count as Codex's hint.
it('never takes a hint from the cwd in the status row', () => {
  const status = (cwd: string) => row(`  GPT-6-Sol high fast · ${cwd}`)
  expect(classifyCodexComposerState([row('  [Image #1]'), row(''), row('› Ask Codex to do anything', true), row(''), status('~/for shortcuts')])).toBe('unknown')
  expect(classifyCodexComposerState([row('› Shutting down...', true), row(''), status('~/for shortcuts')])).toBe('unknown')
  expect(classifyCodexComposerState([row('› Ask Codex to do anything', true), row(''), status('~/to queue message'), row('  ← for agents · ? for shortcuts')])).toBe('empty')
})

const row = (text: string, dim = false) => ({ text, cells: [...text].filter(c => c.trim()).map(chars => ({ chars, dim })) })
const IDLE_FOOTER = [row('  GPT-6-Sol high fast · ~/p'), row('  ← for agents · ? for shortcuts')]
const STATUS_ONLY = [row('  GPT-6-Sol high fast · ~/p')]

it('is empty only when Codex says so, with the shortcuts hint', () => {
  expect(classifyCodexComposerState([row('› '), row('Ask Codex to do anything', true), row(''), ...IDLE_FOOTER])).toBe('empty')
  expect(classifyCodexComposerState([row('›'), row(''), ...IDLE_FOOTER])).toBe('empty')
  // No hint (a draft hid it, a narrow pane dropped it, or Codex is quitting):
  // not provably empty.
  expect(classifyCodexComposerState([row('›'), row(''), ...STATUS_ONLY])).toBe('unknown')
})

// #54 review A: an attached image sits ABOVE the textarea, which keeps its
// dim placeholder. Codex then shows no shortcuts hint (its is_empty counts
// attachments), so it is never empty; an image label in the composer rows
// is a draft outright.
it('never reads an image attachment as empty', () => {
  expect(classifyCodexComposerState([row('  [Image #1]'), row(''), row('› Ask Codex to do anything', true), row(''), ...STATUS_ONLY])).toBe('unknown')
  expect(classifyCodexComposerState([row('› [Image #1]', true), row(''), ...IDLE_FOOTER])).toBe('drafted')
})

// #54 review A: during a turn the queue hint replaces the status row. The
// recorded 0.149.1 case `active-footer-tab-queue` (screenBeforeFinalWrite).
it('reads a draft under the running-turn queue footer as drafted', () => {
  const recorded = ['', ' ', '<activity> Working (<elapsed> • esc to interrupt)', ' ', ' ', '› RECORDED_QUEUED_PROMPT', ' ', '  tab to queue message' + ' '.repeat(99) + '100% context left']
  expect(classifyCodexComposerState(recorded.map(text => row(text)))).toBe('drafted')
  // The queue hint is Codex saying "draft" (ComposerHasDraft while a task
  // runs), even when the composer row's cells happen to be styled dim.
  expect(classifyCodexComposerState([row('› [Pasted Content 1204 chars]', true), row(''), row('  tab to queue message' + ' '.repeat(40) + '100% context left')])).toBe('drafted')
})

// #54 review B: text only on a continuation row (a draft that begins with a
// newline) is a draft, and the long-draft bound holds.
it('reads a draft on continuation rows, up to the composer bound', () => {
  expect(classifyCodexComposerState([row('›'), row('  real draft'), row(''), ...IDLE_FOOTER])).toBe('drafted')
  const continuation = (count: number) => Array.from({ length: count }, () => row('  more of the draft'))
  expect(classifyCodexComposerState([row('› start'), ...continuation(11), row(''), ...STATUS_ONLY])).toBe('drafted')
  expect(classifyCodexComposerState([row('› start'), ...continuation(12), row(''), ...STATUS_ONLY])).toBe('unknown')
})

// A transcript user message starts with `›` too, and it is plain text. With
// no footer directly below it, it must never be read as the composer. And a
// footer with no marker above it is not a composer either (#54 review B).
it('does not read a transcript row, a markerless pane or Vim mode as a composer state', () => {
  expect(classifyCodexComposerState([row('› an earlier user message'), row(''), row('• assistant reply')])).toBe('unknown')
  expect(classifyCodexComposerState([row('  status left'), row(''), ...IDLE_FOOTER])).toBe('unknown')
  expect(classifyCodexComposerState([row('›'), row(''), row('  gpt · ~/p      Vim: Insert')])).toBe('unknown')
  expect(classifyCodexComposerState([row('›'), row(''), row('  gpt · ~/p'), row('  ? for shortcuts      Vim: Normal')])).toBe('unknown')
})
