#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const packageEntry = new URL('../dist/index.js', import.meta.url)
const deepEntry = new URL(
  '../dist/transcript/CodexResumeRolloutPreparation.js',
  import.meta.url,
)
const builtBytes = await readFile(packageEntry)
const built = await import(packageEntry.href) as Record<string, unknown>
const deepBuilt = await import(deepEntry.href) as Record<string, unknown>
const Constructor = deepBuilt.CodexResumeRolloutPreparation as
  | (new (options: Record<string, unknown>) => { dispose(clean?: boolean): Promise<void> })
  | undefined

if (!Constructor) {
  throw new Error('The recorded package no longer exports CodexResumeRolloutPreparation')
}

const sentinels = {
  sessionsDir: '/recorded/private/sessions',
  initialPath: '/recorded/private/sessions/rollout-recorded-provider-id.jsonl',
  initialGenerationId: 'recorded-dev:ino',
  resumeThreadId: 'recorded-provider-id',
  cwd: '/recorded/private/worktree',
}
const preparation = new Constructor({
  ...sentinels,
  acquisition: null,
})
const before = project(preparation)
await preparation.dispose(true)
const after = project(preparation)

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  recordedPackageHead: '6244eac4a24ac1fb2aa6d12227cd85c106590ca7',
  builtArtifactSha256: createHash('sha256').update(builtBytes).digest('hex'),
  constructorExportedFromRoot: typeof built.CodexResumeRolloutPreparation === 'function',
  constructorAvailableByPackageDeepImport: true,
  constructionWithoutFactorySucceeded: true,
  beforeDispose: before,
  afterDispose: after,
}, null, 2)}\n`)

function project(value: object): Record<string, unknown> {
  const serialized = JSON.stringify(value)
  const ownKeys = Reflect.ownKeys(value).map(String).sort()
  const enumerableKeys = Object.keys(value).sort()
  return {
    ownKeys,
    enumerableKeys,
    jsonKeys: Object.keys(JSON.parse(serialized) as object).sort(),
    serializedContains: Object.fromEntries(
      Object.entries(sentinels).map(([name, sentinel]) => [name, serialized.includes(sentinel)]),
    ),
  }
}
