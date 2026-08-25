import { describe, expect, it } from 'vitest'

import {
  assertIssuedCodexPromptInputProfile,
  createCodex01491PromptInputProfile,
} from './CodexPromptInputProfile.js'

describe('Codex 0.149.1 prompt-input launch profile', () => {
  it('issues frozen highest-precedence launch arguments for every routed input', () => {
    const profile = createCodex01491PromptInputProfile({
      cliVersion: 'codex-cli 0.149.1',
    })

    // WHY this exact ordered vector is the attestation. Merely saying the
    // effective keymap is "default" cannot rule out user/project config, and
    // placing these values anywhere except the final global-option position
    // lets a later override change what Enter or Tab means after we authorize
    // prompt evidence. Consumers append this immutable vector immediately
    // before Codex's optional `resume` subcommand.
    expect(profile.cliArgs).toEqual([
      '--config', 'tui.keymap.composer.submit="enter"',
      '--config', 'tui.keymap.composer.queue="tab"',
      '--config', 'tui.vim_mode_default=false',
      '--config', 'tui.keymap.global.toggle_vim_mode=[]',
    ])
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.configOverrides)).toBe(true)
    expect(Object.isFrozen(profile.cliArgs)).toBe(true)
  })

  it('rejects caller-authored lookalikes and unsupported provider versions', () => {
    const issued = createCodex01491PromptInputProfile({ cliVersion: '0.149.1' })
    const lookalike = Object.freeze({ ...issued })

    // WHY every public field is intentionally serializable so Agent Code can
    // launch the provider, but those fields are not proof that it did so. The
    // private issuer identity closes the capability boundary even when a
    // caller copies a genuine profile byte-for-byte.
    expect(() => assertIssuedCodexPromptInputProfile(lookalike)).toThrow(
      /must be created by createCodex01491PromptInputProfile/,
    )
    expect(() => createCodex01491PromptInputProfile({
      cliVersion: 'codex-cli 0.150.0',
    })).toThrow(/supports exactly 0\.149\.1/)
  })
})
