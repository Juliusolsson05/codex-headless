import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

type GetterProjection = {
  sensitiveGetterNames: string[]
  getterResults: Record<string, {
    accessible: boolean
    matchesRecordedRuntimeValue?: boolean
  }>
}

type BuiltRuntimeProjection = {
  schemaVersion: number
  sources: Record<string, string>
  ch06ResumePrototype: {
    beforeDispose: GetterProjection
    afterDispose: GetterProjection
  }
  tenthGateResumeDeepModule: {
    exportNames: string[]
    exposesControllerUnwrapper: boolean
  }
  ch07StructuralPromptProfile: {
    caseId: string
    profileSource: string
    submissionCount: number
    matchedRecordedDurableText: boolean
  }
  ch08RetentionInspection: {
    participantEntryKeys: string[]
    resumeParticipantEntryKeys: string[]
    serializedContainsFreshParticipantId: boolean
    serializedContainsResumeParticipantId: boolean
  }
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const recordedArtifactPath = fileURLToPath(new URL(
  './fixtures/ninth-gate/built-runtime-93c6fcbe-recorded.json',
  import.meta.url,
))
const recorderPath = fileURLToPath(new URL(
  './record-ninth-gate-built-runtime.mts',
  import.meta.url,
))
const recorded = JSON.parse(
  readFileSync(recordedArtifactPath, 'utf8'),
) as BuiltRuntimeProjection
let current: BuiltRuntimeProjection

beforeAll(() => {
  // WHY this subprocess executes the emitted JavaScript rather than importing
  // source through Vitest. CH-06 through CH-08 are package-boundary findings:
  // TypeScript `private`, root exports, and source-only tests can all look safe
  // while the npm artifact still exposes a deep runtime surface. The recorder
  // creates only temporary rollout files and returns a content-safe projection.
  current = JSON.parse(execFileSync(
    process.execPath,
    ['--import', 'tsx', recorderPath],
    { cwd: packageRoot, encoding: 'utf8' },
  )) as BuiltRuntimeProjection

  // WHY these fixture hashes are the reality boundary. A later repair may
  // change built module hashes, but it must continue proving behavior against
  // the same recorded exact rollout, prompt frame, and prior capability
  // projection rather than substituting a more convenient invented case.
  expect(current.schemaVersion).toBe(recorded.schemaVersion)
  expect(current.sources).toEqual(recorded.sources)
})

describe('ninth-gate built runtime contracts', () => {
  it('CH-06 exposes no sensitive resume getter anywhere in the prototype chain', () => {
    expect(recorded.ch06ResumePrototype.beforeDispose.sensitiveGetterNames)
      .toEqual([
        'initialGenerationId',
        'initialPath',
        'ownerId',
        'sessionsDir',
      ])

    // WHY own-key/JSON checks are incomplete for a capability. Generic debug
    // reflection walks prototypes and invokes getters; before dispose that
    // reveals exact path/generation/owner state, while after dispose the getter
    // names still advertise a supposedly opaque internal surface. The public
    // rollback handle may expose dispose, but neither lifecycle state may carry
    // these getters anywhere on its prototype chain.
    expect.soft(
      current.ch06ResumePrototype.beforeDispose.sensitiveGetterNames,
    ).toEqual([])
    expect.soft(
      current.ch06ResumePrototype.afterDispose.sensitiveGetterNames,
    ).toEqual([])
  })

  it('keeps the resume controller unwrapper out of every shipped deep module', () => {
    // WHY the public handle's empty prototype is not the complete package
    // boundary. The tenth exact-head gate deep-imported the emitted preparation
    // module and recovered the WeakMap controller, including raw roots and lease
    // retirement authority. The public factory/type may remain importable for
    // compatibility, but no shipped export may cross that private closure.
    expect.soft(
      current.tenthGateResumeDeepModule.exposesControllerUnwrapper,
    ).toBe(false)
    expect.soft(current.tenthGateResumeDeepModule.exportNames)
      .not.toContain('unwrapCodexResumeRolloutPreparation')
  })

  it('CH-07 refuses an unissued recorded-profile lookalike in the shipped facade', () => {
    expect(recorded.ch07StructuralPromptProfile).toMatchObject({
      caseId: 'trust-action-then-submit',
      profileSource: 'caller-authored-structural-lookalike',
      submissionCount: 1,
      matchedRecordedDurableText: true,
    })

    // WHY the Stage 26 structural context documents a recording; it is not the
    // WeakSet-backed launch capability proving the shipped process received
    // frozen keymap arguments. Deep-import consumers can reach this facade from
    // the packed dist tree, so compatibility code must never promote a literal
    // that merely copies recorded-default fields into issued authority.
    expect.soft(current.ch07StructuralPromptProfile.submissionCount).toBe(0)
    expect.soft(
      current.ch07StructuralPromptProfile.matchedRecordedDurableText,
    ).toBe(false)
  })

  it('CH-08 omits raw fresh and resume owner IDs from shipped retention inspection', () => {
    expect(recorded.ch08RetentionInspection).toMatchObject({
      serializedContainsFreshParticipantId: true,
      serializedContainsResumeParticipantId: true,
    })

    // WHY retention inspection is itself shipped through the deep coordinator
    // module. HMAC fingerprints and counts are sufficient to test compaction;
    // returning caller-owned participant IDs makes a diagnostic snapshot a raw
    // cross-session identity store even though prompts, CWDs, and paths were
    // carefully converted to content-safe projections elsewhere.
    expect.soft(
      current.ch08RetentionInspection.participantEntryKeys,
    ).not.toContain('id')
    expect.soft(
      current.ch08RetentionInspection.resumeParticipantEntryKeys,
    ).not.toContain('id')
    expect.soft(
      current.ch08RetentionInspection.serializedContainsFreshParticipantId,
    ).toBe(false)
    expect.soft(
      current.ch08RetentionInspection.serializedContainsResumeParticipantId,
    ).toBe(false)
  })
})
