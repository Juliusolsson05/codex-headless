import type { IPty } from 'node-pty'
import { readFileSync } from 'node:fs'

import { afterEach, expect, it } from 'vitest'

import { CodexHeadless } from './CodexHeadless.js'

// codex-headless#55 review B/C: agent-code reads the settled screen only
// through `CodexHeadless.getSettledScreen()`, so the public wrapper is the
// boundary to pin. A wrapper that returned `getScreen()` would hand the paint
// from before the human's keystrokes to a text proof of an empty composer.
// Same raw codex-cli 0.157.0 recording as parsers/ComposerState.recorded.test.ts.
type Recording = { cols: number; rows: number; events: Array<{ t: number; dir: string; label?: string; data?: string }> }
const recording = JSON.parse(readFileSync(
  new URL('../testing/fixtures/composer-0157/idle-draft-ctrlc.json', import.meta.url),
  'utf8',
)) as Recording
const at = (label: string) => recording.events.find(event => event.label === label)!.t

const stops: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })

it('returns the settled frame, null while bytes are parsing, then the new frame', async () => {
  const listeners = new Set<(data: string) => void>()
  const pty = {
    write: () => undefined,
    resize: () => undefined,
    onData: (listener: (data: string) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
  const headless = new CodexHeadless({ pty, cwd: '/recorded/worktree', cols: recording.cols, rows: recording.rows })
  stops.push(() => headless.stop())
  // start() also acquires the rollout file; only the terminal mirror is under
  // test, so attach it the way start() does.
  ;(headless as unknown as { terminal: { attach(): void } }).terminal.attach()
  const feed = (from: number, until: number) => {
    for (const event of recording.events) {
      if (event.dir === 'out' && event.t >= from && event.t < until) for (const listener of listeners) listener(event.data!)
    }
  }
  const settled = async () => {
    const deadline = Date.now() + 2000
    while (headless.getSettledScreen() === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  }

  feed(0, at('type-draft'))
  await settled()
  expect(headless.getSettledScreen()).toContain('› Ask Codex to do anything')

  feed(at('type-draft'), at('ctrl-c-1'))
  expect(headless.getScreen()).toContain('› Ask Codex to do anything')
  expect(headless.getSettledScreen()).toBeNull()

  await settled()
  expect(headless.getSettledScreen()).toContain('› please review the draft')
})
