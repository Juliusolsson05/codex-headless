import { spawn } from 'node:child_process'

const issuedProfiles = new WeakSet<object>()

const CODEX_01491_PROMPT_INPUT_OVERRIDES = Object.freeze([
  'tui.keymap.composer.submit="enter"',
  'tui.keymap.composer.queue="tab"',
  'tui.vim_mode_default=false',
  'tui.keymap.global.toggle_vim_mode=[]',
])
const CODEX_01491_PROMPT_INPUT_ARGS = Object.freeze(
  CODEX_01491_PROMPT_INPUT_OVERRIDES.flatMap(override => [
    '--config',
    override,
  ]),
)
const PROBE_CLIENT_NAME = 'agent_code_prompt_profile_probe'
const INITIALIZE_ID = 'agent-code-prompt-profile-initialize'
const CONFIG_READ_ID = 'agent-code-prompt-profile-config-read'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

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
  /** Exact binary that will be used for the immediately following PTY spawn. */
  binary: string
  /** Exact working directory whose project configuration Codex will resolve. */
  cwd: string
  /** Exact environment that will be passed to the PTY process. */
  env?: Readonly<Record<string, string | undefined>>
  /** Global launch arguments assembled before the profile's final overrides. */
  baseArgs?: readonly string[]
  /** Bounded app-server probe deadline. Defaults to 5 seconds. */
  timeoutMs?: number
}

export type CodexPromptInputProfilePreparation =
  | { ok: true; profile: CodexPromptInputProfile }
  | {
      ok: false
      reason: 'unsupported-cli' | 'effective-config-unverified'
    }

/**
 * Ask the exact Codex binary to resolve its own effective input configuration,
 * then issue the narrow capability consumed by PromptInputEvidence.
 *
 * WHY CLI overrides alone are not an attestation: rust-v0.149.1 merges every
 * dotted override into one session layer, validates the fully resolved keymap,
 * and then applies legacy managed file/MDM layers above session flags. A lower
 * binding can therefore conflict with our forced Tab, while managed policy can
 * replace it outright. Reimplementing that resolver here would create a second
 * source of truth. `config/read` executes the same binary, cwd, environment,
 * and already-assembled global arguments as the imminent PTY launch. We inspect
 * its response only in memory and issue nothing unless every effective binding
 * is exactly the recorded 0.149.1 contract.
 */
export async function prepareCodex01491PromptInputProfile(
  options: Codex01491PromptInputProfileOptions,
): Promise<CodexPromptInputProfilePreparation> {
  let attestation: AttestationResult
  try {
    attestation = await readEffectiveInputAttestation(options)
  } catch {
    // WHY an invalid custom binary/cwd is not permission to skip the terminal
    // launch path. The parent may still present the provider's own error or use
    // the terminal without transcript ownership; only capability issuance must
    // fail closed, and no raw spawn/config error crosses this privacy boundary.
    return { ok: false, reason: 'effective-config-unverified' }
  }
  if (!attestation.ok) return attestation

  const configOverrides = Object.freeze([
    ...CODEX_01491_PROMPT_INPUT_OVERRIDES,
  ])
  const cliArgs = Object.freeze([...CODEX_01491_PROMPT_INPUT_ARGS])
  const profile = Object.freeze({
    profileVersion: 1 as const,
    provider: 'codex' as const,
    cliVersion: '0.149.1' as const,
    upstreamTag: 'rust-v0.149.1' as const,
    submitKey: 'enter' as const,
    queueKey: 'tab' as const,
    vimMode: false as const,
    vimToggle: false as const,
    configOverrides,
    cliArgs,
  }) as CodexPromptInputProfile
  issuedProfiles.add(profile)
  return { ok: true, profile }
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
    arraysEqual(profile.cliArgs, CODEX_01491_PROMPT_INPUT_ARGS)
}

export function assertIssuedCodexPromptInputProfile(
  value: unknown,
): CodexPromptInputProfile {
  if (!isIssuedCodexPromptInputProfile(value)) {
    throw new Error(
      'promptInputProfile must be issued by ' +
        'prepareCodex01491PromptInputProfile()',
    )
  }
  return value
}

type AttestationResult =
  | { ok: true }
  | Extract<CodexPromptInputProfilePreparation, { ok: false }>

