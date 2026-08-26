import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { StableTerminalFrame } from '../terminal/HeadlessTerminal.js'
import {
  inferCodexTabBehavior,
  SubmittedPromptInput,
  type SubmittedPromptInputContext,
} from './SubmittedPromptInput.js'
import {
  prepareCodex01491PromptInputProfile,
} from './prompt-input/CodexPromptInputProfile.js'
import {
  classifyCodex01491ComposerSurface,
} from './prompt-input/Codex01491ComposerSurface.js'
import { PromptInputEvidence } from './prompt-input/PromptInputEvidence.js'

type RecordedConfigClass =
  | 'recorded-default-01491'
  | 'explicit-cli-override'
  | 'lower-layer-config'
  | 'lower-layer-plus-issued-cli-override'

type RecordedStableFrame = {
  generation: number
  cols: number
  cursor: { x: number; y: number }
  rows: Array<{
    viewportRow: number
    text: string
    isWrapped: boolean
  }>
}

type RecordedPromptInputCase = {
  id: string
  sourceLabel: string
  rawPtySha256: string
  rolloutSha256: string
  rawRequestSha256: string | null
  configClass: RecordedConfigClass
  lowerLayerConfig?: string[]
  configOverrides: string[]
  terminal?: { cols: number; rows: number }
  inputChunks: string[]
  expectedSubmission: boolean
  durableUserText: string | null
  requestUserText: string | null
  screenBeforeFinalWrite?: string[]
  nonComposerWrites?: string[]
  modal?: string[]
  popup?: string[]
  activeTurnFooter?: string[]
  beforeTypingFrame?: RecordedStableFrame
  resizeTrace?: {
    requested: { cols: number; rows: number }
    rawChunkCountBeforeResize: number
    rawChunkCountBeforeProviderRedraw: number
    rawChunkCountAfterProviderRedraw: number
    preRedrawGenerationUnchanged: boolean
    postRedrawGenerationAdvanced: boolean
    narrow: RecordedStableFrame
    beforeProviderRedraw: RecordedStableFrame
    afterProviderRedraw: RecordedStableFrame
  }
  editAcknowledgementTrace?: {
    baseDraft: string
    edit: string
    setupDurableUserText: string
    setupRequestUserText: string
    rawChunkCountBeforeEdit: number
    rawChunkCountAtUnchangedRedraw: number
    schedulingControl: string
    beforeEdit: RecordedStableFrame
    unchangedAfterEdit: RecordedStableFrame
    paintedEdit: RecordedStableFrame
    unchangedGenerationAdvanced: boolean
    unchangedComposerRevision: boolean
    paintedGenerationAdvanced: boolean
  }
  requestCountDelta?: number
  startupOutcome?: 'composer-ready' | 'rejected-before-composer'
  exitOutcome?: { exitCode: number; signal?: number } | null
  startupScreen?: string[]
}

type RecordedPromptInputCorpus = {
  schemaVersion: number
  sanitizerVersion: number
  provider: {
    cliVersion: string
    binarySha256: string
    upstreamTag: string
  }
  terminal: {
    cols: number
    rows: number
  }
  source: {
    kind: string
    fixtureSseSha256: string
  }
  cases: RecordedPromptInputCase[]
}

type RecordedInputContext = SubmittedPromptInputContext & {
  /**
   * Full provider-rendered rows immediately before this write, when Stage 25
   * retained such a boundary. This is deliberately not a caller-supplied
   * surface label: Stage 27 must prove composer/modal/footer ownership from the
   * recorded structure instead of allowing a caller to assert it by fiat.
   */
  screenBeforeWrite?: string
  /**
   * The effective input-profile evidence that produced this recording. The
   * current production context does not expose this field yet, hence the
   * test-only call-signature cast below. Keeping the raw overrides here makes
   * the red contract impossible to satisfy by silently assuming defaults for
   * an explicitly remapped or Vim-enabled session.
   */
  inputProfile: unknown
}

type RecordedConsumer = (
  data: string,
  context: RecordedInputContext,
) => string[]

