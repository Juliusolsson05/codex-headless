import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IPty } from 'node-pty'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
} from './FreshRolloutClaim.js'
import { acquireFreshRolloutCoordinator } from './FreshRolloutOwnershipCoordinatorRegistry.js'
import {
  prepareCodexResumeRollout,
  type CodexResumeRolloutPreparation,
} from './CodexResumeRolloutPreparation.js'
import { normalizeRolloutOwnershipPath } from './OwnershipNormalization.js'
import { CodexHeadless } from '../CodexHeadless.js'
import * as codexHeadlessApi from '../index.js'

type RecordedOwnershipFixture = {
  ownership: { localPromptToken: string }
  lines: Array<Record<string, unknown>>
}

const fixtureRoot = fileURLToPath(
  new URL('../../testing/fixtures/rollout-ownership/', import.meta.url),
)
const promptProfileAppServerFixture = fileURLToPath(new URL(
  '../../testing/fixtures/prompt-input/codex-01491-app-server-fixture.mjs',
  import.meta.url,
))
const recordedPromptProfilePreparation =
  await codexHeadlessApi.prepareCodex01491PromptInputProfile({
    binary: process.execPath,
    cwd: process.cwd(),
    baseArgs: [promptProfileAppServerFixture],
    env: {
      ...process.env,
      CODEX_PROFILE_FIXTURE_MODE: 'recorded-safe',
    },
  })
if (!recordedPromptProfilePreparation.ok) {
  throw new Error('recorded config/read profile fixture was refused')
}
const recordedPromptProfile = recordedPromptProfilePreparation.profile
const temporaryDirectories: string[] = []

function loadFixture(id: string): RecordedOwnershipFixture {
  return JSON.parse(
    readFileSync(`${fixtureRoot}${id}.json`, 'utf8'),
  ) as RecordedOwnershipFixture
}

function rolloutText(fixture: RecordedOwnershipFixture): string {
  return `${fixture.lines.map(line => JSON.stringify(line)).join('\n')}\n`
}

function prepareRecordedResume(options: {
  codexHome: string
  cwd: string
  resumeThreadId: string
}): Promise<CodexResumeRolloutPreparation> {
  return prepareCodexResumeRollout({
    sessionsDir: join(options.codexHome, 'sessions'),
    cwd: options.cwd,
    resumeThreadId: options.resumeThreadId,
  })
}