async function readEffectiveInputAttestation(
  options: Codex01491PromptInputProfileOptions,
): Promise<AttestationResult> {
  const args = [
    ...(options.baseArgs ?? []),
    ...CODEX_01491_PROMPT_INPUT_ARGS,
    'app-server',
    '--stdio',
  ]
  const timeoutMs = Number.isFinite(options.timeoutMs) &&
    (options.timeoutMs ?? 0) > 0
    ? Math.min(options.timeoutMs!, 30_000)
    : 5_000

  return await new Promise(resolve => {
    let settled = false
    let stdout = ''
    let initializedVersion: string | null = null
    const child = spawn(options.binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    child.stdout.setEncoding('utf8')

    const finish = (value: AttestationResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // WHY config/read is a bounded pre-spawn observation, not a second live
      // provider. Once the projection is decided, retaining app-server would
      // duplicate filesystem/config watchers for every terminal session.
      child.kill()
      const forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 250)
      forceKillTimer.unref?.()
      child.once('exit', () => clearTimeout(forceKillTimer))
      resolve(value)
    }
    const refuse = () => finish({
      ok: false,
      reason: 'effective-config-unverified',
    })
    const timer = setTimeout(refuse, timeoutMs)

    child.on('error', refuse)
    child.stdin.on('error', refuse)
    child.stdout.on('error', refuse)
    child.on('exit', () => {
      if (!settled) refuse()
    })
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_RESPONSE_BYTES) {
        refuse()
        return
      }
      for (;;) {
        const newline = stdout.indexOf('\n')
        if (newline < 0) break
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (!isRecord(message)) continue

        if (message.id === INITIALIZE_ID) {
          if (!isSuccessfulResponse(message, INITIALIZE_ID)) {
            // WHY JSON-RPC success and failure are mutually exclusive. Reading
            // a plausible result beside an error would mint ownership authority
            // from an app server that explicitly says attestation failed.
            refuse()
            return
          }
          const userAgent = isRecord(message.result)
            ? message.result.userAgent
            : null
          const version = typeof userAgent === 'string'
            ? new RegExp(`^${PROBE_CLIENT_NAME}/(\\d+\\.\\d+\\.\\d+)(?:\\s|$)`)
              .exec(userAgent)?.[1] ?? null
            : null
          if (version !== '0.149.1') {
            finish({ ok: false, reason: 'unsupported-cli' })
            return
          }
          initializedVersion = version
          child.stdin.write(`${JSON.stringify({
            method: 'initialized',
            params: {},
          })}\n`)
          child.stdin.write(`${JSON.stringify({
            method: 'config/read',
            id: CONFIG_READ_ID,
            params: { cwd: options.cwd, includeLayers: true },
          })}\n`)
          continue
        }

        if (message.id !== CONFIG_READ_ID) continue
        if (!isSuccessfulResponse(message, CONFIG_READ_ID) ||
          initializedVersion !== '0.149.1' ||
          !effectiveInputIsRecordedContract(message.result)) {
          refuse()
          return
        }
        finish({ ok: true })
        return
      }
    })

    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: INITIALIZE_ID,
      params: {
        clientInfo: {
          name: PROBE_CLIENT_NAME,
          title: 'Agent Code prompt-profile probe',
          version: '0.1.0',
        },
      },
    })}\n`)
  })
}

function isSuccessfulResponse(
  value: Record<string, unknown>,
  expectedId: string,
): boolean {
  return value.id === expectedId &&
    Object.prototype.hasOwnProperty.call(value, 'result') &&
    !Object.prototype.hasOwnProperty.call(value, 'error')
}

function effectiveInputIsRecordedContract(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.config) ||
    !isRecord(value.config.tui) || !isRecord(value.config.tui.keymap)) {
    return false
  }
  const tui = value.config.tui
  const keymap = tui.keymap
  const composer = isRecord(keymap.composer) ? keymap.composer : null
  const global = isRecord(keymap.global) ? keymap.global : null
  if (!composer || !global || composer.submit !== 'enter' ||
    composer.queue !== 'tab' || tui.vim_mode_default !== false ||
    !Array.isArray(global.toggle_vim_mode) ||
    global.toggle_vim_mode.length !== 0) {
    return false
  }

  const allowed = new Set([
    'composer.submit',
    'composer.queue',
    'global.toggle_vim_mode',
  ])
  if (flattenLeaves(keymap).some(([path, leaf]) =>
    !allowed.has(path) && leaf !== null)) {
    return false
  }

  if (!Array.isArray(value.layers)) return false
  const allowedLayerTypes = new Set(['sessionFlags', 'user', 'system', 'project'])
  const singletonLayerTypes = new Set(['sessionFlags', 'user', 'system'])
  const seenSingletons = new Set<string>()
  for (const layer of value.layers) {
    if (!isRecord(layer) || !isRecord(layer.name) ||
      typeof layer.name.type !== 'string' ||
      !allowedLayerTypes.has(layer.name.type)) {
      // WHY config/read is the authority that says our forced keymap is the
      // effective provider input contract. Treating malformed or future layer
      // variants as an ignorable `null` lets a higher-precedence policy exist
      // outside the proof while we still issue submission authority. A pinned
      // 0.149.1 adapter must fail closed until a new variant is recorded.
      return false
    }
    if (!singletonLayerTypes.has(layer.name.type)) continue
    if (seenSingletons.has(layer.name.type)) {
      // WHY these three protocol sources are singletons. A duplicate is not a
      // second harmless copy; it means the response no longer has the recorded
      // merge shape, so we cannot know which same-named source supplied the
      // effective value. Project layers are intentionally excluded because
      // Codex may legitimately report one for each nested .codex directory.
      return false
    }
    seenSingletons.add(layer.name.type)
  }
  return seenSingletons.has('sessionFlags')
}

function flattenLeaves(
  value: Record<string, unknown>,
  prefix = '',
): Array<[string, unknown]> {
  const leaves: Array<[string, unknown]> = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isRecord(child)) leaves.push(...flattenLeaves(child, path))
    else leaves.push([path, child])
  }
  return leaves
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index])
}