const fixturePath = fileURLToPath(new URL(
  '../../testing/fixtures/prompt-input/codex-01491-recorded.json',
  import.meta.url,
))
const catalogPath = fileURLToPath(new URL(
  '../../testing/fixtures/prompt-input/catalog.md',
  import.meta.url,
))
const configSourcePath = fileURLToPath(new URL(
  '../../testing/fixtures/prompt-input/codex-01491-config-source.json',
  import.meta.url,
))
const appServerFixturePath = fileURLToPath(new URL(
  '../../testing/fixtures/prompt-input/codex-01491-app-server-fixture.mjs',
  import.meta.url,
))
const corpus = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as RecordedPromptInputCorpus
const catalog = readFileSync(catalogPath, 'utf8')
const configSource = JSON.parse(readFileSync(configSourcePath, 'utf8')) as {
  schemaVersion: number
  upstreamTag: string
  upstreamCommitSha: string
  recordedCases: Record<string, string>
  files: Array<{
    path: string
    sha256: string
    coordinates: Array<{ startLine: number; endLine: number; claim: string }>
  }>
}
const recordedProfilePreparation = await prepareRecordedProfile()
if (!recordedProfilePreparation.ok) {
  throw new Error('recorded config/read profile fixture was refused')
}
const recordedIssuedProfile = recordedProfilePreparation.profile

const recordedCaseIds = [
  'trust-action-then-submit',
  'combining-grapheme-backspace',
  'mixed-cjk-ctrl-w',
  'repeated-line-boundaries',
  'remapped-kill-line-start',
  'vim-normal-default',
  'unbound-submit-enter',
  'modal-ctrl-c-preserves-draft',
  'tab-footer-spoof-skill-popup',
  'active-footer-tab-queue',
  'narrow-soft-wrap-resize-redraw',
  'unchanged-redraw-after-edit',
  'ordinary-modal-sentinel-draft',
  'ordinary-vim-sentinel-cwd',
  'lower-layer-keymap-valid-control',
  'lower-layer-keymap-issued-profile-conflict',
] as const

const priorReplayCaseIds = new Set(recordedCaseIds.slice(0, 10))

const unicodeBoundaryCases = new Set([
  'combining-grapheme-backspace',
  'mixed-cjk-ctrl-w',
])

const casesById = corpus.cases.map(recordedCase => [
  recordedCase.id,
  recordedCase,
] as const)
const priorReplayCasesById = casesById.filter(([caseId]) =>
  priorReplayCaseIds.has(caseId as typeof recordedCaseIds[number]),
)

function contextFor(
  recordedCase: RecordedPromptInputCase,
  screenRows?: string[],
): RecordedInputContext {
  const screenBeforeWrite = screenRows?.join('\n')
  return {
    // WHY the old helper must remain in this replay until Stage 27 replaces its
    // whole-screen guess. Feeding the exact recorded rows makes the popup-spoof
    // case fail for the real reason: transcript prose currently masquerades as
    // the active bottom footer, while the genuine queue footer remains green.
    tabBehavior: inferCodexTabBehavior(screenBeforeWrite ?? ''),
    screenBeforeWrite,
    inputProfile: recordedCase.configClass === 'recorded-default-01491'
      ? recordedIssuedProfile
      : {
          cliVersion: corpus.provider.cliVersion,
          upstreamTag: corpus.provider.upstreamTag,
          configClass: recordedCase.configClass,
          configOverrides: [...recordedCase.configOverrides],
        },
  }
}

function recordedScreenBeforeChunk(
  recordedCase: RecordedPromptInputCase,
  chunkIndex: number,
): string[] | undefined {
  const finalChunkIndex = recordedCase.inputChunks.length - 1
  if (chunkIndex === finalChunkIndex) return recordedCase.screenBeforeFinalWrite

  // WHY these are the only retained intermediate frame boundaries in the
  // sanitized corpus. The Stage 25 recorder captured history search after
  // Ctrl+R, so its popup is the pre-Ctrl+C surface. It captured the active-turn
  // footer before typing the queued draft. Inventing frames for every ordinary
  // character would turn provider recordings back into imagined fixtures.
  if (recordedCase.id === 'modal-ctrl-c-preserves-draft' && chunkIndex === 2) {
    return recordedCase.popup
  }
  if (recordedCase.id === 'active-footer-tab-queue' && chunkIndex === 0) {
    return recordedCase.activeTurnFooter
  }
  return undefined
}

function replayRecordedInput(recordedCase: RecordedPromptInputCase): string[] {
  const input = new SubmittedPromptInput()
  // WHY Stage 26 intentionally describes the context Stage 27 must consume
  // before production declares it. Casting only the bound test call lets the
  // pre-repair implementation compile and fail behaviorally; weakening the
  // fixture or editing production types merely to make a red test compile would
  // collapse the required tests-before-implementation boundary.
  const consume = input.consume.bind(input) as RecordedConsumer
  const submitted: string[] = []

  for (const modalWrite of recordedCase.nonComposerWrites ?? []) {
    submitted.push(...consume(
      modalWrite,
      contextFor(recordedCase, recordedCase.modal),
    ))
  }

  recordedCase.inputChunks.forEach((chunk, chunkIndex) => {
    submitted.push(...consume(
      chunk,
      contextFor(
        recordedCase,
        recordedScreenBeforeChunk(recordedCase, chunkIndex),
      ),
    ))
  })

  return submitted
}

