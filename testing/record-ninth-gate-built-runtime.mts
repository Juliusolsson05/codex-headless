#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const fixtureRoot = join(packageRoot, 'testing', 'fixtures')
const builtEntries = {
  root: new URL('../dist/index.js', import.meta.url),
  resume: new URL(
    '../dist/transcript/CodexResumeRolloutPreparation.js',
    import.meta.url,
  ),
  prompt: new URL('../dist/transcript/SubmittedPromptInput.js', import.meta.url),
  coordinator: new URL(
    '../dist/transcript/FreshRolloutOwnershipCoordinator.js',
    import.meta.url,
  ),
  registry: new URL(
    '../dist/transcript/FreshRolloutOwnershipCoordinatorRegistry.js',
    import.meta.url,
  ),
}

const [
  built,
  resumeRuntime,
  promptRuntime,
  coordinatorRuntime,
  registryRuntime,
] = await Promise.all([
  import(builtEntries.root.href) as Promise<Record<string, unknown>>,
  import(builtEntries.resume.href) as Promise<Record<string, unknown>>,
  import(builtEntries.prompt.href) as Promise<Record<string, unknown>>,
  import(builtEntries.coordinator.href) as Promise<Record<string, unknown>>,
  import(builtEntries.registry.href) as Promise<Record<string, unknown>>,
])

const prepareCodexResumeRollout = built.prepareCodexResumeRollout as
  | ((options: {
      sessionsDir: string
      cwd: string
      resumeThreadId: string
    }) => Promise<{ dispose(clean?: boolean): Promise<void> }>)
  | undefined
const SubmittedPromptInput = promptRuntime.SubmittedPromptInput as
  | (new () => {
      consume(data: string, context: Record<string, unknown>): string[]
    })
  | undefined
const FreshRolloutOwnershipCoordinator =
  coordinatorRuntime.FreshRolloutOwnershipCoordinator as
    | (new (options: {
        normalizeCwd(value: string): string
        normalizePath(value: string): string
      }) => {
        registerParticipant(options: Record<string, unknown>): { unregister(): void }
        registerResumeParticipant(options: Record<string, unknown>): { unregister(): void }
        inspectRetentionForTesting(): unknown
      })
    | undefined
const acquireFreshRolloutCoordinator =
  registryRuntime.acquireFreshRolloutCoordinator as
    | ((options: {
        sessionsRoot: string
        normalizeCwd(value: string): string
        normalizePath(value: string): string
        onError(error: Error): void
      }) => Promise<{
        coordinator: InstanceType<NonNullable<
          typeof FreshRolloutOwnershipCoordinator
        >>
        release(): Promise<void>
      }>)
    | undefined

if (!prepareCodexResumeRollout || !SubmittedPromptInput ||
  !FreshRolloutOwnershipCoordinator || !acquireFreshRolloutCoordinator) {
  throw new Error('The built ninth-gate modules are incomplete; run npm run build first')
}

const exactFixture = loadJson('rollout-ownership/subagent-0149-exact-attachment.json')
const freshFixture = loadJson('rollout-ownership/concurrent-01491-alpha.json')
const promptCorpus = loadJson('prompt-input/codex-01491-recorded.json')
const priorCapability = loadJson('prompt-input/capability-6244eac-recorded.json')

const temporaryRoot = mkdtempSync(join(tmpdir(), 'codex-ninth-gate-built-'))
try {
  const resumeProjection = await projectResumePrototype()
  const promptProjection = projectStructuralPromptCompatibility()
  const retentionProjection = projectRetentionInspection()
  const registryProjection = await projectGlobalRegistryBridge()
  const moduleSha256 = Object.fromEntries(await Promise.all(
    Object.entries(builtEntries).map(async ([name, url]) => [
      name,
      createHash('sha256').update(await readFile(url)).digest('hex'),
    ]),
  ))

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    recordedPackageHead: execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: packageRoot, encoding: 'utf8' },
    ).trim(),
    moduleSha256,
    sources: {
      priorCapabilityHead: priorCapability.recordedPackageHead,
      priorCapabilityArtifactSha256: sha256File(
        'prompt-input/capability-6244eac-recorded.json',
      ),
      exactRolloutFixtureSha256: sha256File(
        'rollout-ownership/subagent-0149-exact-attachment.json',
      ),
      freshRolloutFixtureSha256: sha256File(
        'rollout-ownership/concurrent-01491-alpha.json',
      ),
      promptInputFixtureSha256: sha256File(
        'prompt-input/codex-01491-recorded.json',
      ),
    },
    ch06ResumePrototype: resumeProjection,
    tenthGateResumeDeepModule: {
      exportNames: Object.keys(resumeRuntime).sort(),
      exposesControllerUnwrapper:
        typeof resumeRuntime.unwrapCodexResumeRolloutPreparation === 'function',
    },
    ch07StructuralPromptProfile: promptProjection,
    ch08RetentionInspection: retentionProjection,
    eleventhGateGlobalRegistry: registryProjection,
  }, null, 2)}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

