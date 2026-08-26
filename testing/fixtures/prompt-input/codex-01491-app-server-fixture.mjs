#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const recorded = JSON.parse(readFileSync(fileURLToPath(new URL(
  './codex-01491-config-read-recorded.json',
  import.meta.url,
)), 'utf8'))
const mode = process.env.CODEX_PROFILE_FIXTURE_MODE ?? 'recorded-safe'
const effective = recorded.effectiveInputProjection
const requiredArg = process.env.CODEX_PROFILE_REQUIRED_ARG
if (requiredArg && !process.argv.slice(2).includes(requiredArg)) {
  process.exit(2)
}

// WHY this fixture is a protocol shell around a real sanitized config/read
// projection, not an invented effective keymap. Production tests need a
// deterministic child process in CI, where the pinned Codex binary is absent;
// only the explicitly named mutation cases differ from the recorded response.
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.method === 'initialize') {
    const version = mode === 'wrong-version' ? '0.150.0' : recorded.provider.cliVersion
    respond({
      id: request.id,
      ...(mode === 'initialize-result-and-error'
        ? { error: { code: -1, message: 'recorded initialize failure' } }
        : {}),
      result: {
        userAgent: `${recorded.protocol.clientName}/${version} (recorded fixture)`,
      },
    })
    return
  }
  if (request.method !== 'config/read') return

  const keymap = {
    global: { toggle_vim_mode: effective.globalToggleVimMode },
    composer: {
      submit: effective.composerSubmit,
      queue: effective.composerQueue,
      ...(mode === 'conflicting-binding' ? { toggle_shortcuts: 'tab' } : {}),
    },
  }
  const layerTypes = [...effective.layerTypes]
  if (mode === 'managed-layer') {
    layerTypes.unshift('legacyManagedConfigTomlFromFile')
  }
  if (mode === 'unknown-layer') {
    layerTypes.unshift('futurePolicyLayer')
  }
  if (mode === 'duplicate-layer') {
    layerTypes.push('user')
  }
  if (mode === 'multiple-project-layers') {
    layerTypes.push('project', 'project')
  }
  if (mode === 'missing-project-folder') {
    layerTypes.push('project')
  }
  const layers = layerTypes.map((type, index) => recordedLayer(type, index))
  if (mode === 'malformed-layer') {
    // WHY preserve the exact recorded layer count and every neighboring config
    // value. The twelfth-gate counterexample changed only one protocol object
    // into a shape that the current nullable projection silently maps to null;
    // inventing a second effective-keymap mutation would no longer isolate the
    // authority minted by malformed layer evidence.
    layers[1] = { name: null, config: {} }
  }
  const userLayer = layers.find(layer => layer.name?.type === 'user')
  const systemLayer = layers.find(layer => layer.name?.type === 'system')
  const projectLayer = layers.find(layer => layer.name?.type === 'project')
  if (mode === 'missing-layer-version') delete layers[0].version
  if (mode === 'missing-layer-config') delete layers[0].config
  if (mode === 'missing-user-file') delete userLayer.name.file
  if (mode === 'missing-user-profile') delete userLayer.name.profile
  if (mode === 'missing-system-file') delete systemLayer.name.file
  if (mode === 'missing-project-folder') delete projectLayer.name.dotCodexFolder
  if (mode === 'invalid-disabled-reason') {
    layers[0].disabledReason = { unexpected: true }
  }
  respond({
    id: request.id,
    ...(mode === 'result-and-error'
      ? { error: { code: -1, message: 'recorded config/read failure' } }
      : {}),
    result: {
      config: {
        tui: {
          keymap,
          vim_mode_default: effective.vimModeDefault,
        },
      },
      layers,
    },
  })
})

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function recordedLayer(type, index) {
  // WHY placeholder values exist at all: the fresh 0.149.1 recording proves
  // these exact fields and JSON types, but committing its host paths or config
  // would turn a protocol fixture into a privacy leak. The structure and raw
  // response checksum live in codex-01491-config-read-recorded.json; only the
  // content-safe values below are substituted so the deterministic shell emits
  // a schema-valid response rather than the malformed `{name:{type}}` shape
  // that hid the twelfth-gate bug.
  const names = {
    sessionFlags: { type: 'sessionFlags' },
    user: {
      type: 'user',
      file: '/sanitized/codex-home/config.toml',
      profile: null,
    },
    system: {
      type: 'system',
      file: '/sanitized/system/config.toml',
    },
    project: {
      type: 'project',
      dotCodexFolder: `/sanitized/project-${index}/.codex`,
    },
  }
  return {
    name: names[type] ?? { type },
    version: `recorded-${type}-version`,
    config: {},
  }
}