function caseById(id: typeof recordedCaseIds[number]): RecordedPromptInputCase {
  const recordedCase = corpus.cases.find(value => value.id === id)
  if (!recordedCase) throw new Error(`missing recorded case ${id}`)
  return recordedCase
}

function stableFrame(
  recorded: RecordedStableFrame,
  layout: { layoutEpoch: number; providerLayoutEpoch: number } = {
    layoutEpoch: 0,
    providerLayoutEpoch: 0,
  },
): StableTerminalFrame {
  return {
    generation: recorded.generation,
    ...layout,
    cols: recorded.cols,
    cursor: recorded.cursor,
    rows: recorded.rows.map(row => ({
      text: row.text,
      cells: [...row.text],
      isWrapped: row.isWrapped,
    })),
  }
}

function frameFromRows(rows: readonly string[], generation = 1): StableTerminalFrame {
  return {
    generation,
    layoutEpoch: 0,
    providerLayoutEpoch: 0,
    cols: Math.max(140, ...rows.map(row => [...row].length)),
    cursor: { x: 0, y: 0 },
    rows: rows.map(text => ({ text, cells: [...text], isWrapped: false })),
  }
}

function issuedEvidence(): PromptInputEvidence {
  return new PromptInputEvidence(recordedIssuedProfile)
}

function prepareRecordedProfile(mode = 'recorded-safe') {
  return prepareCodex01491PromptInputProfile({
    binary: process.execPath,
    cwd: process.cwd(),
    baseArgs: [appServerFixturePath],
    env: {
      ...process.env,
      CODEX_PROFILE_FIXTURE_MODE: mode,
    },
  })
}

