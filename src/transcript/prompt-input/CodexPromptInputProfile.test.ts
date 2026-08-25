import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  assertIssuedCodexPromptInputProfile,
  prepareCodex01491PromptInputProfile,
} from './CodexPromptInputProfile.js'

const appServerFixture = fileURLToPath(new URL(
  '../../../testing/fixtures/prompt-input/codex-01491-app-server-fixture.mjs',
  import.meta.url,
))

function prepare(mode = 'recorded-safe') {
  return prepareCodex01491PromptInputProfile({
    binary: process.execPath,
    cwd: process.cwd(),
    baseArgs: [appServerFixture],
    env: {
      ...process.env,
      CODEX_PROFILE_FIXTURE_MODE: mode,
    },
  })
}

describe('Codex 0.149.1 prompt-input launch profile', () => {
  it('issues frozen launch arguments only after recorded config/read attestation', async () => {
    const result = await prepare()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { profile } = result

    // WHY this exact ordered vector must be both observed by config/read and
    // appended to the immediately following PTY. A version string or a copied
    // profile object proves neither effective key routing nor launch identity.
    expect(profile.cliArgs).toEqual([
      '--config', 'tui.keymap.composer.submit="enter"',
      '--config', 'tui.keymap.composer.queue="tab"',
      '--config', 'tui.vim_mode_default=false',
      '--config', 'tui.keymap.global.toggle_vim_mode=[]',
    ])
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.configOverrides)).toBe(true)
    expect(Object.isFrozen(profile.cliArgs)).toBe(true)

    const lookalike = Object.freeze({ ...profile })
    expect(() => assertIssuedCodexPromptInputProfile(lookalike)).toThrow(
      /must be issued by prepareCodex01491PromptInputProfile/,
    )
  })

  it.each([
    ['conflicting-binding', 'effective-config-unverified'],
    ['managed-layer', 'effective-config-unverified'],
    ['wrong-version', 'unsupported-cli'],
  ] as const)('refuses %s effective evidence', async (mode, reason) => {
    await expect(prepare(mode)).resolves.toEqual({ ok: false, reason })
  })
})
