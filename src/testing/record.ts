#!/usr/bin/env tsx
/**
 * testing/record.ts — capture a Codex session for offline analysis.
 *
 * Spawns `codex` in a PTY, attaches a HeadlessTerminal, bridges
 * stdin/stdout, and records every event to disk.
 *
 * Usage:
 *   npx tsx src/testing/record.ts                       # interactive
 *   CODEX_HEADLESS_SCRIPT=src/testing/scripts/hello.json \ # scripted
 *     npx tsx src/testing/record.ts
 *
 * Env vars:
 *   CODEX_HEADLESS_CWD      — override working directory
 *   CODEX_HEADLESS_BINARY   — override binary (default: `codex`)
 *   CODEX_HEADLESS_SCRIPT   — path to a JSON script for headless mode
 *
 * The old CC_SHELL_* names are still accepted as compatibility aliases.
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'
import { spawn as ptySpawn } from 'node-pty'

import { HeadlessTerminal } from '../terminal/HeadlessTerminal.js'

// --- Script types ---

type ScriptStep =
  | { type: 'wait'; ms: number }
  | { type: 'send'; data: string }

type Script = { steps: ScriptStep[] }

async function loadScript(path: string): Promise<Script> {
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text) as Script
  if (!Array.isArray(parsed.steps)) throw new Error(`script ${path} has no "steps" array`)
  return parsed
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function main(): Promise<void> {
  const scriptPath = process.env.CODEX_HEADLESS_SCRIPT ?? process.env.CC_SHELL_SCRIPT
  const scripted = !!scriptPath
  const script: Script | null = scripted ? await loadScript(scriptPath!) : null

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const recordingDir = join('recordings', ts)
  await mkdir(recordingDir, { recursive: true })

  const cwd = process.env.CODEX_HEADLESS_CWD ?? process.env.CC_SHELL_CWD ?? process.cwd()
  const binary = process.env.CODEX_HEADLESS_BINARY ?? process.env.CC_SHELL_CODEX_BINARY ?? 'codex'
  const cols = process.stdout.columns ?? 120
  const rows = process.stdout.rows ?? 40

  const meta = {
    startedAt: new Date().toISOString(),
    cwd, cols, rows, binary,
    mode: scripted ? 'scripted' : 'interactive',
    scriptPath: scriptPath ?? null,
  }
  await writeFile(join(recordingDir, 'meta.json'), JSON.stringify(meta, null, 2))

  const rawStream = createWriteStream(join(recordingDir, 'raw.txt'), { flags: 'a' })
  const rawEventsStream = createWriteStream(join(recordingDir, 'raw.events.jsonl'), { flags: 'a' })
  const snapshotsStream = createWriteStream(join(recordingDir, 'snapshots.jsonl'), { flags: 'a' })

  const pty = ptySpawn(binary, [], {
    name: 'xterm-256color',
    cols, rows, cwd,
    env: { ...process.env as Record<string, string>, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  })

  const terminal = new HeadlessTerminal({ pty, cols, rows, snapshotIntervalMs: 16 })

  pty.onData((data: string) => {
    if (!scripted) process.stdout.write(data)
    rawStream.write(data)
    rawEventsStream.write(JSON.stringify({ ts: Date.now(), data }) + '\n')
  })

  let lastSnapshot = ''
  terminal.on('screen', snap => {
    if (snap.plain === lastSnapshot) return
    lastSnapshot = snap.plain
    snapshotsStream.write(JSON.stringify({ ts: Date.now(), text: snap.plain }) + '\n')
  })

  terminal.on('exit', ({ exitCode, signal }) => {
    process.stderr.write(`\n[record] codex exited (code=${exitCode}, signal=${signal ?? '-'})\n`)
    void shutdown(exitCode ?? 0)
  })

  if (!scripted) {
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', chunk => {
      if (chunk.length === 1 && chunk[0] === 0x11) {
        process.stderr.write('\n[record] Ctrl-Q — stopping\n')
        void shutdown(0)
        return
      }
      terminal.write(chunk.toString('utf8'))
    })
    process.stdout.on('resize', () => {
      terminal.resize(process.stdout.columns ?? 120, process.stdout.rows ?? 40)
    })
  }

  let shuttingDown = false
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    try { pty.kill() } catch { /* already gone */ }
    terminal.dispose()
    rawStream.end()
    rawEventsStream.end()
    snapshotsStream.end()
    process.stderr.write(`[record] saved to ${recordingDir}\n`)
    process.exit(code)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  process.stderr.write(`[record] writing to ${recordingDir}\n\n`)

  if (scripted && script) {
    process.stderr.write(`[record] running ${script.steps.length} steps\n`)
    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i]
      if (step.type === 'wait') {
        process.stderr.write(`[record] step ${i + 1}: wait ${step.ms}ms\n`)
        await sleep(step.ms)
      } else {
        const preview = step.data.replace(/[\r\n]/g, '⏎').slice(0, 60)
        process.stderr.write(`[record] step ${i + 1}: send ${preview}\n`)
        terminal.write(step.data)
      }
    }
    process.stderr.write('[record] script complete\n')
    await shutdown(0)
  }
}

main().catch(err => { console.error('[record] fatal:', err); process.exit(1) })
