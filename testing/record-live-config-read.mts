#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PROFILE_OVERRIDES = [
  'tui.keymap.composer.submit="enter"',
  'tui.keymap.composer.queue="tab"',
  'tui.vim_mode_default=false',
  'tui.keymap.global.toggle_vim_mode=[]',
] as const
const CLIENT_NAME = 'agent_code_prompt_profile_probe'
const INITIALIZE_ID = 'agent-code-config-initialize'
const CONFIG_READ_ID = 'agent-code-config-read'
const binary = process.env.CODEX_BINARY ?? 'codex'
const cwd = process.env.CODEX_INPUT_RECORD_CWD ?? process.cwd()
const sourceEvidencePath = fileURLToPath(new URL(
  './fixtures/prompt-input/codex-01491-config-source.json',
  import.meta.url,
))

// WHY this recorder projects only key routing, version, and layer types. A
// config/read response may contain private paths, MCP declarations, and future
// credential-bearing fields; writing the raw response would turn a correctness
// fixture into a secret/configuration archive. The production attestor must
// likewise inspect in memory and return only a capability or a generic refusal.
const projection = await recordProjection()
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  provider: {
    cliVersion: projection.cliVersion,
    binarySha256: sha256File(binary),
    upstreamTag: 'rust-v0.149.1',
    upstreamCommitSha: 'ff29a44391deccde0aba0f8390337d7f3c319ea4',
  },
  protocol: {
    transport: 'app-server-stdio-jsonl',
    request: 'config/read',
    includeLayers: true,
    clientName: CLIENT_NAME,
  },
  effectiveInputProjection: projection.effectiveInputProjection,
  sourceEvidenceSha256: sha256File(sourceEvidencePath),
}, null, 2)}\n`)

async function recordProjection(): Promise<{
  cliVersion: string
  effectiveInputProjection: Record<string, unknown>
}> {
  const args = PROFILE_OVERRIDES.flatMap(value => ['--config', value])
  args.push('app-server', '--stdio')
  const child = spawn(binary, args, {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  child.stdout.setEncoding('utf8')

  return await new Promise((resolve, reject) => {
    let stdout = ''
    let cliVersion: string | null = null
    let settled = false
    const timeout = setTimeout(() => finish(
      new Error('Codex config/read recording timed out'),
    ), 10_000)

    const finish = (error?: Error, value?: {
      cliVersion: string
      effectiveInputProjection: Record<string, unknown>
    }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      if (error) reject(error)
      else resolve(value!)
    }

    child.on('error', () => finish(new Error('Codex config/read process failed')))
    child.on('exit', code => {
      if (!settled) finish(new Error(`Codex config/read exited ${code ?? 'unknown'}`))
    })
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 2 * 1024 * 1024) {
        finish(new Error('Codex config/read response exceeded the recording cap'))
        return
      }
      for (;;) {
        const newline = stdout.indexOf('\n')
        if (newline < 0) break
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        let message: Record<string, any>
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === INITIALIZE_ID) {
          const match = new RegExp(`^${CLIENT_NAME}/(\\d+\\.\\d+\\.\\d+)(?:\\s|$)`)
            .exec(message.result?.userAgent ?? '')
          if (!match) {
            finish(new Error('Codex initialize response had an unexpected user agent'))
            return
          }
          cliVersion = match[1]!
          child.stdin.write(`${JSON.stringify({
            method: 'initialized',
            params: {},
          })}\n`)
          child.stdin.write(`${JSON.stringify({
            method: 'config/read',
            id: CONFIG_READ_ID,
            params: { cwd, includeLayers: true },
          })}\n`)
          continue
        }
        if (message.id !== CONFIG_READ_ID) continue
        if (!cliVersion) {
          finish(new Error('Codex config/read arrived before initialize'))
          return
        }
        finish(undefined, {
          cliVersion,
          effectiveInputProjection: projectEffectiveInput(message.result),
        })
        return
      }
    })

    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: INITIALIZE_ID,
      params: {
        clientInfo: {
          name: CLIENT_NAME,
          title: 'Agent Code prompt-profile probe',
          version: '0.1.0',
        },
      },
    })}\n`)
  })
}

function projectEffectiveInput(result: Record<string, any> | undefined) {
  const keymap = result?.config?.tui?.keymap as Record<string, unknown> | undefined
  const allowedPaths = new Set([
    'composer.submit',
    'composer.queue',
    'global.toggle_vim_mode',
  ])
  const otherNonNullKeymapBindings = flattenLeaves(keymap)
    .filter(([path, value]) => !allowedPaths.has(path) && value !== null)
    .map(([path]) => path)
    .sort()
  const layerTypes = (result?.layers ?? [])
    .map((layer: Record<string, any>) => layer?.name?.type)
    .filter((value: unknown): value is string => typeof value === 'string')
  return {
    composerSubmit: (keymap?.composer as Record<string, unknown> | undefined)?.submit,
    composerQueue: (keymap?.composer as Record<string, unknown> | undefined)?.queue,
    globalToggleVimMode:
      (keymap?.global as Record<string, unknown> | undefined)?.toggle_vim_mode,
    vimModeDefault: result?.config?.tui?.vim_mode_default,
    otherNonNullKeymapBindings,
    layerTypes,
    legacyManagedLayerPresent: layerTypes.some(type =>
      type === 'legacyManagedConfigTomlFromFile' ||
      type === 'legacyManagedConfigTomlFromMdm'),
  }
}

function flattenLeaves(
  value: Record<string, unknown> | undefined,
  prefix = '',
): Array<[string, unknown]> {
  if (!value) return []
  const leaves: Array<[string, unknown]> = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      leaves.push(...flattenLeaves(child as Record<string, unknown>, path))
    } else {
      leaves.push([path, child])
    }
  }
  return leaves
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}