describe('recorded Codex 0.149.1 prompt-input contract', () => {
  it('executes the complete sanitized catalog with pinned provenance', () => {
    const fixtureIds = corpus.cases.map(recordedCase => recordedCase.id)
    const catalogIds = [...catalog.matchAll(/^\| `([^`]+)` \|/gm)]
      .map(match => match[1])
      .filter(id => id !== 'capability-6244eac-recorded')

    // WHY fixture files and catalog prose can drift independently. This turns
    // the inventory into an executable boundary: adding, omitting, or merely
    // documenting a case cannot inflate coverage without a replayed assertion.
    expect(fixtureIds).toEqual(recordedCaseIds)
    expect(catalogIds).toEqual(recordedCaseIds)
    expect(corpus).toMatchObject({
      schemaVersion: 1,
      sanitizerVersion: 1,
      provider: {
        cliVersion: 'codex-cli 0.149.1',
        binarySha256: 'f0d8762236594359b60cfbe17f4c7e945a3ce8d1c91e74778838c968d250fb6c',
        upstreamTag: 'rust-v0.149.1',
      },
      terminal: { cols: 140, rows: 42 },
      source: {
        kind: 'real-codex-tui-local-canned-responses',
        fixtureSseSha256: '66658b7a1d9b0e3b234de932f552b946b8a005520888f24e001a024fb9a29e5b',
      },
    })
  })

  it.each(casesById)('retains independently checkable provenance for %s', (
    _caseId,
    recordedCase,
  ) => {
    // WHY prompt expectations are trustworthy only while they remain tied to
    // the private raw PTY, rollout, and request streams that produced them. The
    // hashes permit local revalidation without committing those identity-rich
    // sources, and the two independent provider outputs must agree exactly.
    expect(recordedCase.sourceLabel).toMatch(/^recorded-source-[0-9a-f]{16}$/)
    expect(recordedCase.rawPtySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(recordedCase.rolloutSha256).toMatch(/^[0-9a-f]{64}$/)
    if (recordedCase.rawRequestSha256 === null) {
      expect(recordedCase.expectedSubmission).toBe(false)
    } else {
      expect(recordedCase.rawRequestSha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(recordedCase.requestUserText).toBe(recordedCase.durableUserText)
    expect(recordedCase.durableUserText === null)
      .toBe(!recordedCase.expectedSubmission)
    const lowerLayerConfig = recordedCase.lowerLayerConfig ?? []
    if (recordedCase.configClass === 'recorded-default-01491') {
      expect(recordedCase.configOverrides).toEqual([])
      expect(lowerLayerConfig).toEqual([])
    } else if (recordedCase.configClass === 'explicit-cli-override') {
      expect(recordedCase.configOverrides.length).toBeGreaterThan(0)
      expect(lowerLayerConfig).toEqual([])
    } else {
      expect(lowerLayerConfig.length).toBeGreaterThan(0)
    }
  })

  it('pins the exact rust-v0.149.1 config precedence and conflict sources', () => {
    expect(configSource).toMatchObject({
      schemaVersion: 1,
      upstreamTag: 'rust-v0.149.1',
      upstreamCommitSha: 'ff29a44391deccde0aba0f8390337d7f3c319ea4',
      recordedCases: {
        validLowerLayer: 'lower-layer-keymap-valid-control',
        issuedOverridesConflict: 'lower-layer-keymap-issued-profile-conflict',
      },
    })
    expect(configSource.files.map(file => [file.path, file.sha256])).toEqual([
      ['codex-rs/config/src/config_layer_source.rs', '6816bf7bd44b1f2799aae30331b77a7e8231ccacdc4cd3d44d6485f9e1118364'],
      ['codex-rs/config/src/loader/mod.rs', '53d66dce1cd81de3d86610ff2a75aed7f9049609cbefcd3694590c0acfc7c404'],
      ['codex-rs/config/src/overrides.rs', 'd10b2c943a709d28395cde201f1b084da4d303afe4ff698f91f59f518c1a9e13'],
      ['codex-rs/config/src/merge.rs', 'a7628f0da10f7f7e770fce5160ecbf1ca846b7d9db4b8ed92c6c9cce22c7fb11'],
      ['codex-rs/tui/src/keymap.rs', '709feecb708a16b66af8685f0028191efc23b6fac8f87db6a8d45df2440ff604'],
    ])
    expect(configSource.files.every(file => file.coordinates.length > 0)).toBe(true)
  })

  it.each(priorReplayCasesById)('matches or safely declines recorded input evidence for %s', (
    _caseId,
    recordedCase,
  ) => {
    const submitted = replayRecordedInput(recordedCase)

    if (recordedCase.configClass === 'explicit-cli-override' ||
      !recordedCase.expectedSubmission) {
      // WHY an actual provider submission does not entitle an unproven input
      // profile to reconstruct it. A remap, Vim mode, unbound Enter, or popup
      // Tab must produce no ownership evidence; a plausible wrong prompt can
      // authorize a same-CWD sibling rollout and is worse than a safe miss.
      expect(submitted).toEqual([])
      return
    }

    const exact = [recordedCase.durableUserText]
    if (unicodeBoundaryCases.has(recordedCase.id)) {
      // WHY Stage 27 may either implement the exact recorded Unicode boundary
      // or fail closed until a version-pinned segmenter exists. It may not emit
      // the code-point/ASCII approximation that the provider never submitted.
      expect([[], exact]).toContainEqual(submitted)
      return
    }

    // WHY default ASCII, multiline navigation, modal restoration, trust
    // exclusion, and provider-proven Tab already have fully enumerated recorded
    // semantics. Failing closed here would hide independent substrate defects
    // behind one broad invalidation switch instead of repairing the boundary.
    expect(submitted).toEqual(exact)
  })

  it('CH-04 does not treat an unchanged newer provider redraw as edit acknowledgement', () => {
    const recordedCase = caseById('unchanged-redraw-after-edit')
    const trace = recordedCase.editAcknowledgementTrace
    if (!trace) throw new Error('missing recorded CH-04 acknowledgement trace')

    // WHY a generation proves only that some provider bytes were parsed. Here
    // the working-status bytes were emitted before the edit reached Codex; the
    // recorder schedules the real processes so that tiny interval is visible.
    // Draft plus cursor are unchanged, so generation 36 cannot acknowledge the
    // `_EDIT` suffix even though it is newer than the pre-write frame.
    expect(trace.unchangedAfterEdit.generation)
      .toBeGreaterThan(trace.beforeEdit.generation)
    expect(trace.unchangedAfterEdit.rows.map(row => row.text))
      .toEqual(trace.beforeEdit.rows.map(row => row.text))
    expect(trace.unchangedAfterEdit.cursor).toEqual(trace.beforeEdit.cursor)
    expect(trace.setupDurableUserText).toBe(trace.setupRequestUserText)

    const evidence = issuedEvidence()
    evidence.consume(trace.baseDraft, { frame: null })
    evidence.consume(trace.edit, { frame: stableFrame(trace.beforeEdit) })
    expect(evidence.consume('\r', {
      frame: stableFrame(trace.unchangedAfterEdit),
    })).toEqual([])
  })

  it('CH-04 accepts the durable value only after the provider paints the edit', () => {
    const recordedCase = caseById('unchanged-redraw-after-edit')
    const trace = recordedCase.editAcknowledgementTrace
    if (!trace) throw new Error('missing recorded CH-04 acknowledgement trace')

    expect(trace.paintedEdit.generation)
      .toBeGreaterThan(trace.unchangedAfterEdit.generation)
    const evidence = issuedEvidence()
    evidence.consume(trace.baseDraft, { frame: null })
    evidence.consume(trace.edit, { frame: stableFrame(trace.beforeEdit) })
    expect(evidence.consume('\r', {
      frame: stableFrame(trace.paintedEdit),
    })).toEqual([recordedCase.durableUserText])
  })

  it('CH-09 rejects the recorded resized frame until Codex repaints its layout', () => {
    const recordedCase = caseById('narrow-soft-wrap-resize-redraw')
    const beforeTyping = recordedCase.beforeTypingFrame
    const resize = recordedCase.resizeTrace
    if (!beforeTyping || !resize) throw new Error('missing recorded CH-04 frames')

    // WHY the equal generation and byte count are the causal boundary. xterm
    // has adopted 92 columns, but Codex has not acknowledged that layout: its
    // old 52-column two-row paint remains byte-for-byte on screen. Interpreting
    // those rows with the new width manufactures a newline the durable prompt
    // and request prove never existed.
    expect(resize.beforeProviderRedraw.generation).toBe(resize.narrow.generation)
    expect(resize.rawChunkCountBeforeProviderRedraw)
      .toBe(resize.rawChunkCountBeforeResize)
    expect(resize.beforeProviderRedraw.rows.map(row => row.text))
      .toEqual(resize.narrow.rows.map(row => row.text))

    const evidence = issuedEvidence()
    expect(evidence.consume(recordedCase.inputChunks[0]!, {
      frame: stableFrame(beforeTyping),
    })).toEqual([])
    expect(evidence.consume('\r', {
      // WHY the recorded generation and raw-chunk count stayed unchanged
      // across this resize. Epoch 1 is xterm's new geometry; epoch 0 is the
      // latest geometry Codex had actually painted at this exact boundary.
      frame: stableFrame(resize.beforeProviderRedraw, {
        layoutEpoch: 1,
        providerLayoutEpoch: 0,
      }),
    })).toEqual([])
  })

  it('Stage 38 rejects a post-resize status generation that leaves stale composer geometry', () => {
    const resizeCase = caseById('narrow-soft-wrap-resize-redraw')
    const statusCase = caseById('unchanged-redraw-after-edit')
    const beforeTyping = resizeCase.beforeTypingFrame
    const resize = resizeCase.resizeTrace
    const status = statusCase.editAcknowledgementTrace
    if (!beforeTyping || !resize || !status) {
      throw new Error('missing recorded Stage 38 terminal boundaries')
    }

    // WHY this composes two real recordings without inventing any composer
    // content. The resize fixture supplies the exact stale xterm-reflowed rows
    // whose newline disagrees with both its durable role-user item and request.
    // The unrelated-redraw fixture supplies the independently observed
    // scheduler fact: two later provider chunks/generations can repaint status
    // while draft rows and logical cursor remain byte-identical. Replaying only
    // that observed generation delta over the recorded stale rows models the
    // coarse `providerLayoutEpoch` transition under review; no prompt atom is
    // synthesized or changed.
    expect(status.unchangedComposerRevision).toBe(true)
    expect(status.unchangedAfterEdit.rows.map(row => row.text))
      .toEqual(status.beforeEdit.rows.map(row => row.text))
    expect(status.unchangedAfterEdit.cursor).toEqual(status.beforeEdit.cursor)
    const statusGenerationDelta = status.unchangedAfterEdit.generation -
      status.beforeEdit.generation
    const statusChunkDelta = status.rawChunkCountAtUnchangedRedraw -
      status.rawChunkCountBeforeEdit
    expect(statusGenerationDelta).toBeGreaterThan(0)
    expect(statusChunkDelta).toBe(statusGenerationDelta)

    const staleAfterStatus: RecordedStableFrame = {
      ...resize.beforeProviderRedraw,
      generation: resize.beforeProviderRedraw.generation + statusGenerationDelta,
    }
    expect(staleAfterStatus.rows.map(row => row.text))
      .toEqual(resize.beforeProviderRedraw.rows.map(row => row.text))

    const evidence = issuedEvidence()
    evidence.consume(resizeCase.inputChunks[0]!, {
      frame: stableFrame(beforeTyping),
    })
    expect(evidence.consume('\r', {
      // A status-only chunk currently advances providerLayoutEpoch to 1 even
      // though no Codex composer row was painted for layout epoch 1. Ownership
      // must remain empty until the genuine recorded repaint used by the next
      // green control, not accept the stale two-row geometry as a logical LF.
      frame: stableFrame(staleAfterStatus, {
        layoutEpoch: 1,
        providerLayoutEpoch: 1,
      }),
    })).toEqual([])
  })

  it('CH-09 accepts the same durable prompt after the recorded provider redraw', () => {
    const recordedCase = caseById('narrow-soft-wrap-resize-redraw')
    const beforeTyping = recordedCase.beforeTypingFrame
    const resize = recordedCase.resizeTrace
    if (!beforeTyping || !resize) throw new Error('missing recorded CH-04 frames')

    expect(resize.afterProviderRedraw.generation)
      .toBeGreaterThan(resize.beforeProviderRedraw.generation)
    const evidence = issuedEvidence()
    evidence.consume(recordedCase.inputChunks[0]!, {
      frame: stableFrame(beforeTyping),
    })
    expect(evidence.consume('\r', {
      frame: stableFrame(resize.afterProviderRedraw, {
        layoutEpoch: 1,
        providerLayoutEpoch: 1,
      }),
    })).toEqual([recordedCase.durableUserText])
  })

  it('CH-10 keeps modal sentinel prose inside an ordinary submitted draft', () => {
    const recordedCase = caseById('ordinary-modal-sentinel-draft')
    if (!recordedCase.screenBeforeFinalWrite) throw new Error('missing CH-05 screen')
    const evidence = issuedEvidence()
    evidence.consume(recordedCase.inputChunks[0]!, { frame: null })
    expect(evidence.consume('\r', {
      frame: frameFromRows(recordedCase.screenBeforeFinalWrite),
    })).toEqual([recordedCase.durableUserText])
  })

  it('CH-10 treats Vim: Insert in the recorded cwd footer as ordinary text', () => {
    const recordedCase = caseById('ordinary-vim-sentinel-cwd')
    if (!recordedCase.screenBeforeFinalWrite) throw new Error('missing CH-09 screen')
    const evidence = issuedEvidence()
    evidence.consume(recordedCase.inputChunks[0]!, { frame: null })
    expect(evidence.consume('\r', {
      frame: frameFromRows(recordedCase.screenBeforeFinalWrite),
    })).toEqual([recordedCase.durableUserText])
  })

  it('CH-10 still rejects the genuine recorded trust modal and Vim status atom', () => {
    const trust = caseById('trust-action-then-submit')
    const vim = caseById('vim-normal-default')
    if (!trust.modal || !vim.screenBeforeFinalWrite) {
      throw new Error('missing recorded CH-10 negative controls')
    }

    expect(classifyCodex01491ComposerSurface(frameFromRows(trust.modal)))
      .toEqual({ kind: 'non-composer-modal' })
    expect(classifyCodex01491ComposerSurface(
      frameFromRows(vim.screenBeforeFinalWrite),
    )).toEqual({ kind: 'unknown' })
  })

  it('CH-05 refuses profile issuance for the recorded lower-layer conflict', async () => {
    const control = caseById('lower-layer-keymap-valid-control')
    const conflict = caseById('lower-layer-keymap-issued-profile-conflict')
    expect(control.startupOutcome).toBe('composer-ready')
    expect(control.requestCountDelta).toBe(0)
    expect(conflict.startupOutcome).toBe('rejected-before-composer')
    expect(conflict.exitOutcome?.exitCode).toBe(1)
    expect(conflict.requestCountDelta).toBe(0)

    // WHY the fixture server wraps the recorded config/read projection and
    // adds only the exact non-null lower binding proved by the paired live TUI
    // outcomes above. The issuer must inspect effective routing and refuse
    // before Agent Code appends arguments that make Codex exit at startup.
    await expect(prepareRecordedProfile('conflicting-binding')).resolves.toEqual({
      ok: false,
      reason: 'effective-config-unverified',
    })
  })
})
