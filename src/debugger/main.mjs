// Debugger main process — spawns Codex in a PTY, attaches a
// HeadlessTerminal, runs parsers on every frame, sends both raw PTY
// data + parser output to the renderer, and automatically records
// every session to disk.
//
// Every spawn (including resets) creates a new recording directory
// under recordings/<timestamp>/. No manual toggle — if the debugger
// is running, it's recording.
//
// Usage: npm run debugger
//        CC_SHELL_CWD=/some/dir npm run debugger

import { app, BrowserWindow, ipcMain } from 'electron'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { createWriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import xtermHeadless from '@xterm/headless'

const { Terminal } = xtermHeadless
const __dirname = dirname(fileURLToPath(import.meta.url))

// Use cc-shell's electron-rebuilt node-pty.
const require2 = createRequire(import.meta.url)
const ccShellRoot = join(__dirname, '..', '..', '..')
const { spawn: ptySpawn } = require2(join(ccShellRoot, 'node_modules', 'node-pty'))

// Resolve config once at startup.
const cwd = process.env.CC_SHELL_CWD || process.cwd()
let binary = process.env.CC_SHELL_CODEX_BINARY || 'codex'
try {
  const resolved = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()
  if (resolved) binary = resolved
} catch { /* fall through */ }

// --- Inlined parsers (can't import .ts from .mjs) ---

const CODEX_ASSISTANT_MARKER_RE = /^\s*(?:\*{1,3})?[•◦](?:\*{1,3})?\s?/
const CODEX_WORKING_RE = /^\s*(?:\*{1,3})?[•◦](?:\*{1,3})?\s+Working\s*\(/
const CODEX_TREE_MARKER_RE = /^\s*[│└]/
const CODEX_SPINNER_RE = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/
const CODEX_ESC_HINT_RE = /esc to interrupt/
const CODEX_PROMPT_RE = /^\s*(?:\*{1,3})?›(?:\*{1,3})?\s*$/
const CODEX_USER_PROMPT_RE = /^\s*(?:\*{1,3})?›(?:\*{1,3})?\s+\S/
const BOX_CHARS_RE = /[╭╮╰╯─│┌┐└┘├┤┬┴┼━┃═║]/g
const CODEX_STATUS_MARKERS = ['gpt-', '/model', '/fast']
const TRUST_MARKERS = ['Do you trust the contents of this directory', 'Yes, continue', 'No, quit']

function isDivider(line) {
  const d = (line.match(/[─━═▔]/g) ?? []).length
  return d >= 10 && d >= line.replace(/\s/g, '').length * 0.8
}
function isChrome(line) {
  if (line.trim() === '') return true
  if (isDivider(line)) return true
  if (CODEX_PROMPT_RE.test(line)) return true
  if (CODEX_STATUS_MARKERS.some(m => line.includes(m))) return true
  if (line.replace(BOX_CHARS_RE, '').trim().length === 0) return true
  return false
}
function isIntermediate(line) {
  return CODEX_TREE_MARKER_RE.test(line) || CODEX_SPINNER_RE.test(line) ||
    CODEX_WORKING_RE.test(line) || CODEX_ESC_HINT_RE.test(line)
}
function isTrustDialog(screen) {
  return TRUST_MARKERS.every(m => screen.includes(m))
}
function extractStreaming(screen) {
  if (!screen || isTrustDialog(screen)) return ''
  const lines = screen.split('\n')
  let cutFrom = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isChrome(lines[i] ?? '')) cutFrom = i; else break
  }
  const head = lines.slice(0, cutFrom)
  while (head.length > 0 && isChrome(head[head.length - 1] ?? '')) head.pop()
  let start = 0
  while (start < head.length && (head[start] ?? '').trim() === '') start++
  return head.slice(start).join('\n')
}
function extractAssistant(screen) {
  const stripped = extractStreaming(screen)
  if (!stripped) return ''
  const allLines = stripped.split('\n')
  const lines = allLines.filter(l => !isIntermediate(l))
  let lastIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CODEX_ASSISTANT_MARKER_RE.test(lines[i] ?? '')) { lastIdx = i; break }
  }
  if (lastIdx === -1) {
    const w = allLines.find(l => CODEX_WORKING_RE.test(l))
    if (w) { const m = w.match(/Working\s*\((\d+)s/); return m ? `working… ${m[1]}s` : 'working…' }
    return ''
  }
  let endIdx = lines.length
  for (let i = lastIdx + 1; i < lines.length; i++) {
    if (CODEX_USER_PROMPT_RE.test(lines[i] ?? '')) { endIdx = i; break }
  }
  const block = lines.slice(lastIdx, endIdx)
  block[0] = (block[0] ?? '').replace(CODEX_ASSISTANT_MARKER_RE, '')
  while (block.length > 0 && ((block[block.length - 1] ?? '').trim() === '' || isDivider(block[block.length - 1] ?? ''))) block.pop()
  return block.map(l => l.replace(/[ \t]+$/, '')).join('\n')
}

