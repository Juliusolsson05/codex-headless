import type { IPty } from 'node-pty'

import { describe, expect, it } from 'vitest'

import { HeadlessTerminal } from './HeadlessTerminal.js'

function controlledPty() {
  const dataListeners = new Set<(data: string) => void>()
  const resizeCalls: Array<[number, number]> = []
  const pty = {
    write: () => undefined,
    resize: (cols: number, rows: number) => resizeCalls.push([cols, rows]),
    onData: (listener: (data: string) => void) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
  return {
    pty,
    resizeCalls,
    emitData: (data: string) => {
      for (const listener of dataListeners) listener(data)
    },
  }
}

async function waitForFrame(
  terminal: HeadlessTerminal,
  predicate: (frame: NonNullable<ReturnType<HeadlessTerminal['snapshotStableFrame']>>) => boolean,
) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const frame = terminal.snapshotStableFrame()
    if (frame && predicate(frame)) return frame
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('stable terminal frame did not reach the recorded boundary')
}

describe('HeadlessTerminal provider layout epochs', () => {
  it('keeps resized xterm geometry unacknowledged until later provider bytes parse', async () => {
    const controlled = controlledPty()
    const terminal = new HeadlessTerminal({
      pty: controlled.pty,
      cols: 52,
      rows: 24,
      snapshotIntervalMs: 1,
    })
    terminal.attach()

    try {
      controlled.emitData('\x1b[2J\x1b[H› recorded narrow draft')
      const narrow = await waitForFrame(
        terminal,
        frame => frame.generation === 1,
      )
      expect(narrow).toMatchObject({
        cols: 52,
        layoutEpoch: 0,
        providerLayoutEpoch: 0,
      })

      terminal.resize(92, 24)
      const beforeRedraw = terminal.snapshotStableFrame()
      // WHY this is the exact Stage 29 interval: xterm changes synchronously,
      // but no PTY bytes have demonstrated that Codex saw SIGWINCH. Returning a
      // complete frame is useful to rendering; the unequal epochs make it
      // unusable as prompt ownership evidence.
      expect(beforeRedraw).toMatchObject({
        generation: 1,
        cols: 92,
        layoutEpoch: 1,
        providerLayoutEpoch: 0,
      })
      expect(controlled.resizeCalls).toEqual([[92, 24]])

      controlled.emitData('\x1b[2J\x1b[H› recorded wide draft')
      const afterRedraw = await waitForFrame(
        terminal,
        frame => frame.generation === 2,
      )
      expect(afterRedraw).toMatchObject({
        cols: 92,
        layoutEpoch: 1,
        providerLayoutEpoch: 1,
      })
    } finally {
      terminal.dispose()
    }
  })
})