async function projectResumePrototype(): Promise<Record<string, unknown>> {
  const sessionMeta = exactFixture.lines.find(
    (line: Record<string, unknown>) => line.type === 'session_meta',
  ) as { payload?: { id?: unknown } } | undefined
  const resumeThreadId = sessionMeta?.payload?.id
  if (typeof resumeThreadId !== 'string') {
    throw new Error('Recorded exact fixture has no session_meta id')
  }
  const sessionsDir = join(temporaryRoot, 'sessions')
  const day = join(sessionsDir, '2026', '08', '24')
  mkdirSync(day, { recursive: true })
  const initialPath = join(day, `rollout-recorded-${resumeThreadId}.jsonl`)
  writeFileSync(initialPath, rolloutText(exactFixture))
  const initialStat = statSync(initialPath)
  const initialGenerationId = `${initialStat.dev}:${initialStat.ino}`
  const preparation = await prepareCodexResumeRollout!({
    sessionsDir,
    cwd: '/recorded/worktree',
    resumeThreadId,
  })

  const beforeDispose = projectSensitivePrototypeGetters(preparation, {
    sessionsDir,
    initialPath,
    initialGenerationId,
  })
  await preparation.dispose(true)
  const afterDispose = projectSensitivePrototypeGetters(preparation, {
    sessionsDir,
    initialPath,
    initialGenerationId,
  })
  return { beforeDispose, afterDispose }
}

function projectSensitivePrototypeGetters(
  preparation: object,
  expected: Record<string, string>,
): Record<string, unknown> {
  const sensitiveNames = new Set([
    'ownerId',
    'sessionsDir',
    'initialPath',
    'initialGenerationId',
  ])
  const getters = collectPrototypeGetters(preparation)
    .filter(name => sensitiveNames.has(name))
    .sort()
  const results = Object.fromEntries(getters.map(name => {
    try {
      const value = Reflect.get(preparation, name) as unknown
      return [name, {
        accessible: true,
        valueType: typeof value,
        nonEmpty: typeof value === 'string' && value.length > 0,
        matchesRecordedRuntimeValue:
          name in expected ? value === expected[name] : undefined,
      }]
    } catch (error) {
      return [name, {
        accessible: false,
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      }]
    }
  }))
  return { sensitiveGetterNames: getters, getterResults: results }
}

function projectStructuralPromptCompatibility(): Record<string, unknown> {
  const recordedCase = promptCorpus.cases.find(
    (candidate: Record<string, unknown>) => candidate.id === 'trust-action-then-submit',
  ) as Record<string, unknown> | undefined
  if (!recordedCase) throw new Error('Recorded trust input case is missing')

  const structuralProfile = {
    cliVersion: promptCorpus.provider.cliVersion,
    upstreamTag: promptCorpus.provider.upstreamTag,
    configClass: recordedCase.configClass,
    configOverrides: [...recordedCase.configOverrides],
  }
  const input = new SubmittedPromptInput!()
  const submissions: string[] = []
  for (const write of recordedCase.nonComposerWrites ?? []) {
    submissions.push(...input.consume(write, {
      inputProfile: structuralProfile,
      screenBeforeWrite: recordedCase.modal.join('\n'),
    }))
  }
  const chunks = recordedCase.inputChunks as string[]
  chunks.forEach((chunk, index) => {
    submissions.push(...input.consume(chunk, {
      inputProfile: structuralProfile,
      screenBeforeWrite: index === chunks.length - 1
        ? recordedCase.screenBeforeFinalWrite.join('\n')
        : undefined,
    }))
  })
  return {
    caseId: recordedCase.id,
    profileSource: 'caller-authored-structural-lookalike',
    submissionCount: submissions.length,
    matchedRecordedDurableText:
      submissions.length === 1 && submissions[0] === recordedCase.durableUserText,
  }
}

function projectRetentionInspection(): Record<string, unknown> {
  const freshParticipantId = sessionMetaId(freshFixture)
  const resumeParticipantId = sessionMetaId(exactFixture)
  const coordinator = new FreshRolloutOwnershipCoordinator!({
    normalizeCwd: value => value,
    normalizePath: value => value,
  })
  const fresh = coordinator.registerParticipant({
    participantId: freshParticipantId,
    cwd: '/recorded/worktree',
    onLease: () => undefined,
  })
  const resume = coordinator.registerResumeParticipant({
    participantId: resumeParticipantId,
    cwd: '/recorded/worktree',
    lineageIds: new Set([resumeParticipantId]),
    requiredOverlapLimit: 1,
    onLease: () => undefined,
  })
  const inspection = coordinator.inspectRetentionForTesting() as {
    participants?: Array<Record<string, unknown>>
    resumeParticipants?: Array<Record<string, unknown>>
  }
  const serialized = JSON.stringify(inspection)
  fresh.unregister()
  resume.unregister()
  return {
    participantEntryKeys: Object.keys(inspection.participants?.[0] ?? {}).sort(),
    resumeParticipantEntryKeys:
      Object.keys(inspection.resumeParticipants?.[0] ?? {}).sort(),
    serializedContainsFreshParticipantId: serialized.includes(freshParticipantId),
    serializedContainsResumeParticipantId: serialized.includes(resumeParticipantId),
  }
}

