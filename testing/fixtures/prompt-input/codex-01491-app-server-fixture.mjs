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
  const layers = layerTypes.map(type => ({ name: { type }, config: {} }))
  if (mode === 'malformed-layer') {
    // WHY preserve the exact recorded layer count and every neighboring config
    // value. The twelfth-gate counterexample changed only one protocol object
    // into a shape that the current nullable projection silently maps to null;
    // inventing a second effective-keymap mutation would no longer isolate the
    // authority minted by malformed layer evidence.
    layers[1] = { name: null, config: {} }
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
