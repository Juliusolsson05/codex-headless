import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

// steering q96 / #70: the "never an older prompt" invariant must hold at the
// COMMIT boundary. The first fix checked the generation and THEN awaited an
// async rename. `record(B)` could run while that rename was in flight: it
// unlinked the public file, then A's rename landed and restored A as
// "latest" while B was still being written. A bundle read or a crash in that
// window labelled an older prompt current.
//
// This holds every async `rename` from fs/promises at a gate and spies the
// synchronous one, so the test can record B exactly while A's commit is
// pending, whichever API the implementation commits with.
const gate = vi.hoisted(() => ({
  held: [] as Array<() => void>,
  commits: 0,
}))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      gate.commits += 1
      await new Promise<void>(resolve => gate.held.push(resolve))
      return actual.rename(from, to)
    },
  }
})

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      gate.commits += 1
      return actual.renameSync(from, to)
    },
  }
})

const { LatestRequestBodySidecar } = await import('./latestRequestBody.js')

const dirs: string[] = []
afterEach(() => {
  for (const release of gate.held.splice(0)) release()
  gate.commits = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

it('never restores an older body when a newer one is recorded during its commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cxh-latest-body-fence-'))
  dirs.push(dir)
  const sidecar = new LatestRequestBodySidecar(join(dir, 'proxy-events.jsonl'))

  sidecar.record('req-a', 'responses', Buffer.from('OLDER prompt A'))
  // A has written its temp file and reached its commit.
  await until(() => gate.commits === 1)

  // B arrives now. It is large, so its own write spans many turns and cannot
  // commit within the window below.
  sidecar.record('req-b', 'responses', Buffer.alloc(4 * 1024 * 1024, 0x62))
  for (const release of gate.held.splice(0)) release()
  // Let A's commit, if it was still pending, land.
  await new Promise(resolve => setTimeout(resolve, 20))

  // Before B commits, the public file is absent or B: never A.
  if (existsSync(sidecar.path)) {
    expect(readFileSync(sidecar.path, 'utf8')).not.toContain(Buffer.from('OLDER prompt A').toString('base64'))
  }

  // Let every remaining write finish, releasing any rename that is held.
  const releaser = setInterval(() => { for (const release of gate.held.splice(0)) release() }, 1)
  try {
    await sidecar.flush()
  } finally {
    clearInterval(releaser)
  }
  expect(readFileSync(sidecar.path, 'utf8')).toContain('"requestId":"req-b"')
})
