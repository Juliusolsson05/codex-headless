import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { StableTerminalFrame } from '../terminal/HeadlessTerminal.js'
import { FreshRolloutOwnershipCoordinator } from './FreshRolloutOwnershipCoordinator.js'
import {
  acquireFreshRolloutCoordinator,
  type StartingFreshRolloutCoordinatorAcquisition,
} from './FreshRolloutOwnershipCoordinatorRegistry.js'
import { classifyCodex01491ComposerSurface } from './prompt-input/Codex01491ComposerSurface.js'

const REGISTRY_SYMBOL = Symbol.for(
  'codex-headless.fresh-rollout-ownership-coordinator-registry',
)

type RecordedReview = {
  heads: { codexHeadless: string }
  confirmedFindings: string[]
}

type RecordedOwnershipFixture = {
  lines: Array<Record<string, unknown>>
}

type RecordedPromptCorpus = {
  cases: Array<{
    id: string
    durableUserText: string | null
    resizeTrace?: { narrow: { cols: number } }
  }>
}

type ReflectedProjection = {
  reachableMap: boolean
  reachableSet: boolean
  reachableBackingCoordinator: boolean
}

const review = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../testing/fixtures/twelfth-gate/review-38d7bd5a-recorded.json',
  import.meta.url,
)), 'utf8')) as RecordedReview
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../testing/fixtures/rollout-ownership/subagent-0149-exact-attachment.json',
  import.meta.url,
)), 'utf8')) as RecordedOwnershipFixture
const promptCorpus = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../testing/fixtures/prompt-input/codex-01491-recorded.json',
  import.meta.url,
)), 'utf8')) as RecordedPromptCorpus
const temporaryDirectories: string[] = []

function fixtureThreadId(): string {
  const sessionMeta = fixture.lines.find(line => line.type === 'session_meta')
  const id = (sessionMeta?.payload as { id?: unknown } | undefined)?.id
  if (typeof id !== 'string') throw new Error('recorded exact fixture has no id')
  return id
}

function reflectOperationResult(value: object): ReflectedProjection {
  const visited = new WeakSet<object>()
  const projection: ReflectedProjection = {
    reachableMap: false,
    reachableSet: false,
    reachableBackingCoordinator: false,
  }
  const visit = (candidate: unknown, depth: number): void => {
    if ((typeof candidate !== 'object' && typeof candidate !== 'function') ||
      candidate === null || depth > 8 || visited.has(candidate)) return
    visited.add(candidate)
    projection.reachableMap ||= candidate instanceof Map
    projection.reachableSet ||= candidate instanceof Set
    projection.reachableBackingCoordinator ||=
      candidate instanceof FreshRolloutOwnershipCoordinator
    if (candidate instanceof Map) {
      for (const [key, entry] of candidate) {
        visit(key, depth + 1)
        visit(entry, depth + 1)
      }
    } else if (candidate instanceof Set) {
      for (const entry of candidate) visit(entry, depth + 1)
    }
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key)
      if (descriptor && 'value' in descriptor) visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
  return projection
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('twelfth-gate recorded authority boundaries', () => {
  it('returns only an opaque coordinator facade from the process-global begin operation', async () => {
    expect(review.heads.codexHeadless).toBe(
      '6f6149b417ee68c5404046e505cf879ac6d8ff48',
    )
    expect(review.confirmedFindings).toContain(
      'global-bridge-returns-reflectable-coordinator',
    )
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'codex-twelfth-bridge-'))
    temporaryDirectories.push(sessionsRoot)
    const options = {
      sessionsRoot,
      normalizeCwd: (value: string) => value,
      normalizePath: (value: string) => value,
      onError: () => undefined,
    }
    const publicControl = await acquireFreshRolloutCoordinator(options)
    const bridge = (globalThis as typeof globalThis & {
      [REGISTRY_SYMBOL]?: {
        begin(value: typeof options): StartingFreshRolloutCoordinatorAcquisition
      }
    })[REGISTRY_SYMBOL]
    if (!bridge) throw new Error('twelfth-gate global bridge is missing')
    const direct = bridge.begin(options)
    await direct.ready
    const participantId = fixtureThreadId()
    const participant = direct.coordinator.registerParticipant({
      participantId,
      cwd: '/recorded/worktree',
      onLease: () => undefined,
    })
    const day = join(sessionsRoot, '2026', '08', '26')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, `rollout-recorded-${participantId}.jsonl`),
      `${fixture.lines.map(line => JSON.stringify(line)).join('\n')}\n`,
    )

    try {
      // WHY CH-11 walked only the bridge's own properties. A same-process
      // caller can invoke those functions, so the returned value is part of
      // the global authority surface too. The method facade may expose behavior
      // required by duplicate package copies, but never the backing class whose
      // ordinary TypeScript-private Maps can be enumerated and cleared.
      expect(reflectOperationResult(direct)).toEqual({
        reachableMap: false,
        reachableSet: false,
        reachableBackingCoordinator: false,
      })
      expect(direct.coordinator.inspect().activeParticipantCount).toBe(1)
      expect(publicControl.coordinator).toBe(direct.coordinator)
    } finally {
      participant.unregister()
      await direct.release()
      await publicControl.release()
    }
  })

  it('treats a physically full double-width composer row as ambiguous', () => {
    expect(review.confirmedFindings).toContain(
      'wide-character-wrap-misclassified',
    )
    const cjkCase = promptCorpus.cases.find(value =>
      value.id === 'mixed-cjk-ctrl-w')
    const narrowCase = promptCorpus.cases.find(value =>
      value.id === 'narrow-soft-wrap-resize-redraw')
    const recordedCjk = cjkCase?.durableUserText?.match(/[\p{Script=Han}]/gu)
    const cols = narrowCase?.resizeTrace?.narrow.cols
    if (!recordedCjk?.length || typeof cols !== 'number') {
      throw new Error('recorded CJK or narrow-wrap fixture is missing')
    }

    const contentCells = cols - 6
    const glyphs = Array.from(
      { length: contentCells / 2 },
      (_, index) => recordedCjk[index % recordedCjk.length]!,
    )
    const physicalComposerCells = ['›', ' ']
    for (const glyph of glyphs) {
      physicalComposerCells.push(glyph, '')
    }
    while (physicalComposerCells.length < cols) physicalComposerCells.push('')
    const continuation = '  X'
    const frame: StableTerminalFrame = {
      generation: 34,
      layoutEpoch: 0,
      providerLayoutEpoch: 0,
      cols,
      cursor: { x: 3, y: 1 },
      rows: [
        {
          text: `› ${glyphs.join('')}`,
          cells: physicalComposerCells,
          isWrapped: false,
        },
        {
          text: continuation,
          cells: [...continuation],
          isWrapped: false,
        },
        { text: '', cells: [], isWrapped: false },
        {
          text: '  gpt-5.6-sol low · <recorded-workspace>',
          cells: [...'  gpt-5.6-sol low · <recorded-workspace>'],
          isWrapped: false,
        },
      ],
    }

    // WHY the glyphs come from the recorded mixed-CJK interaction and the
    // columns/continuation shape come from the recorded narrow soft-wrap case.
    // The empty cells after each Han glyph are xterm's real wide-character
    // continuation columns. Counting the row's JavaScript code points makes
    // this look short and turns the physical continuation into a logical LF.
    expect(classifyCodex01491ComposerSurface(frame)).toEqual({ kind: 'unknown' })
  })
})