async function projectGlobalRegistryBridge(): Promise<Record<string, unknown>> {
  const sessionsRoot = join(temporaryRoot, 'registry-sessions')
  const day = join(sessionsRoot, '2026', '08', '26')
  mkdirSync(day, { recursive: true })
  const participantId = sessionMetaId(exactFixture)
  const rolloutPath = join(day, `rollout-recorded-${participantId}.jsonl`)
  const acquisition = await acquireFreshRolloutCoordinator!({
    sessionsRoot,
    normalizeCwd: value => value,
    normalizePath: value => value,
    onError: error => { throw error },
  })
  const participant = acquisition.coordinator.registerParticipant({
    participantId,
    cwd: '/recorded/worktree',
    onLease: () => undefined,
  })
  writeFileSync(rolloutPath, rolloutText(exactFixture))

  try {
    await waitFor(() =>
      acquisition.coordinator.inspect().observedCandidateCount === 1,
    )
    const symbol = Symbol.for(
      'codex-headless.fresh-rollout-ownership-coordinator-registry',
    )
    const bridge = (globalThis as typeof globalThis & {
      [symbol]?: object
    })[symbol]
    if (!bridge) throw new Error('Built registry bridge was not installed')
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, symbol)
    const globalProjection = projectReflectiveReachability(bridge, {
      coordinator: acquisition.coordinator,
      rawPath: rolloutPath,
      participantId,
    })
    const coordinatorProjection = projectReflectiveReachability(
      acquisition.coordinator,
      {
        coordinator: acquisition.coordinator,
        rawPath: rolloutPath,
        participantId,
      },
    )
    return {
      bridgeFrozen: Object.isFrozen(bridge),
      descriptor: {
        enumerable: descriptor?.enumerable ?? null,
        writable: descriptor && 'writable' in descriptor
          ? descriptor.writable ?? null
          : null,
        configurable: descriptor?.configurable ?? null,
      },
      ...globalProjection,
      coordinatorReachableHmacKey: coordinatorProjection.reachableHmacKey,
    }
  } finally {
    participant.unregister()
    await acquisition.release()
  }
}

function projectReflectiveReachability(
  root: object,
  expected: {
    coordinator: object
    rawPath: string
    participantId: string
  },
): Record<string, boolean> {
  const visited = new WeakSet<object>()
  const projection = {
    reachableMap: false,
    reachableSet: false,
    reachableHmacKey: false,
    reachableCoordinator: false,
    reachableRawPath: false,
    reachableParticipantId: false,
  }
  const visit = (value: unknown, propertyName: string | null, depth: number): void => {
    if (typeof value === 'string') {
      projection.reachableRawPath ||= value === expected.rawPath
      projection.reachableParticipantId ||= value === expected.participantId
      return
    }
    if ((typeof value !== 'object' && typeof value !== 'function') ||
      value === null || depth > 8) return
    if (value === expected.coordinator) projection.reachableCoordinator = true
    if (Buffer.isBuffer(value) && propertyName === 'hmacKey') {
      projection.reachableHmacKey = true
    }
    if (visited.has(value)) return
    visited.add(value)
    if (value instanceof Map) {
      projection.reachableMap = true
      for (const [key, entry] of value) {
        visit(key, null, depth + 1)
        visit(entry, null, depth + 1)
      }
    } else if (value instanceof Set) {
      projection.reachableSet = true
      for (const entry of value) visit(entry, null, depth + 1)
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (descriptor && 'value' in descriptor) {
        visit(descriptor.value, String(key), depth + 1)
      }
    }
  }
  visit(root, null, 0)
  return projection
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (!predicate()) throw new Error('Timed out waiting for built rollout')
}

function collectPrototypeGetters(value: object): string[] {
  const names = new Set<string>()
  let prototype = Object.getPrototypeOf(value) as object | null
  while (prototype && prototype !== Object.prototype) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(prototype),
    )) {
      if (typeof descriptor.get === 'function') names.add(name)
    }
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  return [...names]
}

function sessionMetaId(fixture: Record<string, any>): string {
  const value = fixture.lines.find(
    (line: Record<string, unknown>) => line.type === 'session_meta',
  )?.payload?.id
  if (typeof value !== 'string') throw new Error('Recorded fixture has no session_meta id')
  return value
}

function rolloutText(fixture: Record<string, any>): string {
  return `${fixture.lines.map((line: unknown) => JSON.stringify(line)).join('\n')}\n`
}

function loadJson(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(join(fixtureRoot, relativePath), 'utf8'))
}

function sha256File(relativePath: string): string {
  return createHash('sha256')
    .update(readFileSync(join(fixtureRoot, relativePath)))
    .digest('hex')
}
