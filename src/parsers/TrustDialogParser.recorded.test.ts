import type { IPty } from 'node-pty'
import { readFileSync } from 'node:fs'

import { afterEach, expect, it } from 'vitest'

import { trustDialogModule } from '../conditions/trustDialog.js'
import { HeadlessTerminal } from '../terminal/HeadlessTerminal.js'
import { extractCodexStreamingText } from './ScreenParser.js'
import { detectCodexTrustDialog } from './TrustDialogParser.js'

// #65: a raw PTY recording of codex-cli 0.157.1 showing its trust dialog in a
// fresh untrusted folder (see the fixture's `source`; no key was ever sent).
// Replayed through the real terminal so the frame the parser reads is xterm's
// own parse of Codex's bytes: the cursor-addressed word placement, the
// highlighted row's full-width padding and the hard-wrapped path all come
// from upstream, not from a hand-written string. Every assertion below was red
// on main, where this dialog read as not visible.
type Recording = { cols: number; rows: number; events: Array<{ t: number; dir: string; data?: string }> }
const recording = JSON.parse(readFileSync(
  new URL('../../testing/fixtures/trust-dialog-0157/folder-access-back.json', import.meta.url),
  'utf8',
)) as Recording

const terminals: HeadlessTerminal[] = []
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })

// Batched feed with a drain between batches, for the reasons written down in
// ComposerState.recorded.test.ts (#57): draining is the completion signal, and
// no wall-clock deadline decides when the frame is "done".
async function replay(): Promise<HeadlessTerminal> {
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
  const chunks = recording.events.filter(event => event.dir === 'out').map(event => event.data!)
  for (let start = 0; start < chunks.length; start += 50) {
    for (const chunk of chunks.slice(start, start + 50)) for (const listener of listeners) listener(chunk)
    while ((terminal as unknown as { pendingWrites: number }).pendingWrites !== 0) await new Promise(resolve => setImmediate(resolve))
  }
  return terminal
}

it('detects the recorded 0.157.1 Folder access dialog with its on-screen labels and keystrokes', async () => {
  const screen = (await replay()).snapshotPlain()
  expect(screen).toContain('Folder access')

  const state = detectCodexTrustDialog(screen)
  expect(state).toEqual({
    visible: true,
    // Painted over two rows (hard wrap at 76 columns); joined back into one.
    workspace: '/private/tmp/claude-501/-Users-fixture-user-Desktop-Development-agent-code/d0000000-0000-0000-0000-000000000000/scratchpad/rec/untrusted-ABCD',
    options: [
      { key: '1', label: 'Trust and continue' },
      { key: '2', label: 'Back to Agent Command Center' },
    ],
    layout: 'folder-access',
    acceptKeys: '1\r',
    declineKeys: '2',
  })

  // The condition the app renders: ids unchanged, but the reject button says
  // what the key really does here (back to the overview, Codex keeps running).
  expect(trustDialogModule.actions(state)).toEqual([
    { kind: 'pty', id: 'accept', label: 'Trust and continue', data: '1\r' },
    { kind: 'pty', id: 'reject', label: 'Back to Agent Command Center', data: '2' },
  ])

  // The streaming-text extractor must treat the dialog as a blocking screen,
  // not as assistant output.
  expect(extractCodexStreamingText(screen)).toBe('')
})
