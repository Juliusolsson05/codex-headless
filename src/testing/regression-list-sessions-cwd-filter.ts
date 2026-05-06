#!/usr/bin/env tsx
//
// Regression test for the "Codex resume picker eats the prompt" bug.
//
// Symptom: a user resuming a Codex session from cc-shell saw the
// optimistic user message in the feed but never got an assistant
// reply — streamPhase stuck at 'submitting' forever, screen sat at
// the empty Codex composer.
//
// Root cause was upstream: when Codex resumes with `cwd != session
// cwd` it opens a blocking `cwd_prompt` modal (Choose working
// directory…) that explicitly drops bracketed-paste events. The
// trailing `\r` of cc-shell's submit then selected the default
// option and the user's text was thrown away.
//
// But the only reason cc-shell ever sent a prompt into that modal
// was that this lister returned a global session list when the
// caller asked for sessions in a specific cwd — so the user picked
// what looked like a "current project" session and it was actually
// recorded somewhere else. This test pins that filter behavior so
// we can't regress it back to global.
//
// We don't spin up a real CodexHeadless here — we just need the
// pure file-walking lister. CODEX_HOME is repointed at a temp dir
// containing fake rollout-*.jsonl files; the lister reads HEAD
// bytes and filters by session_meta.cwd.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'codex-list-cwd-'))
  // Set CODEX_HOME BEFORE importing SessionList — getCodexSessionsDir()
  // captures it lazily on each call so an env mutation during the test
  // is fine, but a static import order keeps the intent obvious.
  process.env.CODEX_HOME = tmp
  const { listCodexSessions } = await import('../transcript/SessionList.js')

  const sessionsDir = join(tmp, 'sessions', '2026', '04', '25')
  await mkdir(sessionsDir, { recursive: true })

  const cwdA = '/Users/example/project-a'
  const cwdB = '/Users/example/project-b'

  // Three rollouts: two in project-a, one in project-b. Filenames
  // need to satisfy ROLLOUT_RE in SessionList.ts so the walker
  // accepts them.
  const fixtures = [
    {
      file: 'rollout-2026-04-25T10-00-00-aaaaaaaa-0000-4000-8000-000000000001.jsonl',
      cwd: cwdA,
      summary: 'first prompt in project-a',
    },
    {
      file: 'rollout-2026-04-25T11-00-00-aaaaaaaa-0000-4000-8000-000000000002.jsonl',
      cwd: cwdB,
      summary: 'first prompt in project-b',
    },
    {
      file: 'rollout-2026-04-25T12-00-00-aaaaaaaa-0000-4000-8000-000000000003.jsonl',
      cwd: cwdA,
      summary: 'second prompt in project-a',
    },
  ]

  for (const f of fixtures) {
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-25T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: f.file.match(/-([0-9a-f-]{36})\.jsonl$/i)?.[1] ?? 'x',
          timestamp: '2026-04-25T10:00:00.000Z',
          cwd: f.cwd,
          originator: 'codex-tui',
          cli_version: '0.0.0-test',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-25T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: f.summary },
      }),
    ]
    await writeFile(join(sessionsDir, f.file), lines.join('\n') + '\n')
  }

  // No filter → all three rollouts come back. Preserves the pre-fix
  // behavior for callers (e.g. session:list-all) that explicitly want
  // a global listing.
  const all = await listCodexSessions({ limit: 50 })
  assert.equal(all.length, 3, 'unfiltered listCodexSessions must return all rollouts')

  // Filtered to project-a → only the two project-a rollouts.
  const onlyA = await listCodexSessions({ limit: 50, cwd: cwdA })
  assert.equal(onlyA.length, 2, `cwd=${cwdA} should return 2 rollouts`)
  for (const s of onlyA) {
    assert.equal(s.cwd, cwdA, `every result for cwd=${cwdA} must have meta.cwd === ${cwdA}`)
  }

  // Trailing slash and `..` segments resolve to the same path. This
  // is what `path.resolve` is for in the implementation; the test
  // anchors that contract so future "cleanups" can't drop it.
  const onlyAWithSlash = await listCodexSessions({ limit: 50, cwd: cwdA + '/' })
  assert.equal(onlyAWithSlash.length, 2, 'trailing slash must not change filter result')
  const onlyAViaDotDot = await listCodexSessions({
    limit: 50,
    cwd: '/Users/example/project-a/sub/..',
  })
  assert.equal(onlyAViaDotDot.length, 2, '/.. segments must not change filter result')

  // Non-matching cwd → empty list. This is the load-bearing
  // assertion: the resume picker, given a project the user has never
  // used Codex in, must NOT return rollouts from other projects.
  const onlyC = await listCodexSessions({ limit: 50, cwd: '/Users/example/project-c' })
  assert.equal(onlyC.length, 0, 'unknown cwd must return zero rollouts')

  await rm(tmp, { recursive: true, force: true })
  // eslint-disable-next-line no-console
  console.log('regression-list-sessions-cwd-filter: ok')
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
