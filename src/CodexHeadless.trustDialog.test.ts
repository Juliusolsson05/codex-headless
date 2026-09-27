import type { IPty } from 'node-pty'
import { readFileSync } from 'node:fs'

import { afterEach, expect, it } from 'vitest'

import { CodexHeadless } from './CodexHeadless.js'

// #67 review (a and b): the legacy `trust_dialog` event carries accept/reject
// callbacks that write to the PTY, and a mutation that made accept write the
// legacy '1' survived every parser test. On 0.156+ that '1' only moves the
// highlight and leaves Codex waiting on the dialog. This drives the public
// class with the recorded 0.157.1 dialog and checks the bytes it writes.
type Recording = { cols: number; rows: number; events: Array<{ t: number; dir: string; data?: string }> }
const recording = JSON.parse(readFileSync(
  new URL('../testing/fixtures/trust-dialog-0157/folder-access-back.json', import.meta.url),
  'utf8',
)) as Recording

const stops: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })

it('answers the recorded 0.157.1 dialog with 1+Enter to accept and 2 to decline', async () => {
  const listeners = new Set<(data: string) => void>()
  const written: string[] = []
  const pty = {
    write: (data: string) => { written.push(data) },
    resize: () => undefined,
    onData: (listener: (data: string) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
  const headless = new CodexHeadless({ pty, cwd: '/recorded/untrusted', cols: recording.cols, rows: recording.rows })
  stops.push(() => headless.stop())
  const events: Array<{ type: string; accept?: () => void; reject?: () => void }> = []
  headless.on('event', (event: { type: string }) => { if (event.type === 'trust_dialog') events.push(event) })
  // start() also acquires the rollout file; only the screen path is under
  // test, so attach the terminal the way start() does.
  ;(headless as unknown as { terminal: { attach(): void } }).terminal.attach()
  for (const event of recording.events) if (event.dir === 'out') for (const listener of listeners) listener(event.data!)

  // Waits on the event itself (the completion signal), never on a wall clock;
  // a detector that never fires fails on the test timeout.
  while (events.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
  const [trust] = events
  trust!.accept!()
  trust!.reject!()
  expect(written).toEqual(['1\r', '2'])
})
