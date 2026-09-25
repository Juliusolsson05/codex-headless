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

// A transcript user message starts with `›` too, and it is plain text. With
// no footer directly below it, it must never be read as the composer.
it('does not read a transcript row as the composer', () => {
  const row = (text: string, dim = false) => ({ text, cells: [...text].filter(c => c.trim()).map(chars => ({ chars, dim })) })
  expect(classifyCodexComposerState([row('› an earlier user message'), row(''), row('• assistant reply')])).toBe('unknown')
  expect(classifyCodexComposerState([row('› typed'), row(''), row('  gpt · ~/p  Vim: Insert'.replace('  Vim', '      Vim'))])).toBe('unknown')
  // Painted dim here on purpose: an attachment label is content however it is
  // styled, so the label alone must make the composer drafted.
  expect(classifyCodexComposerState([row('› [Image #1]', true), row(''), row('  gpt · ~/p')])).toBe('drafted')
  expect(classifyCodexComposerState([row('›'), row(''), row('  gpt · ~/p')])).toBe('empty')
})