async function prepareRecordedCapabilityFixture(): Promise<{
  codexHome: string
  cwd: string
  generationId: string
  preparation: CodexResumeRolloutPreparation
  rolloutPath: string
  threadId: string
}> {
  // WHY capability tests need the same durable proof as the implementation:
  // constructing a plausible options literal would test our imagination and
  // would entirely skip locator validation, exact-path reservation, generation
  // binding, and copied-lineage registration. This helper starts from the real
  // recorded exact-resume corpus and returns the capability the public factory
  // actually creates, so the opacity boundary is exercised around real state.
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-resume-capability-'))
  temporaryDirectories.push(codexHome)
  const cwd = '/recorded/worktree'
  const fixture = loadFixture('subagent-0149-exact-attachment')
  const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
  const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
  if (typeof threadId !== 'string') {
    throw new Error('recorded exact-id fixture has no thread id')
  }
  const day = join(codexHome, 'sessions', '2026', '08', '24')
  mkdirSync(day, { recursive: true })
  const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
  writeFileSync(rolloutPath, rolloutText(fixture))
  const rolloutStat = statSync(rolloutPath)
  const preparation = await prepareRecordedResume({
    codexHome,
    cwd,
    resumeThreadId: threadId,
  })
  return {
    codexHome,
    cwd,
    generationId: `${rolloutStat.dev}:${rolloutStat.ino}`,
    preparation,
    rolloutPath,
    threadId,
  }
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

function inertPty(): IPty {
  return {
    write: () => undefined,
    resize: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
}

type ProviderFramePty = {
  pty: IPty
  renderComposer(draft: string, options?: { queueWithTab?: boolean }): string
}

function providerFramePty(): ProviderFramePty {
  const listeners = new Set<(data: string) => void>()
  return {
    pty: {
      write: () => undefined,
      resize: () => undefined,
      onData: (listener: (data: string) => void) => {
        listeners.add(listener)
        return { dispose: () => { listeners.delete(listener) } }
      },
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty,
    renderComposer: (draft, options) => {
      const footer = options?.queueWithTab
        ? '  tab to queue message  100% context left'
        : '  gpt-5.6-sol low · /recorded/worktree'
      // WHY these are the recorded 0.149.1 bottom-pane rows, delivered through
      // the real PTY -> xterm boundary. A whole-screen substring or a prompt
      // injected directly into the ownership graph would bypass the precise
      // production proof this system suite exists to protect. Cursor row 37
      // keeps the composer/footer at the physical bottom of the 40-row frame.
      const frame = `\x1b[2J\x1b[H\x1b[37;1H› ${draft}\r\n\r\n${footer}`
      for (const listener of listeners) listener(frame)
      return footer
    },
  }
}

function recordedPromptInputProfile() {
  // WHY the production path accepts only a package-issued capability paired
  // with frozen highest-precedence launch overrides. System tests must cross
  // that same authority boundary; a caller-authored "default keymap" claim
  // would recreate the configuration ambiguity the repair intentionally closes.
  return recordedPromptProfile
}

async function waitForComposerFrame(
  headless: CodexHeadless,
  provider: ProviderFramePty,
  draft: string,
  options?: { queueWithTab?: boolean },
): Promise<void> {
  const footer = provider.renderComposer(draft, options)
  expect(await waitFor(() => headless.getScreen().includes(footer))).toBe(true)
}

afterEach(() => {
  vi.useRealTimers()
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('process-wide fresh rollout watcher', () => {
  it('does not retain a raw sessions root in the process-global registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-private-root-'))
    temporaryDirectories.push(root)
    const acquisition = await acquireFreshRolloutCoordinator({
      sessionsRoot: root,
      normalizeCwd: value => value,
      normalizePath: value => value,
      onError: () => undefined,
    })
    await acquisition.release()

    const symbol = Symbol.for(
      'codex-headless.fresh-rollout-ownership-coordinator-registry',
    )
    const registry = (globalThis as typeof globalThis & {
      [symbol]?: { roots: Map<string, unknown> }
    })[symbol]
    expect(registry).toBeDefined()
    const serialized = JSON.stringify([...registry!.roots.entries()])
    expect(serialized).not.toContain(root)
    for (const key of registry!.roots.keys()) {
      expect(key).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('serializes overlapping headless stop calls around one tail cleanup', async () => {
    const pty = {
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty
    const headless = new CodexHeadless({
      pty,
      cwd: '/recorded/worktree',
    })
    let cleanupCalls = 0
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
    ;(headless as unknown as {
      stopRolloutTail: (() => Promise<void>) | null
    }).stopRolloutTail = async () => {
      cleanupCalls += 1
      await cleanupGate
    }

    const first = headless.stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = headless.stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cleanupCalls).toBe(1)
    releaseCleanup()
    await Promise.all([first, second])
  })

  it('makes explicit stop join cleanup already started by terminal exit', async () => {
    const pty = {
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty
    const headless = new CodexHeadless({
      pty,
      cwd: '/recorded/worktree',
    })
    let cleanupCalls = 0
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
    ;(headless as unknown as {
      stopRolloutTail: (() => Promise<void>) | null
    }).stopRolloutTail = async () => {
      cleanupCalls += 1
      await cleanupGate
    }
    const exitCleanup = (headless as unknown as {
      cleanup(): Promise<void>
    }).cleanup()
    await new Promise(resolve => setTimeout(resolve, 0))
    let stopSettled = false
    const explicitStop = headless.stop().then(() => { stopSettled = true })
    await new Promise(resolve => setTimeout(resolve, 0))

    // WHY a null stopRolloutTail does not mean cleanup finished: the exit path
    // takes the function before awaiting it. stop() must join that in-flight
    // promise so the parent cannot kill the PTY before lease retirement.
    expect(cleanupCalls).toBe(1)
    expect(stopSettled).toBe(false)
    releaseCleanup()
    await Promise.all([exitCleanup, explicitStop])
  })

  it('closes a recorded exact tail acquired after a pre-start stop', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-pre-start-stop-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, `rollout-recorded-${threadId}.jsonl`),
      rolloutText(fixture),
    )
    const makePty = (): IPty => ({
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }) as unknown as IPty
    const cancelledPreparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const cancelled = new CodexHeadless({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: cancelledPreparation,
    })
    let replacement: CodexHeadless | null = null

    try {
      // WHY SessionManager has this exact ordering when cancellation wins its
      // race with provider startup. start() still finishes its awaited setup,
      // but must close that late acquisition before its second stop arrives.
      await cancelled.stop()
      await cancelled.start()

      const replacementPreparation = await prepareRecordedResume({
        codexHome,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      replacement = new CodexHeadless({
        pty: makePty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: replacementPreparation,
      })
      await expect(replacement.start()).resolves.toMatchObject({
        sessionsDir: join(codexHome, 'sessions'),
      })
    } finally {
      await replacement?.stop()
      await cancelled.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('releases a prepared exact resume when stopped without ever starting', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-never-started-resume-'))
    temporaryDirectories.push(codexHome)
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, `rollout-recorded-${threadId}.jsonl`),
      rolloutText(fixture),
    )
    const cancelledPreparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const cancelled = new CodexHeadless({
      pty: inertPty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: cancelledPreparation,
    })
    let replacementPreparation: CodexResumeRolloutPreparation | null = null

    try {
      // WHY this intentionally never calls start(): callers can cancel after
      // preparing ownership but before provider startup is admitted. The opaque
      // capability moved into CodexHeadless at construction, so stop() is the
      // only remaining owner that can release its exact lease and watcher.
      await cancelled.stop()
      replacementPreparation = await prepareRecordedResume({
        codexHome,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      // Factory success is the public proof that exact X was released and could
      // be reserved again; the capability intentionally exposes no path getter.
      expect(replacementPreparation).toBeDefined()
    } finally {
      await replacementPreparation?.dispose(true)
      // Parent rollback and CodexHeadless stop may converge here. Repeating the
      // public operation proves disposal remains idempotent across that handoff.
      await cancelledPreparation.dispose(true)
      await cancelled.stop()
    }
  })

  it('prepares recorded resume lineage before a reconstructed fork can exist', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-pre-spawn-resume-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMetaIndex = fixture.lines.findIndex(line => line.type === 'session_meta')
    const sessionMeta = fixture.lines[sessionMetaIndex]
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const forkThreadId = '00000000-0000-4000-8000-000000000055'
    const forkLines = structuredClone(fixture.lines)
    ;(forkLines[sessionMetaIndex]!.payload as { id: string }).id = forkThreadId
    const sessionsRoot = join(codexHome, 'sessions')
    const day = join(sessionsRoot, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, `rollout-recorded-${threadId}.jsonl`),
      rolloutText(fixture),
    )
    const errors: Error[] = []
    const freshAcquisition = await acquireFreshRolloutCoordinator({
      sessionsRoot,
      normalizeCwd: normalizeRolloutOwnershipPath,
      normalizePath: normalizeRolloutOwnershipPath,
      onError: error => errors.push(error),
    })
    const freshLeases: string[] = []
    const fresh = freshAcquisition.coordinator.registerParticipant({
      participantId: `pre-spawn-fresh-${codexHome}`,
      cwd: '/recorded/worktree',
      onLease: lease => freshLeases.push(lease.filePath),
    })
    const parsedFork = parseFreshRolloutCandidate(
      `/recorded/${fixture.ownership.localPromptToken ?? 'exact'}.jsonl`,
      rolloutText(fixture),
    )
    const copiedPrompt = parsedFork?.userMessages.at(-1)?.text
    if (!copiedPrompt) throw new Error('recorded exact fixture has no copied prompt')
    fresh.registerPrompt(copiedPrompt)
    const prepare = (codexHeadlessApi as unknown as {
      prepareCodexResumeRollout?: (options: {
        sessionsDir: string
        cwd: string
        resumeThreadId: string
      }) => Promise<unknown>
    }).prepareCodexResumeRollout
    let preparation: unknown = null
    let resumed: CodexHeadless | null = null

    try {
      // WHY preparation must complete before the consumer spawns Codex: Y can
      // be created immediately by that process, while headless.start() still
      // has asynchronous locator/file reads ahead of lineage registration.
      expect(prepare).toBeTypeOf('function')
      if (!prepare) return
      preparation = await prepare({
        sessionsDir: sessionsRoot,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      const makePty = (): IPty => ({
        write: () => undefined,
        resize: () => undefined,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
      }) as unknown as IPty
      const PreparedCodexHeadless = CodexHeadless as unknown as new (options: {
        pty: IPty
        cwd: string
        resumeThreadId: string
        resumeRolloutPreparation: unknown
      }) => CodexHeadless
      resumed = new PreparedCodexHeadless({
        pty: makePty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: preparation,
      })
      const forkPaths: string[] = []
      resumed.on('rollout-entry', (_line, filePath) => {
        if (filePath.endsWith(`${forkThreadId}.jsonl`)) forkPaths.push(filePath)
      })

      // This write stands in for the already-spawned provider. The sibling
      // watcher is intentionally live before Y exists, reproducing the gate's
      // callback ordering without an imagined rollout wire shape.
      writeFileSync(
        join(day, `rollout-recorded-${forkThreadId}.jsonl`),
        `${forkLines.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      await resumed.start()

      expect(await waitFor(() => forkPaths.length > 0, 5000)).toBe(true)
      expect(freshLeases).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await resumed?.stop()
      await (preparation as { dispose?: () => Promise<void> } | null)?.dispose?.()
      fresh.unregister()
      freshAcquisition.coordinator.retireOwnerLeases(
        `pre-spawn-fresh-${codexHome}`,
        true,
      )
      await freshAcquisition.release()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  }, 15_000)

  it('keeps exact resume alive when a buffered ignored-fork observer throws', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-buffered-diagnostic-'))
    temporaryDirectories.push(codexHome)
    const exact = loadFixture('subagent-0149-exact-attachment')
    const unrelated = loadFixture('modern-0149-agents-first')
    const exactMeta = exact.lines.find(line => line.type === 'session_meta')
    const unrelatedMeta = unrelated.lines.find(line => line.type === 'session_meta')
    const threadId = (exactMeta?.payload as { id?: unknown } | undefined)?.id
    const unrelatedThreadId = (
      unrelatedMeta?.payload as { id?: unknown } | undefined
    )?.id
    if (typeof threadId !== 'string' || typeof unrelatedThreadId !== 'string') {
      throw new Error('recorded diagnostic fixtures have no thread ids')
    }
    const sessionsRoot = join(codexHome, 'sessions')
    const day = join(sessionsRoot, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const exactPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    writeFileSync(exactPath, rolloutText(exact))
    const preparation = await prepareCodexResumeRollout({
      sessionsDir: sessionsRoot,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const monitor = await acquireFreshRolloutCoordinator({
      sessionsRoot,
      normalizeCwd: normalizeRolloutOwnershipPath,
      normalizePath: normalizeRolloutOwnershipPath,
      onError: () => undefined,
    })
    const makePty = (): IPty => ({
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }) as unknown as IPty
    const resumed = new CodexHeadless({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: preparation,
    })
    const exactEntries: string[] = []
    resumed.on('rollout-entry', (_line, filePath) => {
      if (filePath === exactPath) exactEntries.push(filePath)
    })
    resumed.on('rollout-diagnostic', diagnostic => {
      if (diagnostic.type === 'resume-fork-ignored') {
        throw new Error('recorded diagnostic observer failure')
      }
    })

    try {
      const observedBefore = monitor.coordinator.inspect().observedCandidateCount
      writeFileSync(
        join(day, `rollout-recorded-${unrelatedThreadId}.jsonl`),
        rolloutText(unrelated),
      )
      // Waiting before start is essential: it proves the decision uses the
      // preparation's buffered replay path, not the coordinator's already
      // exception-isolated live callback path.
      expect(await waitFor(() =>
        monitor.coordinator.inspect().observedCandidateCount > observedBefore,
      )).toBe(true)

      await expect(resumed.start()).resolves.toMatchObject({ sessionsDir: sessionsRoot })
      expect(await waitFor(() => exactEntries.length > 0)).toBe(true)
    } finally {
      await resumed.stop()
      await preparation.dispose()
      await monitor.release()
    }
  })

  it('does not assign later appended prompt bytes to an earlier watcher sequence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-prefix-'))
    temporaryDirectories.push(root)
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const fixture = loadFixture('modern-0149-agents-first')
    const prompt = fixture.ownership.localPromptToken
    const promptLineIndex = fixture.lines.findIndex(line =>
      JSON.stringify(line).includes(prompt),
    )
    if (promptLineIndex <= 0) {
      throw new Error('recorded fixture has no appendable prompt boundary')
    }
    const rolloutPath = join(
      day,
      'rollout-prefix-00000000-0000-4000-8000-000000000003.jsonl',
    )
    const bootstrap = fixture.lines.slice(0, promptLineIndex)
    const appended = fixture.lines.slice(promptLineIndex)
    writeFileSync(
      rolloutPath,
      `${bootstrap.map(line => JSON.stringify(line)).join('\n')}\n`,
    )

    const errors: Error[] = []
    const acquisition = await acquireFreshRolloutCoordinator({
      sessionsRoot: root,
      normalizeCwd: value => value,
      normalizePath: value => value,
      onError: error => errors.push(error),
    })
    const leases: string[] = []
    const handle = acquisition.coordinator.registerParticipant({
      participantId: `prefix-${root}`,
      cwd: '/recorded/worktree',
      onLease: lease => leases.push(lease.filePath),
    })

    try {
      // WHY the file and its initial watcher observation predate the prompt:
      // this reproduces the actual queued-read race. Only the later append's
      // immutable byte boundary is causally eligible to prove ownership.
      handle.registerPrompt(prompt)
      appendFileSync(
        rolloutPath,
        `${appended.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      expect(await waitFor(() => leases.length === 1)).toBe(true)
      expect(leases).toEqual([rolloutPath])
      expect(errors).toEqual([])
    } finally {
      handle.unregister()
      acquisition.coordinator.retireOwnerLeases(`prefix-${root}`, true)
      await acquisition.release()
    }
  })

  it('does not commit replacement-inode bytes under a reserved generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-open-generation-'))
    temporaryDirectories.push(root)
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const fixture = loadFixture('modern-0149-agents-first')
    const prompt = fixture.ownership.localPromptToken
    const rolloutPath = join(
      day,
      'rollout-generation-00000000-0000-4000-8000-000000000071.jsonl',
    )
    const replacementPath = join(day, 'recorded-old-generation.tmp')
    writeFileSync(replacementPath, rolloutText(fixture))
    // WHY B exists before the participant: if the watcher observes B under its
    // own birth/generation identity, the active fresh lower bound rejects it.
    // Only the buggy A-snapshot/B-read combination can make this old recorded
    // history appear causally eligible.
    await new Promise(resolve => setTimeout(resolve, 25))

    const errors: Error[] = []
    const acquisition = await acquireFreshRolloutCoordinator({
      sessionsRoot: root,
      normalizeCwd: value => value,
      normalizePath: value => value,
      onError: error => errors.push(error),
    })
    const symbol = Symbol.for(
      'codex-headless.fresh-rollout-ownership-coordinator-registry',
    )
    const registry = (globalThis as typeof globalThis & {
      [symbol]?: {
        roots: Map<string, {
          coordinator: unknown
          readQueue: Promise<void>
        }>
      }
    })[symbol]
    const rootEntry = [...(registry?.roots.values() ?? [])].find(
      entry => entry.coordinator === acquisition.coordinator,
    )
    if (!rootEntry) throw new Error('recorded watcher registry entry is missing')
    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    rootEntry.readQueue = readGate
    const leases: string[] = []
    const participantId = `open-generation-${root}`
    const handle = acquisition.coordinator.registerParticipant({
      participantId,
      cwd: '/recorded/worktree',
      onLease: lease => leases.push(lease.filePath),
    })

    try {
      handle.registerPrompt(prompt)
      await new Promise(resolve => setTimeout(resolve, 25))
      const firstCodePoint = prompt.codePointAt(0)
      if (firstCodePoint === undefined) {
        throw new Error('recorded fixture prompt token is empty')
      }
      const nonMatchingPrompt = String.fromCodePoint(firstCodePoint + 1)
      const firstGeneration = rolloutText(fixture).replaceAll(
        prompt,
        nonMatchingPrompt,
      )
      // WHY A is the same byte length as B: the immutable prefix cap correctly
      // prevents later appended bytes from borrowing an earlier sequence. This
      // separate race requires B's matching recorded bytes to fit entirely
      // inside A's already-reserved boundary so only generation identity can
      // distinguish the two physical files.
      expect(Buffer.byteLength(firstGeneration)).toBe(
        Buffer.byteLength(rolloutText(fixture)),
      )
      writeFileSync(rolloutPath, firstGeneration)
      expect(await waitFor(() => rootEntry.readQueue !== readGate)).toBe(true)
      const watcherEntry = rootEntry as typeof rootEntry & {
        watcher?: { close(): Promise<void> } | null
        stopWatcherMaintenance?: (() => void) | null
      }
      // WHY the queued-open invariant must stand without help from a later
      // change event: close admission after A is reserved, exactly as shutdown
      // can do, then replace the pathname. Otherwise an O2 reservation for B
      // can hide an O1-open bug by superseding the test's causal sequence.
      watcherEntry.stopWatcherMaintenance?.()
      await watcherEntry.watcher?.close()
      watcherEntry.watcher = null
      // WHY rename is the real pathname race: the reserved stat belongs to A,
      // while the later open resolves the same path to old inode B. A prefix
      // length cap does not establish that both operations addressed one file.
      renameSync(replacementPath, rolloutPath)
      releaseRead()
      await new Promise(resolve => setTimeout(resolve, 750))
      expect(leases).toEqual([])
      expect(errors).toEqual([])
    } finally {
      releaseRead()
      handle.unregister()
      acquisition.coordinator.retireOwnerLeases(participantId, true)
      await acquisition.release()
    }
  })

  it('shares sequential candidate visibility across two live acquisitions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-owner-'))
    temporaryDirectories.push(root)
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const errors: Error[] = []
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: (error: Error) => errors.push(error),
    }
    const alphaAcquisition = await acquireFreshRolloutCoordinator(options)
    const betaAcquisition = await acquireFreshRolloutCoordinator(options)
    const alpha = loadFixture('concurrent-01491-alpha')
    const beta = loadFixture('concurrent-01491-beta')
    const alphaLeases: string[] = []
    const betaLeases: string[] = []
    const alphaHandle = alphaAcquisition.coordinator.registerParticipant({
      participantId: `alpha-${root}`,
      cwd: '/recorded/worktree',
      onLease: lease => alphaLeases.push(lease.filePath),
    })
    const betaHandle = betaAcquisition.coordinator.registerParticipant({
      participantId: `beta-${root}`,
      cwd: '/recorded/worktree',
      onLease: lease => betaLeases.push(lease.filePath),
    })

    expect(alphaAcquisition.coordinator).toBe(betaAcquisition.coordinator)
    alphaHandle.registerPrompt(alpha.ownership.localPromptToken)
    betaHandle.registerPrompt(alpha.ownership.localPromptToken)

    const alphaPath = join(
      day,
      'rollout-2026-08-24T00-00-00-00000000-0000-4000-8000-000000000001.jsonl',
    )
    writeFileSync(alphaPath, rolloutText(alpha))
    expect(await waitFor(() =>
      alphaAcquisition.coordinator.inspect().observedCandidateCount === 1,
    )).toBe(true)
    expect(alphaLeases).toEqual([])
    expect(betaLeases).toEqual([])

    // WHY beta keeps its recorded wrapper/order and changes only the reviewed
    // equality class: the collision policy needs identical private prompt text,
    // but inventing a second rollout wire shape would recreate the original
    // false-confidence problem this corpus exists to prevent.
    const betaPrompt = normalizePromptForOwnership(beta.ownership.localPromptToken)
    const collidingLines = beta.lines.map(line => {
      const copy = structuredClone(line)
      const payload = copy.payload as {
        type?: unknown
        message?: unknown
        role?: unknown
        content?: Array<{ type?: unknown; text?: unknown }>
      } | undefined
      if (payload?.type === 'user_message' &&
        typeof payload.message === 'string' &&
        normalizePromptForOwnership(payload.message) === betaPrompt) {
        payload.message = alpha.ownership.localPromptToken
      }
      if (payload?.role === 'user' && Array.isArray(payload.content)) {
        for (const item of payload.content) {
          if (typeof item.text === 'string' &&
            normalizePromptForOwnership(item.text) === betaPrompt) {
            item.text = alpha.ownership.localPromptToken
          }
        }
      }
      return copy
    })
    const betaPath = join(
      day,
      'rollout-2026-08-24T00-00-01-00000000-0000-4000-8000-000000000002.jsonl',
    )
    writeFileSync(
      betaPath,
      `${collidingLines.map(line => JSON.stringify(line)).join('\n')}\n`,
    )
    expect(await waitFor(() =>
      alphaAcquisition.coordinator.inspect().observedCandidateCount === 2,
    )).toBe(true)
    expect(alphaLeases).toEqual([])
    expect(betaLeases).toEqual([])
    expect(errors).toEqual([])

    alphaHandle.unregister()
    betaHandle.unregister()
    await alphaAcquisition.release()
    await betaAcquisition.release()
  })

  it('continues queued candidate reads after an error observer throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-error-observer-'))
    temporaryDirectories.push(root)
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    let errorCalls = 0
    const acquisition = await acquireFreshRolloutCoordinator({
      sessionsRoot: root,
      normalizeCwd: value => value,
      normalizePath: value => value,
      onError: () => {
        errorCalls += 1
        if (errorCalls === 1) throw new Error('recorded observer failure')
      },
    })
    const symbol = Symbol.for(
      'codex-headless.fresh-rollout-ownership-coordinator-registry',
    )
    const registry = (globalThis as typeof globalThis & {
      [symbol]?: {
        roots: Map<string, {
          coordinator: unknown
          readQueue: Promise<void>
          knownPaths: Set<string>
        }>
      }
    })[symbol]
    const rootEntry = [...(registry?.roots.values() ?? [])].find(
      entry => entry.coordinator === acquisition.coordinator,
    )
    if (!rootEntry) throw new Error('recorded watcher registry entry is missing')
    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    rootEntry.readQueue = readGate
    const first = loadFixture('concurrent-01491-alpha')
    const second = loadFixture('concurrent-01491-beta')
    const secondLeases: string[] = []
    const participantId = `after-observer-failure-${root}`
    const handle = acquisition.coordinator.registerParticipant({
      participantId,
      cwd: '/recorded/worktree',
      onLease: lease => secondLeases.push(lease.filePath),
    })
    handle.registerPrompt(second.ownership.localPromptToken)
    const originalCommit = acquisition.coordinator.commitCandidateObservation
      .bind(acquisition.coordinator)
    let failFirstCommit = true
    acquisition.coordinator.commitCandidateObservation = (
      observation,
      candidate,
      options,
    ) => {
      if (failFirstCommit) {
        failFirstCommit = false
        throw new Error('recorded first queued commit failure')
      }
      return originalCommit(observation, candidate, options)
    }
    const firstPath = join(
      day,
      'rollout-errors-00000000-0000-4000-8000-000000000072.jsonl',
    )
    const secondPath = join(
      day,
      'rollout-errors-00000000-0000-4000-8000-000000000073.jsonl',
    )

    try {
      writeFileSync(firstPath, rolloutText(first))
      writeFileSync(secondPath, rolloutText(second))
      // WHY both real watcher events are admitted behind one gate before the
      // injected commit failure: this removes unhandled-rejection timing from
      // the test and proves the second recorded observation was already queued.
      expect(await waitFor(() => rootEntry.knownPaths.size === 2)).toBe(true)
      releaseRead()
      expect(await waitFor(() => secondLeases.length === 1)).toBe(true)
      expect(secondLeases).toEqual([secondPath])
      expect(errorCalls).toBe(1)
    } finally {
      releaseRead()
      acquisition.coordinator.commitCandidateObservation = originalCommit
      handle.unregister()
      acquisition.coordinator.retireOwnerLeases(participantId, true)
      await acquisition.release()
    }
  })

  it('expires a stopped owner while a sibling acquisition keeps the root live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-live-sibling-'))
    temporaryDirectories.push(root)
    const options = {
      sessionsRoot: root,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const stoppedAcquisition = await acquireFreshRolloutCoordinator(options)
    const siblingAcquisition = await acquireFreshRolloutCoordinator(options)
    const participantId = `stopped-with-live-sibling-${root}`
    const stopped = stoppedAcquisition.coordinator.registerParticipant({
      participantId,
      cwd: '/recorded/worktree',
      onLease: () => undefined,
    })
    const fixture = loadFixture('modern-0149-agents-first')
    const day = join(root, '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, 'rollout-recorded-00000000-0000-4000-8000-000000000066.jsonl'),
      rolloutText(fixture),
    )
    expect(await waitFor(() =>
      stoppedAcquisition.coordinator.inspect().observedCandidateCount > 0,
    )).toBe(true)
    expect(
      (stoppedAcquisition.coordinator.inspectRetentionForTesting() as {
        candidates: Array<{ hasRawPath: boolean }>
      }).candidates.some(candidate => candidate.hasRawPath),
    ).toBe(true)
    vi.useFakeTimers()

    try {
      stopped.registerPrompt('recorded tombstone lifetime')
      stopped.unregister()
      await stoppedAcquisition.release()
      await vi.advanceTimersByTimeAsync(6000)

      // WHY root reference count is watcher transport, not participant
      // lifetime. A long-running sibling cannot retain every stopped prompt
      // HMAC forever merely because its own PTY still needs file events.
      expect(JSON.stringify(
        siblingAcquisition.coordinator.inspectRetentionForTesting(),
      )).not.toContain(participantId)
      expect(
        (siblingAcquisition.coordinator.inspectRetentionForTesting() as {
          candidates: Array<{ hasRawPath: boolean }>
        }).candidates.every(candidate => !candidate.hasRawPath),
      ).toBe(true)
      const symbol = Symbol.for(
        'codex-headless.fresh-rollout-ownership-coordinator-registry',
      )
      const registry = (globalThis as typeof globalThis & {
        [symbol]?: {
          roots: Map<string, {
            coordinator: unknown
            referenceCount: number
            watcher: unknown
            knownPaths: Set<string>
            lastFingerprints: Map<string, string>
          }>
        }
      })[symbol]
      const rootEntry = [...(registry?.roots.values() ?? [])].find(
        entry => entry.coordinator === siblingAcquisition.coordinator,
      )
      expect(rootEntry).toMatchObject({ referenceCount: 1 })
      expect(rootEntry?.watcher).not.toBeNull()
      // WHY coordinator inspection was insufficient evidence for the fifth
      // gate's privacy invariant: the watcher closure kept a second raw copy of
      // every UUID-bearing path after the graph reported hasRawPath:false.
      expect(rootEntry?.knownPaths.size).toBe(0)
      expect(rootEntry?.lastFingerprints.size).toBe(0)
    } finally {
      vi.useRealTimers()
      await siblingAcquisition.release()
    }
  })

  it('claims a recorded fresh rollout after ordinary chunked terminal typing', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-chunked-terminal-input-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('modern-0149-agents-first')
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(
      day,
      'rollout-typed-00000000-0000-4000-8000-000000000074.jsonl',
    )
    const provider = providerFramePty()
    const headless = new CodexHeadless({
      pty: provider.pty,
      cwd: '/recorded/worktree',
      promptInputProfile: recordedPromptInputProfile(),
    })

    try {
      await headless.start()
      // WHY xterm's onData contract is the production boundary: interactive
      // typing arrives as arbitrary key chunks, not sendPrompt's atomic string.
      // Feeding the recorded prompt one scalar at a time prevents this test
      // from blessing the automation-only delivery shape again.
      for (const character of fixture.ownership.localPromptToken) {
        headless.write(character)
      }
      await waitForComposerFrame(
        headless,
        provider,
        fixture.ownership.localPromptToken,
      )
      headless.write('\r')
      writeFileSync(rolloutPath, rolloutText(fixture))
      expect(await waitFor(() =>
        (headless as unknown as { activeRolloutPath: string | null })
          .activeRolloutPath?.endsWith(rolloutPath.split('/').pop()!) === true,
      )).toBe(true)
    } finally {
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('retains a recorded prompt submitted while fresh startup is still priming', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-startup-terminal-input-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('modern-0149-agents-first')
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(
      day,
      'rollout-startup-00000000-0000-4000-8000-000000000076.jsonl',
    )
    const provider = providerFramePty()
    const headless = new CodexHeadless({
      pty: provider.pty,
      cwd: '/recorded/worktree',
      promptInputProfile: recordedPromptInputProfile(),
    })

    try {
      const starting = headless.start()
      // WHY Agent Code publishes the session while start() is pending so xterm
      // can attach to the already-spawned PTY. This synchronous write order is
      // the production race: the provider receives every byte even though the
      // shared watcher has not yet reported ready.
      for (const character of fixture.ownership.localPromptToken) {
        headless.write(character)
      }
      await waitForComposerFrame(
        headless,
        provider,
        fixture.ownership.localPromptToken,
      )
      headless.write('\r')
      await starting
      writeFileSync(rolloutPath, rolloutText(fixture))
      expect(await waitFor(() =>
        (headless as unknown as { activeRolloutPath: string | null })
          .activeRolloutPath?.endsWith(rolloutPath.split('/').pop()!) === true,
      )).toBe(true)
    } finally {
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('does not tail replacement B after fresh ownership authorized inode A', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-fresh-generation-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('modern-0149-agents-first')
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(
      day,
      'rollout-fresh-generation-00000000-0000-4000-8000-000000000078.jsonl',
    )
    const replacementSentinel = 'fresh-replacement-must-not-commit'
    const provider = providerFramePty()
    const headless = new CodexHeadless({
      pty: provider.pty,
      cwd: '/recorded/worktree',
      promptInputProfile: recordedPromptInputProfile(),
    })
    const internal = headless as unknown as {
      tailFile(filePath: string, generationId?: string | null): () => Promise<void>
      activeRolloutPath: string | null
    }
    const openAuthorizedTail = internal.tailFile.bind(headless)
    let authorizedGeneration: string | null | undefined
    let swapped = false
    internal.tailFile = (filePath, generationId) => {
      authorizedGeneration = generationId
      if (!swapped) {
        swapped = true
        renameSync(filePath, `${filePath}.inode-a`)
        writeFileSync(
          filePath,
          `${rolloutText(fixture)}${JSON.stringify({
            timestamp: '2026-08-25T00:00:00.000Z',
            type: 'event_msg',
            payload: { type: 'agent_message', message: replacementSentinel },
          })}\n`,
        )
      }
      return openAuthorizedTail(filePath, generationId)
    }
    const seenMessages: string[] = []
    headless.on('rollout-entry', line => {
      const message = (line.payload as { message?: unknown } | undefined)?.message
      if (typeof message === 'string') seenMessages.push(message)
    })

    try {
      await headless.start()
      await waitForComposerFrame(
        headless,
        provider,
        fixture.ownership.localPromptToken,
      )
      headless.write('\r')
      writeFileSync(rolloutPath, rolloutText(fixture))
      expect(await waitFor(() => swapped)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 300))
      // WHY the hook is after coordinator authorization and immediately before
      // FileTailer construction. It deterministically exercises the exact gap
      // that pathname-only tests otherwise hit only as a filesystem race.
      expect(authorizedGeneration).toMatch(/^\d+:\d+$/)
      expect(internal.activeRolloutPath).toBeNull()
      expect(seenMessages).not.toContain(replacementSentinel)
    } finally {
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('claims the recorded prompt submitted by Tab in a provider-proven state', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-tab-terminal-input-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('modern-0149-agents-first')
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(
      day,
      'rollout-tab-00000000-0000-4000-8000-000000000079.jsonl',
    )
    const provider = providerFramePty()
    const headless = new CodexHeadless({
      pty: provider.pty,
      cwd: '/recorded/worktree',
      promptInputProfile: recordedPromptInputProfile(),
    })

    try {
      await headless.start()
      // Exact rust-v0.149.1 renders this footer only while the active keymap
      // assigns Tab to queue/submit. The screen is real provider state at the
      // pre-write boundary, not an assumption attached to the input byte.
      for (const character of fixture.ownership.localPromptToken) {
        headless.write(character)
      }
      await waitForComposerFrame(
        headless,
        provider,
        fixture.ownership.localPromptToken,
        { queueWithTab: true },
      )
      headless.write('\t')
      writeFileSync(rolloutPath, rolloutText(fixture))
      expect(await waitFor(() =>
        (headless as unknown as { activeRolloutPath: string | null })
          .activeRolloutPath?.endsWith(rolloutPath.split('/').pop()!) === true,
      )).toBe(true)
    } finally {
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('does not claim a sibling rollout for pasted but unsubmitted text', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-unsubmitted-paste-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('modern-0149-agents-first')
    const prompt = fixture.ownership.localPromptToken
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(
      day,
      'rollout-paste-00000000-0000-4000-8000-000000000075.jsonl',
    )
    const pastedProvider = providerFramePty()
    const submittedProvider = providerFramePty()
    const pastedOnly = new CodexHeadless({
      pty: pastedProvider.pty,
      cwd: '/recorded/worktree',
      promptInputProfile: recordedPromptInputProfile(),
    })
    const submitted = new CodexHeadless({
      pty: submittedProvider.pty,
      cwd: '/recorded/worktree',
      promptInputProfile: recordedPromptInputProfile(),
    })

    try {
      await Promise.all([pastedOnly.start(), submitted.start()])
      // WHY bracketed paste completion is not submission: the real renderer
      // deliberately sends Enter later. Recording at the closing marker makes
      // an idle composer a false claimant for a sibling that actually submits.
      pastedOnly.write(`\x1b[200~${prompt}\x1b[201~`)
      await waitForComposerFrame(pastedOnly, pastedProvider, prompt)
      await waitForComposerFrame(submitted, submittedProvider, prompt)
      submitted.write('\r')
      writeFileSync(rolloutPath, rolloutText(fixture))
      expect(await waitFor(() =>
        (submitted as unknown as { activeRolloutPath: string | null })
          .activeRolloutPath?.endsWith(rolloutPath.split('/').pop()!) === true,
      )).toBe(true)
      expect(
        (pastedOnly as unknown as { activeRolloutPath: string | null })
          .activeRolloutPath,
      ).toBeNull()
    } finally {
      await Promise.all([pastedOnly.stop(), submitted.stop()])
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('keeps a clean fresh lease when its accepted diagnostic observer throws', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-accepted-diagnostic-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('modern-0149-agents-first')
    const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded fresh fixture has no thread id')
    }
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    const provider = providerFramePty()
    const headless = new CodexHeadless({
      pty: provider.pty,
      cwd: '/recorded/worktree',
      promptInputProfile: recordedPromptInputProfile(),
    })
    headless.on('rollout-diagnostic', diagnostic => {
      if (diagnostic.type === 'fresh-rollout-ownership-decision' &&
        diagnostic.decision === 'accept' && diagnostic.tailStarted) {
        throw new Error('recorded accepted-decision observer failure')
      }
    })
    let reopened: CodexResumeRolloutPreparation | null = null

    try {
      await headless.start()
      await waitForComposerFrame(
        headless,
        provider,
        fixture.ownership.localPromptToken,
      )
      headless.write('\r')
      writeFileSync(rolloutPath, rolloutText(fixture))
      expect(await waitFor(() =>
        (headless as unknown as { activeRolloutPath: string | null })
          .activeRolloutPath?.endsWith(rolloutPath.split('/').pop()!) === true,
      )).toBe(true)
      await headless.stop()
      // WHY the physical tail opened before the diagnostic threw. A clean stop
      // must therefore leave an exact-id reopenable lease; observational UI
      // code cannot retroactively convert successful I/O into uncertainty.
      reopened = await prepareRecordedResume({
        codexHome,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      // Successful factory return is the public proof that exact X reopened.
      // Reaching into initialPath would make this regression test depend on the
      // very capability internals the opacity boundary deliberately removes.
      expect(reopened).toBeDefined()
    } finally {
      await reopened?.dispose(true)
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  describe('recorded resume rollout capability boundary', () => {
    it('keeps ownership state out of enumerable and serialized surfaces', async () => {
      const recorded = await prepareRecordedCapabilityFixture()

      try {
        const serialized = JSON.stringify(recorded.preparation)
        const sensitiveValues = [
          recorded.codexHome,
          recorded.cwd,
          recorded.generationId,
          recorded.rolloutPath,
          recorded.threadId,
        ]

        // WHY TypeScript `private` is not a privacy boundary in emitted JS. A
        // preparation is routinely stored across the pre-spawn rollback window,
        // where generic loggers, object spread, and diagnostic serialization can
        // inspect it. The capability may expose explicit behavior (`dispose`),
        // but none of the recorded path/identity/lineage state may be an own key
        // or silently become part of a crash bundle.
        expect({
          ownKeys: Reflect.ownKeys(recorded.preparation).map(String),
          serialized,
          serializedSensitiveValues: sensitiveValues.filter(value =>
            serialized.includes(value),
          ),
        }).toEqual({
          ownKeys: [],
          serialized: '{}',
          serializedSensitiveValues: [],
        })
      } finally {
        await recorded.preparation.dispose(true)
      }
    })

    it('does not expose an internal constructor through the public handle', async () => {
      const recorded = await prepareRecordedCapabilityFixture()

      try {
        const runtimeConstructor = Reflect.get(
          recorded.preparation,
          'constructor',
        )

        // WHY an unexported class plus a construction token was still a wider
        // surface than necessary: a genuine class instance reveals its
        // constructor through Object.prototype. The public rollback capability
        // is now null-rooted, so reflection cannot even reach the internal
        // controller constructor; prototype-copy forgeries remain covered by
        // the issuer/WeakMap test below.
        expect(runtimeConstructor).toBeUndefined()
      } finally {
        await recorded.preparation.dispose(true)
      }
    })

    it('rejects plain-object and genuine-prototype forgeries before startup', async () => {
      const recorded = await prepareRecordedCapabilityFixture()
      const accepted: CodexHeadless[] = []
      const duckForgery = {
        ownerId: 'forged-recorded-owner',
        sessionsDir: join(recorded.codexHome, 'sessions'),
        initialPath: recorded.rolloutPath,
        initialGenerationId: recorded.generationId,
        resumeThreadId: recorded.threadId,
        cwd: recorded.cwd,
        dispose: async () => undefined,
      } as unknown as CodexResumeRolloutPreparation
      const prototypeForgery = Object.create(
        Object.getPrototypeOf(recorded.preparation) as object,
      ) as CodexResumeRolloutPreparation
      const outcomes: string[] = []

      try {
        for (const forgery of [duckForgery, prototypeForgery]) {
          try {
            accepted.push(new CodexHeadless({
              pty: inertPty(),
              cwd: recorded.cwd,
              resumeThreadId: recorded.threadId,
              resumeRolloutPreparation: forgery,
            }))
            outcomes.push('accepted')
          } catch {
            outcomes.push('rejected')
          }
        }

        // WHY `instanceof` alone is forgeable with Object.create, while shape
        // checks accept the duck object. Rejection must happen in the constructor
        // before HeadlessTerminal allocates resources; waiting until start would
        // let an untrusted object participate in rollback and lease retirement.
        expect(outcomes).toEqual(['rejected', 'rejected'])
      } finally {
        await Promise.all(accepted.map(headless => headless.stop()))
        await recorded.preparation.dispose(true)
      }
    })

    it('preserves parent rollback by reopening after factory capability disposal', async () => {
      const recorded = await prepareRecordedCapabilityFixture()
      let replacement: CodexResumeRolloutPreparation | null = null

      try {
        // WHY opacity cannot make cleanup package-private. The parent owns this
        // exact reservation until PTY construction and event wiring hand it to
        // CodexHeadless, so public idempotent disposal is the one operation the
        // capability must retain even after every state field becomes hidden.
        await recorded.preparation.dispose(true)
        replacement = await prepareRecordedResume({
          codexHome: recorded.codexHome,
          cwd: recorded.cwd,
          resumeThreadId: recorded.threadId,
        })
        expect(replacement).toBeDefined()
      } finally {
        await replacement?.dispose(true)
        await recorded.preparation.dispose(true)
      }
    })
  })

  it('routes the recorded subagent through exact identity before tailing', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-exact-owner-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    writeFileSync(rolloutPath, rolloutText(fixture))
    const dataListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(
      event: { exitCode: number; signal?: number },
    ) => void>()
    const pty = {
      write: () => undefined,
      resize: () => undefined,
      onData: (listener: (data: string) => void) => {
        dataListeners.add(listener)
        return { dispose: () => dataListeners.delete(listener) }
      },
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListeners.add(listener)
        return { dispose: () => exitListeners.delete(listener) }
      },
    } as unknown as IPty
    try {
      const startAndStop = async (): Promise<void> => {
        const preparation = await prepareRecordedResume({
          codexHome,
          cwd: '/recorded/worktree',
          resumeThreadId: threadId,
        })
        const headless = new CodexHeadless({
          pty,
          cwd: '/recorded/worktree',
          resumeThreadId: threadId,
          resumeRolloutPreparation: preparation,
        })
        const seenPaths: string[] = []
        headless.on('rollout-entry', (_line, filePath) => {
          seenPaths.push(filePath)
        })
        try {
          await headless.start()
          expect(await waitFor(() => seenPaths.includes(rolloutPath))).toBe(true)
        } finally {
          await headless.stop()
        }
      }

      await startAndStop()
      // WHY this happens in one Node process: the regression was a permanent
      // process-global lease, so a new test process would hide the failure.
      await startAndStop()
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('rejects replacement after exact rollout preparation verified inode A', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-exact-generation-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    writeFileSync(rolloutPath, rolloutText(fixture))
    const inodeA = statSync(rolloutPath)
    const generationA = `${inodeA.dev}:${inodeA.ino}`
    const preparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })

    // WHY the generation is intentionally not readable from the public
    // rollback handle. The recorded behavioral proof is stronger: preparation
    // observes inode A, the test replaces only that inode, and start must reject
    // B. Reading an internal getter here would make privacy itself a test API.
    renameSync(rolloutPath, `${rolloutPath}.inode-a`)
    writeFileSync(rolloutPath, rolloutText(fixture))
    const inodeB = statSync(rolloutPath)
    expect(`${inodeB.dev}:${inodeB.ino}`).not.toBe(generationA)
    const headless = new CodexHeadless({
      pty: inertPty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: preparation,
    })

    try {
      // WHY requested id == filename id == metadata id proved inode A only.
      // Reopening the pathname after replacement must not transfer that exact
      // proof to B merely because B copied the same public identifiers.
      await expect(headless.start()).rejects.toThrow(/generation/i)
    } finally {
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('does not emit replacement B from a buffered lineage lease for A', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-lineage-generation-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMetaIndex = fixture.lines.findIndex(line => line.type === 'session_meta')
    const sessionMeta = fixture.lines[sessionMetaIndex]
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const forkThreadId = '00000000-0000-4000-8000-000000000077'
    const forkLines = structuredClone(fixture.lines)
    ;(forkLines[sessionMetaIndex]!.payload as { id: string }).id = forkThreadId
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const initialPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    const forkPath = join(day, `rollout-recorded-${forkThreadId}.jsonl`)
    writeFileSync(initialPath, rolloutText(fixture))
    const preparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const monitor = await acquireFreshRolloutCoordinator({
      sessionsRoot: join(codexHome, 'sessions'),
      normalizeCwd: normalizeRolloutOwnershipPath,
      normalizePath: normalizeRolloutOwnershipPath,
      onError: () => undefined,
    })
    let headless: CodexHeadless | null = null

    try {
      writeFileSync(
        forkPath,
        `${forkLines.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      // WHY looking into `preparation.pendingLeases` made the privacy test
      // self-defeating: it required the supposedly opaque capability to retain
      // enumerable mutable internals. The second coordinator lease is the public
      // ownership fact we need—X was reserved exactly and Y was lineage-leased—
      // and proves the callback is buffered before CodexHeadless consumes it.
      expect(await waitFor(() =>
        monitor.coordinator.inspect().leasedPathCount === 2,
      5000)).toBe(true)

      renameSync(forkPath, `${forkPath}.inode-a`)
      const replacementSentinel = 'replacement-generation-must-not-commit'
      writeFileSync(
        forkPath,
        `${forkLines.map(line => JSON.stringify(line)).join('\n')}\n` +
          `${JSON.stringify({
            timestamp: '2026-08-25T00:00:00.000Z',
            type: 'event_msg',
            payload: { type: 'agent_message', message: replacementSentinel },
          })}\n`,
      )
      const seenMessages: string[] = []
      headless = new CodexHeadless({
        pty: inertPty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: preparation,
      })
      headless.on('rollout-entry', line => {
        const message = (line.payload as { message?: unknown } | undefined)?.message
        if (typeof message === 'string') seenMessages.push(message)
      })
      await headless.start()
      await new Promise(resolve => setTimeout(resolve, 500))
      // WHY the lineage proof was buffered before CodexHeadless existed. That
      // makes the A->B replacement deterministic at the exact handoff where a
      // pathname-only lease currently loses the watcher's verified generation.
      expect(seenMessages).not.toContain(replacementSentinel)
    } finally {
      await headless?.stop()
      await preparation.dispose(true)
      await monitor.release()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  }, 15_000)

  it('releases the resume watcher when its bounded window expires', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-resume-window-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const rolloutPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    writeFileSync(rolloutPath, rolloutText(fixture))
    const makePty = (): IPty => ({
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }) as unknown as IPty
    const ctor = CodexHeadless as unknown as {
      RESUME_FORK_WATCH_MS: number
      new(options: {
        pty: IPty
        cwd: string
        resumeThreadId: string
        resumeRolloutPreparation: CodexResumeRolloutPreparation
      }): CodexHeadless
    }
    const previousWindow = ctor.RESUME_FORK_WATCH_MS
    ctor.RESUME_FORK_WATCH_MS = 25
    const symbol = Symbol.for(
      'codex-headless.fresh-rollout-ownership-coordinator-registry',
    )
    const registryBefore = (globalThis as typeof globalThis & {
      [symbol]?: { roots: Map<string, unknown> }
    })[symbol]
    const keysBefore = new Set(registryBefore?.roots.keys() ?? [])
    const preparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const headless = new ctor({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: preparation,
    })
    const seenPaths: string[] = []
    headless.on('rollout-entry', (_line, filePath) => seenPaths.push(filePath))

    try {
      await headless.start()
      expect(await waitFor(() => seenPaths.includes(rolloutPath))).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 75))
      const registry = (globalThis as typeof globalThis & {
        [symbol]?: {
          roots: Map<string, { referenceCount: number; watcher: unknown }>
        }
      })[symbol]
      const rootKey = [...(registry?.roots.keys() ?? [])]
        .find(key => !keysBefore.has(key))
      if (!rootKey) throw new Error('resume root was not registered')
      const rootEntry = registry!.roots.get(rootKey)

      // WHY the exact JsonlTailer and the candidate watcher have different
      // lifetimes. The former remains the committed channel for X; the latter
      // exists only for the bounded possibility of reconstructed Y.
      expect(rootEntry).toMatchObject({ referenceCount: 0, watcher: null })
      const beforeAppend = seenPaths.length
      appendFileSync(rolloutPath, `${JSON.stringify(fixture.lines.at(-1))}\n`)
      expect(await waitFor(() => seenPaths.length > beforeAppend)).toBe(true)
    } finally {
      ctor.RESUME_FORK_WATCH_MS = previousWindow
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('reopens the original exact path after a recorded lineage switch closes it', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-lineage-switch-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const fixture = loadFixture('subagent-0149-exact-attachment')
    const sessionMetaIndex = fixture.lines.findIndex(line => line.type === 'session_meta')
    const sessionMeta = fixture.lines[sessionMetaIndex]
    const threadId = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
    if (typeof threadId !== 'string') {
      throw new Error('recorded exact-id fixture has no thread id')
    }
    const forkThreadId = '00000000-0000-4000-8000-000000000044'
    const forkLines = structuredClone(fixture.lines)
    ;(forkLines[sessionMetaIndex]!.payload as { id: string }).id = forkThreadId
    const day = join(codexHome, 'sessions', '2026', '08', '24')
    mkdirSync(day, { recursive: true })
    const initialPath = join(day, `rollout-recorded-${threadId}.jsonl`)
    const forkPath = join(day, `rollout-recorded-${forkThreadId}.jsonl`)
    writeFileSync(initialPath, rolloutText(fixture))

    const makePty = (): IPty => ({
      write: () => undefined,
      resize: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }) as unknown as IPty
    const resumedPreparation = await prepareRecordedResume({
      codexHome,
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
    })
    const resumed = new CodexHeadless({
      pty: makePty(),
      cwd: '/recorded/worktree',
      resumeThreadId: threadId,
      resumeRolloutPreparation: resumedPreparation,
    })
    const forkFiles: string[] = []
    resumed.on('rollout-entry', (_line, filePath) => {
      // normalizeCwd resolves macOS /var through /private/var before the shared
      // coordinator publishes a lease; the UUID-bearing basename is the exact
      // identity fact this assertion needs.
      if (filePath.endsWith(`${forkThreadId}.jsonl`)) forkFiles.push(filePath)
    })
    let reopened: CodexHeadless | null = null
    const reopenedPaths: string[] = []

    try {
      await resumed.start()
      writeFileSync(
        forkPath,
        `${forkLines.map(line => JSON.stringify(line)).join('\n')}\n`,
      )
      expect(await waitFor(() => forkFiles.length > 0, 5000)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 100))

      // WHY A remains live on Y while B opens X: a lease belongs to a physical
      // tail, not forever to every path a logical resumed session once used.
      // Reopening X must wait for X's close, but not for A's eventual stop.
      const reopenedPreparation = await prepareRecordedResume({
        codexHome,
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
      })
      reopened = new CodexHeadless({
        pty: makePty(),
        cwd: '/recorded/worktree',
        resumeThreadId: threadId,
        resumeRolloutPreparation: reopenedPreparation,
      })
      reopened.on('rollout-entry', (_line, filePath) => {
        reopenedPaths.push(filePath)
      })
      await expect(reopened.start()).resolves.toMatchObject({
        sessionsDir: join(codexHome, 'sessions'),
      })
      // WHY the recorded 600-line rollout is intentionally not flattened for
      // this assertion: JsonlTailer bootstraps the last 200 lines, while the
      // session_meta lives on line one. Receiving entries from X proves that X
      // was reopened without teaching the test an impossible metadata promise.
      expect(await waitFor(() => reopenedPaths.includes(initialPath))).toBe(true)
    } finally {
      await reopened?.stop()
      await resumed.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  }, 15_000)
})
