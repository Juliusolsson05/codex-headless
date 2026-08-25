import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  inferCodexTabBehavior,
  SubmittedPromptInput,
  type SubmittedPromptInputContext,
} from './SubmittedPromptInput.js'

type RecordedConfigClass =
  | 'recorded-default-01491'
  | 'explicit-cli-override'

type RecordedPromptInputCase = {
  id: string
  sourceLabel: string
  rawPtySha256: string
  rolloutSha256: string
  rawRequestSha256: string | null
  configClass: RecordedConfigClass
  configOverrides: string[]
  inputChunks: string[]
  expectedSubmission: boolean
  durableUserText: string | null
  requestUserText: string | null
  screenBeforeFinalWrite: string[]
  nonComposerWrites?: string[]
  modal?: string[]
  popup?: string[]
  activeTurnFooter?: string[]
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
  inputProfile: {
    cliVersion: string
    upstreamTag: string
    configClass: RecordedConfigClass
    configOverrides: string[]
  }
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
const corpus = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as RecordedPromptInputCorpus
const catalog = readFileSync(catalogPath, 'utf8')

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
] as const

const unicodeBoundaryCases = new Set([
  'combining-grapheme-backspace',
  'mixed-cjk-ctrl-w',
])

const casesById = corpus.cases.map(recordedCase => [
  recordedCase.id,
  recordedCase,
] as const)

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
    inputProfile: {
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
    expect(recordedCase.configOverrides.length === 0)
      .toBe(recordedCase.configClass === 'recorded-default-01491')
  })

  it.each(casesById)('matches or safely declines recorded input evidence for %s', (
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
})
