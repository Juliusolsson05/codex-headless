import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IPty } from 'node-pty'

import { afterEach, describe, expect, it } from 'vitest'

import { CodexHeadless } from '../CodexHeadless.js'
import { CodexResponsesAdapter } from '../proxy/CodexResponsesAdapter.js'
import type { ResponsesProxy } from '../proxy/responsesProxy.js'

type RolloutFixture = {
  records: Array<Record<string, unknown>>
}

const fixturePath = fileURLToPath(new URL(
  '../../../../testing/fixtures/worktree-live-attribution/' +
    'codex-0151-worktree-window.json',
  import.meta.url,
))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as RolloutFixture
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function inertPty(): IPty {
  return {
    write: () => undefined,
    resize: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
}

function rolloutText(threadId: string): string {
  // The checked-in corpus tokenizes private provider UUIDs. This substitution
  // restores only the UUID grammar required by the exact locator; every record
  // shape, cwd transition, timestamp, and CLI version remains recorded data.
  return fixture.records
    .map(record => JSON.stringify(record).replaceAll('fixture-id-1', threadId))
    .join('\n') + '\n'
}

function writeRollout(options: {
  codexHome: string
  filenameThreadId: string
  metadataThreadId?: string
}): string {
  const day = join(options.codexHome, 'sessions', '2026', '08', '30')
  mkdirSync(day, { recursive: true })
  const filePath = join(
    day,
    `rollout-recorded-${options.filenameThreadId}.jsonl`,
  )
  writeFileSync(
    filePath,
    rolloutText(options.metadataThreadId ?? options.filenameThreadId),
  )
  return filePath
}

function proxyEmitter(): ResponsesProxy {
  return new EventEmitter() as ResponsesProxy
}

function emitRecordedIdentity(
  proxy: ResponsesProxy,
  threadId: string,
  headers?: Record<string, string>,
): void {
  proxy.emit('event', {
    kind: 'request',
    requestId: `request-${threadId}`,
    endpoint: 'responses',
    method: 'POST',
    path: '/v1/responses',
    upstream: 'https://fixture.invalid/v1/responses',
    ...(headers ? { headers } : {}),
    request_shape: {
      provider_session_id: threadId,
      client_metadata: {
        thread_id: threadId,
        session_id: threadId,
        root_turn_id: 'fixture-root-turn',
      },
    },
  })
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

function activeRolloutPath(headless: CodexHeadless): string | null {
  return (headless as unknown as { activeRolloutPath: string | null })
    .activeRolloutPath
}

function providerIdentityQueueSize(headless: CodexHeadless): number {
  const internal = headless as unknown as {
    pendingProviderThreadIdentity: string | null
    queuedProviderThreadIdentity: string | null
  }
  return Number(internal.pendingProviderThreadIdentity !== null) +
    Number(internal.queuedProviderThreadIdentity !== null)
}

describe('recorded per-session proxy rollout identity', () => {
  it('tails the exact recorded 0.151 rollout without prompt attestation', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-proxy-exact-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const threadId = '00000000-0000-4000-8000-000000000151'
    const rolloutPath = writeRollout({ codexHome, filenameThreadId: threadId })
    const headless = new CodexHeadless({
      pty: inertPty(),
      cwd: '/fixture/project-1',
    })
    const proxy = proxyEmitter()
    const adapter = new CodexResponsesAdapter(proxy, headless)

    try {
      adapter.attach()
      await headless.start()
      emitRecordedIdentity(proxy, threadId)

      expect(await waitFor(() => activeRolloutPath(headless) === rolloutPath))
        .toBe(true)
    } finally {
      adapter.detach()
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('rejects identity when filename and session_meta disagree', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-proxy-mismatch-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const filenameId = '00000000-0000-4000-8000-000000000152'
    const metadataId = '00000000-0000-4000-8000-000000000153'
    writeRollout({
      codexHome,
      filenameThreadId: filenameId,
      metadataThreadId: metadataId,
    })
    const headless = new CodexHeadless({
      pty: inertPty(),
      cwd: '/fixture/project-1',
    })
    const proxy = proxyEmitter()
    const adapter = new CodexResponsesAdapter(proxy, headless)

    try {
      adapter.attach()
      await headless.start()
      emitRecordedIdentity(proxy, filenameId)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(activeRolloutPath(headless)).toBeNull()
    } finally {
      adapter.detach()
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('does not attach a subagent identity observed by the parent proxy', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-proxy-subagent-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const threadId = '00000000-0000-4000-8000-000000000156'
    writeRollout({ codexHome, filenameThreadId: threadId })
    const headless = new CodexHeadless({
      pty: inertPty(),
      cwd: '/fixture/project-1',
    })
    const proxy = proxyEmitter()
    const adapter = new CodexResponsesAdapter(proxy, headless)

    try {
      adapter.attach()
      await headless.start()
      emitRecordedIdentity(proxy, threadId, {
        'x-openai-subagent': 'fixture-subagent',
      })
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(activeRolloutPath(headless)).toBeNull()
    } finally {
      adapter.detach()
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('keeps concurrent same-cwd proxy identities on their own rollouts', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-proxy-siblings-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const alphaId = '00000000-0000-4000-8000-000000000154'
    const betaId = '00000000-0000-4000-8000-000000000155'
    const alphaPath = writeRollout({ codexHome, filenameThreadId: alphaId })
    const betaPath = writeRollout({ codexHome, filenameThreadId: betaId })
    const alpha = new CodexHeadless({ pty: inertPty(), cwd: '/fixture/project-1' })
    const beta = new CodexHeadless({ pty: inertPty(), cwd: '/fixture/project-1' })
    const alphaProxy = proxyEmitter()
    const betaProxy = proxyEmitter()
    const alphaAdapter = new CodexResponsesAdapter(alphaProxy, alpha)
    const betaAdapter = new CodexResponsesAdapter(betaProxy, beta)

    try {
      alphaAdapter.attach()
      betaAdapter.attach()
      await Promise.all([alpha.start(), beta.start()])
      emitRecordedIdentity(alphaProxy, alphaId)
      emitRecordedIdentity(betaProxy, betaId)

      expect(await waitFor(() =>
        activeRolloutPath(alpha) === alphaPath &&
        activeRolloutPath(beta) === betaPath,
      )).toBe(true)

      // A later conflicting carrier must not switch an already-proven pane.
      emitRecordedIdentity(alphaProxy, betaId)
      emitRecordedIdentity(betaProxy, alphaId)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(activeRolloutPath(alpha)).toBe(alphaPath)
      expect(activeRolloutPath(beta)).toBe(betaPath)
    } finally {
      alphaAdapter.detach()
      betaAdapter.detach()
      await Promise.all([alpha.stop(), beta.stop()])
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it('bounds distinct identity lookups while allowing a later repeated proof', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-proxy-bounded-'))
    temporaryDirectories.push(codexHome)
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const headless = new CodexHeadless({
      pty: inertPty(),
      cwd: '/fixture/project-1',
    })

    try {
      await headless.start()
      for (let index = 1; index <= 100; index += 1) {
        headless.observeProviderThreadIdentity(
          `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        )
      }

      // WHY inspect only the queue cardinality, not private rollout paths: the
      // security contract is bounded admitted work. The production loop awaits
      // each locator before advancing, so at most these two retained ids can
      // own one active plus one waiting recursive tree scan.
      expect(providerIdentityQueueSize(headless)).toBeLessThanOrEqual(2)
      expect(await waitFor(() => providerIdentityQueueSize(headless) === 0))
        .toBe(true)

      const realId = '20000000-0000-4000-8000-000000000001'
      const rolloutPath = writeRollout({
        codexHome,
        filenameThreadId: realId,
      })
      headless.observeProviderThreadIdentity(realId)
      expect(await waitFor(() => activeRolloutPath(headless) === rolloutPath))
        .toBe(true)
    } finally {
      await headless.stop()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })
})
