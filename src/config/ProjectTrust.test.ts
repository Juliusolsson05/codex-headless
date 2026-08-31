// ProjectTrust — append-only, idempotent, format-preserving, fail-open.
//
// The realistic fixture below mirrors the SHAPE of a live, organically-grown
// ~/.codex/config.toml verified on 2026-08-31 (top-level settings, comments,
// then a run of [projects."…"] tables separated by blank lines) with neutral
// paths substituted. Byte-identity assertions are the point: the file is
// user-owned, and "we only ever append" is the contract that makes this
// feature safe to run before every spawn (agent-code#714).

import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { ensureCodexProjectTrust } from './ProjectTrust.js'

const REALISTIC_CONFIG = `# personal codex config
model = "gpt-5"
approval_policy = "on-request"

[projects."/Users/someone"]
trust_level = "trusted"

[projects."/Users/someone/Desktop/Development/alpha"]
trust_level = "trusted"

[projects."/Users/someone/Desktop/Development/beta"]
trust_level = "trusted"
`

async function harness(initial: string | null): Promise<{ configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-trust-'))
  const configPath = join(dir, 'config.toml')
  if (initial !== null) await writeFile(configPath, initial, 'utf8')
  return { configPath }
}

describe('ensureCodexProjectTrust', () => {
  it('appends exactly one table and leaves every existing byte alone', async () => {
    const { configPath } = await harness(REALISTIC_CONFIG)
    const result = await ensureCodexProjectTrust(
      '/Users/someone/Desktop/Development/fresh-project',
      { configPath },
    )
    expect(result).toBe('trusted-appended')
    const next = await readFile(configPath, 'utf8')
    // Prefix byte-identity IS the append-only contract.
    expect(next.startsWith(REALISTIC_CONFIG)).toBe(true)
    expect(next.slice(REALISTIC_CONFIG.length)).toBe(
      '\n[projects."/Users/someone/Desktop/Development/fresh-project"]\n' +
      'trust_level = "trusted"\n',
    )
  })

  it('is idempotent — a second ensure is byte-for-byte a no-op', async () => {
    const { configPath } = await harness(REALISTIC_CONFIG)
    await ensureCodexProjectTrust('/tmp/idempotent-project', { configPath })
    const afterFirst = await readFile(configPath, 'utf8')
    const result = await ensureCodexProjectTrust('/tmp/idempotent-project', { configPath })
    expect(result).toBe('already-configured')
    expect(await readFile(configPath, 'utf8')).toBe(afterFirst)
  })

  it('never modifies an existing entry, whatever its trust level says', async () => {
    // An explicit non-trusted decision is the user's; upgrading it behind
    // their back would turn a convenience into a consent bypass.
    const config = `[projects."/tmp/declined-project"]\ntrust_level = "untrusted"\n`
    const { configPath } = await harness(config)
    const result = await ensureCodexProjectTrust('/tmp/declined-project', { configPath })
    expect(result).toBe('already-configured')
    expect(await readFile(configPath, 'utf8')).toBe(config)
  })

  it('creates the config (and its directory) on a fresh machine', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-trust-'))
    const configPath = join(dir, 'nested', 'config.toml')
    const result = await ensureCodexProjectTrust('/tmp/first-ever-project', { configPath })
    expect(result).toBe('trusted-appended')
    expect(await readFile(configPath, 'utf8')).toBe(
      '[projects."/tmp/first-ever-project"]\ntrust_level = "trusted"\n',
    )
  })

  it('stands down on an inline projects table — appending would break codex startup', async () => {
    const config = `projects = { "/tmp/inline" = { trust_level = "trusted" } }\n`
    const { configPath } = await harness(config)
    const result = await ensureCodexProjectTrust('/tmp/another-project', { configPath })
    expect(result).toBe('skipped-inline-projects')
    expect(await readFile(configPath, 'utf8')).toBe(config)
  })

  it('escapes quotes and backslashes in the path key', async () => {
    const { configPath } = await harness('')
    const cwd = '/tmp/we"ird\\name'
    const result = await ensureCodexProjectTrust(cwd, { configPath })
    expect(result).toBe('trusted-appended')
    const next = await readFile(configPath, 'utf8')
    expect(next).toBe(
      '[projects."/tmp/we\\"ird\\\\name"]\ntrust_level = "trusted"\n',
    )
    // And the escaped form must be recognized on the next run — otherwise
    // every spawn in such a folder appends a duplicate table.
    expect(await ensureCodexProjectTrust(cwd, { configPath })).toBe('already-configured')
  })

  it('repairs a file missing its trailing newline before appending', async () => {
    const config = `model = "gpt-5"` // no trailing newline
    const { configPath } = await harness(config)
    await ensureCodexProjectTrust('/tmp/newline-project', { configPath })
    const next = await readFile(configPath, 'utf8')
    expect(next).toBe(
      'model = "gpt-5"\n\n[projects."/tmp/newline-project"]\ntrust_level = "trusted"\n',
    )
  })

  it('strips a trailing separator so the key matches organic entries', async () => {
    const { configPath } = await harness('')
    await ensureCodexProjectTrust('/tmp/slash-project/', { configPath })
    expect(await readFile(configPath, 'utf8')).toContain(
      '[projects."/tmp/slash-project"]',
    )
    expect(
      await ensureCodexProjectTrust('/tmp/slash-project', { configPath }),
    ).toBe('already-configured')
  })

  it('fails open when the config cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-trust-'))
    // A DIRECTORY at the config path makes readFile fail with EISDIR — the
    // "anything but ENOENT" branch: we cannot know the content, so we must
    // not write.
    const configPath = dir
    const result = await ensureCodexProjectTrust('/tmp/whatever', { configPath })
    expect(result).toBe('skipped-error')
  })
})
