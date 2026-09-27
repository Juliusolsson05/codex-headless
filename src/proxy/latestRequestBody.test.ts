import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { LatestRequestBodySidecar } from './latestRequestBody.js'

// #70 review a: "never an older prompt" must hold at every instant a bundle
// can read the file, not only once writes settle, and a large body must not
// be encoded in one main-process turn.

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function sidecarIn(): LatestRequestBodySidecar {
  const dir = mkdtempSync(join(tmpdir(), 'cxh-latest-body-unit-'))
  dirs.push(dir)
  return new LatestRequestBodySidecar(join(dir, 'proxy-events.jsonl'))
}
const bodyOf = (path: string) => Buffer.from((JSON.parse(readFileSync(path, 'utf8')) as { body_b64: string }).body_b64, 'base64')

it('removes the older body the moment a newer one is recorded', async () => {
  const sidecar = sidecarIn()
  sidecar.record('req-1', 'responses', Buffer.from('older prompt'))
  await sidecar.flush()
  expect(existsSync(sidecar.path)).toBe(true)

  sidecar.record('req-2', 'responses', Buffer.from('newer prompt'))
  // Synchronously, before any write: a reader (or a crash) now sees no body,
  // never the older one.
  expect(existsSync(sidecar.path)).toBe(false)
  await sidecar.flush()
  expect(bodyOf(sidecar.path).toString()).toBe('newer prompt')
})

it('never lets a superseded in-flight write rename over a newer body', async () => {
  const sidecar = sidecarIn()
  // A large body takes several turns to encode, so the next record lands
  // while it is still in flight.
  const large = Buffer.alloc(4 * 1024 * 1024, 0x61)
  sidecar.record('req-1', 'responses', large)
  sidecar.record('req-2', 'responses', Buffer.from('newest prompt'))
  await sidecar.flush()

  expect(bodyOf(sidecar.path).toString()).toBe('newest prompt')
  // The superseded write left no temp file behind.
  expect(readdirSync(join(sidecar.path, '..')).filter(name => name.endsWith('.tmp'))).toEqual([])
})

it('writes a multi-slice body that round-trips byte for byte', async () => {
  const sidecar = sidecarIn()
  // Not a multiple of the 768 KiB slice, and arbitrary bytes (a zstd frame is
  // binary), so slice boundaries and padding are both exercised.
  const body = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 7 }, (_, i) => (i * 131 + 7) % 256))
  sidecar.record('req-1', 'responses', body)
  await sidecar.flush()

  expect(bodyOf(sidecar.path).equals(body)).toBe(true)
  expect(readFileSync(sidecar.path, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
})

it('does not resurrect an in-flight older body after a newer one was too big to keep', async () => {
  // The newer body is over the cap, so nothing replaces the file; only the
  // superseded write's own generation check stops it renaming the older body
  // back in as "latest".
  const sidecar = sidecarIn()
  sidecar.record('req-1', 'responses', Buffer.alloc(4 * 1024 * 1024, 0x61))
  sidecar.record('req-2', 'responses', Buffer.alloc(16 * 1024 * 1024 + 1, 0x62))
  await sidecar.flush()

  expect(existsSync(sidecar.path)).toBe(false)
})

it('sweeps a crash-left temp file on the next successful commit', async () => {
  // #70 review c: a crash between writing and renaming leaves a temp file
  // holding a full prompt. It used to be cleaned only after a failed write.
  const sidecar = sidecarIn()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${sidecar.path}.99999.7.tmp`, 'crash-left prompt body')
  sidecar.record('req-1', 'responses', Buffer.from('prompt'))
  await sidecar.flush()
  expect(readdirSync(join(sidecar.path, '..')).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect(bodyOf(sidecar.path).toString()).toBe('prompt')
})