// --- Global state ---

let win = null
let pty = null
let term = null

// Recording streams for the current session.
let recording = {
  dir: null,
  rawEvents: null,   // WriteStream for raw.events.jsonl
  snapshots: null,    // WriteStream for snapshots.jsonl
  parserLog: null,    // WriteStream for parser.jsonl
  lastSnapshot: '',   // dedup screen snapshots
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

function snapshotScreen() {
  if (!term) return ''
  const buf = term.buffer.active
  const lines = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

// --- Recording lifecycle ---

async function startRecording() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(__dirname, '..', '..', 'recordings', ts)
  await mkdir(dir, { recursive: true })

  const meta = {
    startedAt: new Date().toISOString(),
    cwd, binary,
    cols: 120, rows: 40,
  }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))

  recording = {
    dir,
    rawEvents: createWriteStream(join(dir, 'raw.events.jsonl'), { flags: 'a' }),
    snapshots: createWriteStream(join(dir, 'snapshots.jsonl'), { flags: 'a' }),
    parserLog: createWriteStream(join(dir, 'parser.jsonl'), { flags: 'a' }),
    lastSnapshot: '',
  }

  console.log(`[debugger] recording to ${dir}`)
  send('recording-path', dir)
}

function stopRecording() {
  if (recording.rawEvents) { recording.rawEvents.end(); recording.rawEvents = null }
  if (recording.snapshots) { recording.snapshots.end(); recording.snapshots = null }
  if (recording.parserLog) { recording.parserLog.end(); recording.parserLog = null }
  if (recording.dir) console.log(`[debugger] recording saved: ${recording.dir}`)
  recording.dir = null
}

function recordRawEvent(data) {
  recording.rawEvents?.write(JSON.stringify({ ts: Date.now(), data }) + '\n')
}

function recordSnapshot(screen) {
  if (screen === recording.lastSnapshot) return
  recording.lastSnapshot = screen
  recording.snapshots?.write(JSON.stringify({ ts: Date.now(), text: screen }) + '\n')
}

function recordParserOutput(parserData) {
  recording.parserLog?.write(JSON.stringify({ ts: Date.now(), ...parserData }) + '\n')
}

// --- Session lifecycle (spawn + wire events) ---

let flushTimer = null
let trustAccepted = false

function spawnSession() {
  trustAccepted = false

  term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 10000 })

  pty = ptySpawn(binary, [], {
    name: 'xterm-256color',
    cols: 120, rows: 40, cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  })

  console.log(`[debugger] spawned: ${binary} in ${cwd}`)

  pty.onData(data => {
    send('pty-data', data)
    term.write(data)
    recordRawEvent(data)

    // Throttled parser run at 10 Hz
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        const screen = snapshotScreen()
        recordSnapshot(screen)

        const streaming = extractStreaming(screen)
        const assistant = extractAssistant(screen)
        const hasTrustDialog = isTrustDialog(screen)
        const hasWorking = CODEX_WORKING_RE.test(screen)
        const hasSpinner = CODEX_SPINNER_RE.test(screen)
        const hasAssistantMarker = CODEX_ASSISTANT_MARKER_RE.test(screen)
        const hasPrompt = CODEX_PROMPT_RE.test(screen)

        // Auto-accept trust dialog
        if (hasTrustDialog && !trustAccepted) {
          trustAccepted = true
          console.log('[debugger] trust dialog — auto-accepting')
          pty.write('\r')
        }

        const parserData = {
          streaming,
          assistant,
          state: {
            hasTrustDialog,
            hasWorking,
            hasSpinner,
            hasAssistantMarker,
            hasPrompt,
            idle: !hasTrustDialog && !hasWorking && !hasSpinner && hasPrompt,
          },
        }

        recordParserOutput(parserData)
        send('parser-update', { screen, ...parserData })
      }, 100)
    }
  })

  pty.onExit(({ exitCode, signal }) => {
    console.log(`[debugger] codex exited: code=${exitCode} signal=${signal ?? '-'}`)
    send('pty-exit', { exitCode, signal })
  })
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1400, height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  win.loadFile(join(__dirname, 'index.html'))

  await startRecording()
  spawnSession()

  // Input from renderer → PTY
  ipcMain.on('pty-input', (_evt, data) => {
    pty?.write(data)
  })

  ipcMain.on('pty-resize', (_evt, { cols, rows }) => {
    try { pty?.resize(cols, rows); term?.resize(cols, rows) }
    catch { /* transient */ }
  })

  // Reset: stop current recording, kill codex, start fresh
  ipcMain.on('pty-reset', async () => {
    console.log('[debugger] reset')
    try { pty?.kill() } catch { /* already gone */ }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    stopRecording()
    await startRecording()
    spawnSession()
  })
})

app.on('window-all-closed', () => {
  try { pty?.kill() } catch { /* already gone */ }
  stopRecording()
  app.quit()
})
