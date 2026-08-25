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
}

const [
  built,
  promptRuntime,
  coordinatorRuntime,
] = await Promise.all([
  import(builtEntries.root.href) as Promise<Record<string, unknown>>,
  import(builtEntries.prompt.href) as Promise<Record<string, unknown>>,
  import(builtEntries.coordinator.href) as Promise<Record<string, unknown>>,
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

if (!prepareCodexResumeRollout || !SubmittedPromptInput ||
  !FreshRolloutOwnershipCoordinator) {
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
    ch07StructuralPromptProfile: promptProjection,
    ch08RetentionInspection: retentionProjection,
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
