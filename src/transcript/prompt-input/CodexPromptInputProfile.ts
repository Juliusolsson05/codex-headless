const issuedProfiles = new WeakSet<object>()

const CODEX_01491_PROMPT_INPUT_OVERRIDES = Object.freeze([
  'tui.keymap.composer.submit="enter"',
  'tui.keymap.composer.queue="tab"',
  'tui.vim_mode_default=false',
  'tui.keymap.global.toggle_vim_mode=[]',
])

declare const CODEX_PROMPT_INPUT_PROFILE: unique symbol

export type CodexPromptInputProfile = Readonly<{
  profileVersion: 1
  provider: 'codex'
  cliVersion: '0.149.1'
  upstreamTag: 'rust-v0.149.1'
  submitKey: 'enter'
  queueKey: 'tab'
  vimMode: false
  vimToggle: false
  configOverrides: readonly string[]
  cliArgs: readonly string[]
  readonly [CODEX_PROMPT_INPUT_PROFILE]: true
}>

export type Codex01491PromptInputProfileOptions = {
  /** Exact output from `codex --version`, or its normalized numeric version. */
  cliVersion: string
}

/**
 * Issue the narrow capability that enables prompt reconstruction.
 *
 * WHY a version string alone is not an attestation: Codex 0.149.1 supports
 * user/project keymap layers, explicit unbinding, and Vim-by-default. Those
 * settings change the meaning of the same PTY bytes. Asking Agent Code to
 * rediscover Codex's config-layer resolver would create a second source of
 * truth, so the package instead issues highest-precedence CLI overrides. The
 * caller must append the frozen `cliArgs` to the exact process launch before
 * handing its PTY and this capability to CodexHeadless.
 */
export function createCodex01491PromptInputProfile(
  options: Codex01491PromptInputProfileOptions,
): CodexPromptInputProfile {
  const cliVersion = normalizeCodexVersion(options.cliVersion)
  if (cliVersion !== '0.149.1') {
    throw new Error(
      `Codex prompt-input evidence supports exactly 0.149.1; received ${JSON.stringify(options.cliVersion)}`,
    )
  }
  const configOverrides = Object.freeze([...CODEX_01491_PROMPT_INPUT_OVERRIDES])
  const cliArgs = Object.freeze(configOverrides.flatMap(override => [
    '--config',
    override,
  ]))

  const profile = Object.freeze({
    profileVersion: 1 as const,
    provider: 'codex' as const,
    cliVersion,
    upstreamTag: 'rust-v0.149.1' as const,
    submitKey: 'enter' as const,
    queueKey: 'tab' as const,
    vimMode: false as const,
    vimToggle: false as const,
    configOverrides,
    cliArgs,
  }) as CodexPromptInputProfile
  issuedProfiles.add(profile)
  return profile
}

export function isIssuedCodexPromptInputProfile(
  value: unknown,
): value is CodexPromptInputProfile {
  if (typeof value !== 'object' || value === null || !issuedProfiles.has(value)) {
    return false
  }
  const profile = value as CodexPromptInputProfile
  return profile.profileVersion === 1 &&
    profile.provider === 'codex' &&
    profile.cliVersion === '0.149.1' &&
    profile.upstreamTag === 'rust-v0.149.1' &&
    profile.submitKey === 'enter' &&
    profile.queueKey === 'tab' &&
    profile.vimMode === false &&
    profile.vimToggle === false &&
    Object.isFrozen(profile) &&
    Object.isFrozen(profile.configOverrides) &&
    Object.isFrozen(profile.cliArgs) &&
    arraysEqual(profile.configOverrides, CODEX_01491_PROMPT_INPUT_OVERRIDES) &&
    arraysEqual(
      profile.cliArgs,
      CODEX_01491_PROMPT_INPUT_OVERRIDES.flatMap(override => ['--config', override]),
    )
}

export function assertIssuedCodexPromptInputProfile(
  value: unknown,
): CodexPromptInputProfile {
  if (!isIssuedCodexPromptInputProfile(value)) {
    throw new Error(
      'promptInputProfile must be created by createCodex01491PromptInputProfile()',
    )
  }
  return value
}

function normalizeCodexVersion(value: string): string {
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(value.trim())
  return match?.[1] ?? value.trim()
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
