#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import * as pty from 'node-pty'

import { HeadlessTerminal } from '../src/terminal/HeadlessTerminal.js'
import type { StableTerminalFrame } from '../src/terminal/HeadlessTerminal.js'

type InputCase = {
  id: string
  configOverrides?: string[]
  lowerLayerConfig?: string[]
  trusted?: boolean
  initialCols?: number
  initialRows?: number
  workspaceSuffix?: string
  inputChunks: string[]
  expectedSubmission: boolean
  expectedDurableText?: string
  startupOnly?: boolean
  expectedStartupFailure?: RegExp
  waitForPopup?: RegExp
  popupAfterChunk?: number
  waitBeforeFinal?: RegExp
  setup?: (session: LiveSession) => Promise<Record<string, unknown>>
  afterDraft?: (session: LiveSession) => Promise<Record<string, unknown>>
}

type CapturedRequest = {
  body: unknown
  receivedAt: number
}

type LiveSession = {
  terminal: pty.IPty
  mirror: HeadlessTerminal
  codexHome: string
  workspace: string
  workspaceRoot: string
  workspaceSuffix?: string
  requests: CapturedRequest[]
  rawPtyChunks: string[]
  exitOutcome: { exitCode: number; signal?: number } | null
}

const CODEX_BINARY = process.env.CODEX_BINARY ?? '/Users/juliusolsson/.local/bin/codex'
const TIMEOUT_MS = Number(process.env.CODEX_INPUT_RECORD_TIMEOUT_MS ?? 20_000)
const COLS = 140
const ROWS = 42
// These are the exact final session-layer arguments issued by
// CodexPromptInputProfile. The conflict recording must exercise the production
// launch contract as one unit: selectively omitting an override could make a
// lower-layer map appear safe even though the real spawn is rejected.
const ISSUED_PROMPT_INPUT_OVERRIDES = [
  'tui.keymap.composer.submit="enter"',
  'tui.keymap.composer.queue="tab"',
  'tui.vim_mode_default=false',
  'tui.keymap.global.toggle_vim_mode=[]',
] as const
// WHY this exact minimal stream is copied from rust-v0.149.1's
// app-server-test-client loopback server rather than the fixture file in the
// currently checked-out vendor tree: the vendor checkout is an older reference
// commit and its response.completed shape is rejected by installed 0.149.1.
// Keeping the event body here also makes the committed recording name the exact
// provider response whose SHA it reports.
const fixtureSse = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp-recorded-input"}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp-recorded-input","usage":{"input_tokens":0,"input_tokens_details":null,"output_tokens":0,"output_tokens_details":null,"total_tokens":0}}}',
  '',
  '',
].join('\n')
const binary = await readFile(CODEX_BINARY)
const binarySha256 = sha256(binary)
const cliVersion = await binaryVersion()
const requests: CapturedRequest[] = []
let releaseSlowResponse: (() => void) | null = null

const server = createServer(async (req, res) => {
  await serveFixture(req, res)
})
const port = await new Promise<number>((resolvePort, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      reject(new Error('Fixture server did not expose a TCP port'))
      return
    }
    resolvePort(address.port)
  })
})
const providerBaseUrl = `http://127.0.0.1:${port}/v1`

const allCases: InputCase[] = [
  {
    id: 'trust-action-then-submit',
    trusted: false,
    inputChunks: ['RECORDED_TRUST_PROMPT', '\r'],
    expectedSubmission: true,
    expectedDurableText: 'RECORDED_TRUST_PROMPT',
    setup: async session => {
      await waitForScreen(session, screen =>
        screen.includes('Do you trust the contents of this directory'),
      )
      const modal = structuralScreen(session)
      await delay(300)
      session.terminal.write('1')
      await waitForComposer(session)
      return { nonComposerWrites: ['1'], modal }
    },
  },
  {
    id: 'combining-grapheme-backspace',
    inputChunks: ['A e\u0301', '\x7f', 'X', '\r'],
    expectedSubmission: true,
    expectedDurableText: 'A X',
  },
  {
    id: 'mixed-cjk-ctrl-w',
    inputChunks: ['abc 世界def', '\x17', 'X', '\r'],
    expectedSubmission: true,
    expectedDurableText: 'abc 世界X',
  },
  {
    id: 'repeated-line-boundaries',
    inputChunks: [
      '\x1b[200~one\ntwo\x1b[201~',
      '\x01',
      '\x01',
      'X',
      '\x05',
      '\x05',
      'Y',
      '\r',
    ],
    expectedSubmission: true,
    expectedDurableText: 'Xone\ntwoY',
  },
  {
    id: 'remapped-kill-line-start',
    configOverrides: ['tui.keymap.editor.kill_line_start="alt-u"'],
    inputChunks: ['abc def', '\x15', 'X', '\r'],
    expectedSubmission: true,
    expectedDurableText: 'abc defX',
  },
  {
    id: 'vim-normal-default',
    configOverrides: ['tui.vim_mode_default=true'],
    inputChunks: ['i', 'abc', '\r'],
    expectedSubmission: true,
    expectedDurableText: 'abc',
  },
  {
    id: 'unbound-submit-enter',
    configOverrides: ['tui.keymap.composer.submit=[]'],
    inputChunks: ['UNBOUND_SUBMIT', '\r'],
    expectedSubmission: false,
  },
  {
    id: 'modal-ctrl-c-preserves-draft',
    inputChunks: ['recorded prefix ', '\x12', '\x03', 'suffix', '\r'],
    expectedSubmission: true,
    expectedDurableText: 'recorded prefix suffix',
    waitForPopup: /reverse-i-search:/i,
    popupAfterChunk: 1,
  },
  {
    id: 'tab-footer-spoof-skill-popup',
    inputChunks: ['literal tab to queue $recorded_evi', '\t'],
    expectedSubmission: false,
    waitForPopup: /Plugin|Skill|App/i,
  },
  {
    id: 'active-footer-tab-queue',
    inputChunks: ['RECORDED_QUEUED_PROMPT', '\t'],
    expectedSubmission: true,
    expectedDurableText: 'RECORDED_QUEUED_PROMPT',
    waitBeforeFinal: /tab to queue/i,
    setup: async session => {
      const before = await readDurableUserTexts(session.codexHome)
      session.terminal.write('RECORDED_SLOW_TURN')
      await delay(750)
      session.terminal.write('\r')
      await waitFor(async () => {
        const values = await readDurableUserTexts(session.codexHome)
        return values.length > before.length
      }, 'slow setup prompt to become durable')
      await waitForScreen(session, screen => screen.includes('Working ('))
      return { activeTurnFooter: structuralScreen(session) }
    },
  },
  {
    id: 'narrow-soft-wrap-resize-redraw',
    initialCols: 52,
    initialRows: 24,
    inputChunks: [
      'RECORDED_NARROW_WRAP alpha beta gamma delta epsilon zeta eta theta iota kappa omega',
      '\r',
    ],
    expectedSubmission: true,
    expectedDurableText: 'RECORDED_NARROW_WRAP alpha beta gamma delta epsilon zeta eta theta iota kappa omega',
    setup: async session => {
      await waitForPtyQuiet(session)
      const frame = session.mirror.snapshotStableFrame()
      if (!frame) throw new Error('missing complete composer frame before narrow input')
      return { beforeTypingFrame: structuralStableFrame(session, frame) }
    },
    afterDraft: async session => recordResizeBoundary(session, 92, 24),
  },
  {
    id: 'unchanged-redraw-after-edit',
    inputChunks: ['\r'],
    expectedSubmission: true,
    expectedDurableText: 'RECORDED_UNCHANGED_BASE_EDIT',
    setup: async session => recordUnchangedRedrawAfterEdit(
      session,
      '_EDIT',
    ),
  },
  {
    id: 'ordinary-modal-sentinel-draft',
    inputChunks: [
      'ORDINARY_DRAFT Do you trust the contents of this directory? Press enter to continue END',
      '\r',
    ],
    expectedSubmission: true,
    expectedDurableText:
      'ORDINARY_DRAFT Do you trust the contents of this directory? Press enter to continue END',
  },
  {
    id: 'ordinary-vim-sentinel-cwd',
    workspaceSuffix: 'Vim: Insert',
    inputChunks: ['ORDINARY_VIM_SENTINEL_CWD', '\r'],
    expectedSubmission: true,
    expectedDurableText: 'ORDINARY_VIM_SENTINEL_CWD',
  },
  {
    id: 'lower-layer-keymap-valid-control',
    lowerLayerConfig: [
      '[tui.keymap.composer]',
      'queue = []',
      'toggle_shortcuts = "tab"',
    ],
    inputChunks: [],
    expectedSubmission: false,
    startupOnly: true,
  },
  {
    id: 'lower-layer-keymap-issued-profile-conflict',
    lowerLayerConfig: [
      '[tui.keymap.composer]',
      'queue = []',
      'toggle_shortcuts = "tab"',
    ],
    configOverrides: [...ISSUED_PROMPT_INPUT_OVERRIDES],
    inputChunks: [],
    expectedSubmission: false,
    startupOnly: true,
    expectedStartupFailure: /composer\.queue.*composer\.toggle_shortcuts|composer\.toggle_shortcuts.*composer\.queue/i,
  },
]
const requestedCases = new Set(
  (process.env.CODEX_INPUT_RECORD_CASES ?? '').split(',').filter(Boolean),
)
const cases = requestedCases.size === 0
  ? allCases
  : allCases.filter(inputCase => requestedCases.has(inputCase.id))

const output: Record<string, unknown>[] = []
try {
  for (const inputCase of cases) {
    const session = await startSession(inputCase)
    try {
      const beforeStartupUsers = await readDurableUserTexts(session.codexHome)
      const beforeStartupRequests = session.requests.length

      if (inputCase.expectedStartupFailure) {
        await waitFor(() => {
          const screen = session.mirror.snapshotPlain()
          return inputCase.expectedStartupFailure!.test(screen) ||
            session.exitOutcome !== null
        }, `${inputCase.id} explicit startup failure`)
        // The terminal mirror remains readable after process exit. Waiting one
        // event-loop turn retains the provider's final error paint rather than
        // whichever partial ANSI chunk first happened to match the sentinel.
        await delay(100)
        const startupScreen = structuralScreen(session)
        if (!inputCase.expectedStartupFailure.test(startupScreen.join('\n'))) {
          throw new Error(
            `${inputCase.id} exited without the expected conflict: ` +
            JSON.stringify(startupScreen),
          )
        }
        const durableUserTexts = await readDurableUserTexts(session.codexHome)
        const requestCountDelta = session.requests.length - beforeStartupRequests
        if (durableUserTexts.length !== beforeStartupUsers.length || requestCountDelta !== 0) {
          throw new Error(`${inputCase.id} reached a provider boundary before startup rejection`)
        }
        const rawPtySha256 = sha256(session.rawPtyChunks.join(''))
        output.push({
          id: inputCase.id,
          sourceLabel: `recorded-source-${rawPtySha256.slice(0, 16)}`,
          rawPtySha256,
          rolloutSha256: await hashRolloutCorpus(session.codexHome),
          rawRequestSha256: null,
          configClass: 'lower-layer-plus-issued-cli-override',
          lowerLayerConfig: inputCase.lowerLayerConfig ?? [],
          configOverrides: inputCase.configOverrides ?? [],
          terminal: {
            cols: inputCase.initialCols ?? COLS,
            rows: inputCase.initialRows ?? ROWS,
          },
          inputChunks: [],
          expectedSubmission: false,
          durableUserText: null,
          requestUserText: null,
          requestCountDelta,
          startupOutcome: 'rejected-before-composer',
          exitOutcome: session.exitOutcome,
          startupScreen,
        })
        continue
      }

      if (inputCase.trusted ?? true) {
        await waitForComposer(session)
        // The first empty composer frame can precede the configured Vim-mode
        // transition by one redraw. Record only after the provider state is
        // stable; the startup-immediate delivery race has its own fixture.
        await delay(350)
      }

      if (inputCase.startupOnly) {
        const durableUserTexts = await readDurableUserTexts(session.codexHome)
        const requestCountDelta = session.requests.length - beforeStartupRequests
        if (durableUserTexts.length !== beforeStartupUsers.length || requestCountDelta !== 0) {
          throw new Error(`${inputCase.id} crossed a provider boundary during startup control`)
        }
        const rawPtySha256 = sha256(session.rawPtyChunks.join(''))
        output.push({
          id: inputCase.id,
          sourceLabel: `recorded-source-${rawPtySha256.slice(0, 16)}`,
          rawPtySha256,
          rolloutSha256: await hashRolloutCorpus(session.codexHome),
          rawRequestSha256: null,
          configClass: 'lower-layer-config',
          lowerLayerConfig: inputCase.lowerLayerConfig ?? [],
          configOverrides: inputCase.configOverrides ?? [],
          terminal: {
            cols: inputCase.initialCols ?? COLS,
            rows: inputCase.initialRows ?? ROWS,
          },
          inputChunks: [],
          expectedSubmission: false,
          durableUserText: null,
          requestUserText: null,
          requestCountDelta,
          startupOutcome: 'composer-ready',
          exitOutcome: session.exitOutcome,
          startupScreen: structuralScreen(session),
        })
        continue
      }

      const setup = await inputCase.setup?.(session) ?? {}
      const beforeUsers = await readDurableUserTexts(session.codexHome)
      const beforeRequests = session.requests.length
      let popup: string[] | undefined

      for (let index = 0; index < inputCase.inputChunks.length - 1; index += 1) {
        session.terminal.write(inputCase.inputChunks[index]!)
        // Raw node-pty writes are deliberately separated at the same scale as
        // real xterm onData events. Codex drops later keys while it is still
        // applying the previous render; collapsing this to one artificial burst
        // records PTY delivery loss, not editor semantics.
        await delay(750)
        if (process.env.CODEX_INPUT_RECORD_DEBUG === '1') {
          process.stderr.write(
            `${inputCase.id} chunk ${index}: ` +
            `${JSON.stringify(inputCase.inputChunks[index])} ` +
            `${JSON.stringify(structuralScreen(session))}\n`,
          )
        }
        if (inputCase.waitForPopup && inputCase.popupAfterChunk === index) {
          await waitForScreen(session, screen => inputCase.waitForPopup!.test(screen))
          popup = structuralScreen(session)
        }
      }
      if (inputCase.waitForPopup && inputCase.popupAfterChunk === undefined) {
        await waitForScreen(session, screen => inputCase.waitForPopup!.test(screen))
        popup = structuralScreen(session)
      }
      if (inputCase.waitBeforeFinal) {
        await waitForScreen(session, screen => inputCase.waitBeforeFinal!.test(screen))
      }
      const afterDraft = await inputCase.afterDraft?.(session) ?? {}
      // WHY this is an observed provider boundary, not arbitrary test sleep:
      // Codex 0.149.1 can still be coalescing the typed redraw when Enter lands
      // in the same burst. Agent Code's real xterm events have a human-scale
      // boundary; the separate startup-race fixture covers genuinely immediate
      // writes without pretending a provider-ignored Enter was a submission.
      await delay(300)
      const screenBeforeFinalWrite = structuralScreen(session)
      session.terminal.write(inputCase.inputChunks.at(-1)!)
      if (inputCase.id === 'active-footer-tab-queue') {
        await waitForScreen(session, screen =>
          screen.includes('Queued follow-up inputs') &&
          screen.includes('RECORDED_QUEUED_PROMPT'),
        )
        releaseSlowResponse?.()
        releaseSlowResponse = null
      }

      let durableUserText: string | null = null
      let requestUserText: string | null = null
      if (inputCase.expectedSubmission) {
        try {
          await waitFor(async () => {
            const values = await readDurableUserTexts(session.codexHome)
            if (values.length <= beforeUsers.length) return false
            durableUserText = values.at(-1) ?? null
            return true
          }, `${inputCase.id} durable user entry`)
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; ` +
            `last screen=${JSON.stringify(structuralScreen(session))}`,
          )
        }
        await waitFor(() => session.requests.length > beforeRequests,
          `${inputCase.id} fixture request`)
        requestUserText = extractLastRequestUserText(
          session.requests.at(-1)?.body,
        )
      } else {
        await delay(1_200)
        const afterUsers = await readDurableUserTexts(session.codexHome)
        if (afterUsers.length !== beforeUsers.length ||
          session.requests.length !== beforeRequests) {
          throw new Error(`${inputCase.id} unexpectedly submitted`)
        }
      }

      if (inputCase.expectedDurableText !== undefined &&
        (durableUserText !== inputCase.expectedDurableText ||
          requestUserText !== inputCase.expectedDurableText)) {
        throw new Error(
          `${inputCase.id} expected ${JSON.stringify(inputCase.expectedDurableText)} ` +
          `but rollout=${JSON.stringify(durableUserText)} ` +
          `request=${JSON.stringify(requestUserText)}`,
        )
      }

      const rawPtySha256 = sha256(session.rawPtyChunks.join(''))
      const rolloutSha256 = await hashRolloutCorpus(session.codexHome)
      const rawRequestSha256 = session.requests.length > beforeRequests
        ? sha256(JSON.stringify(session.requests.at(-1)!.body))
        : null
      output.push({
        id: inputCase.id,
        sourceLabel: `recorded-source-${rawPtySha256.slice(0, 16)}`,
        rawPtySha256,
        rolloutSha256,
        rawRequestSha256,
        configClass: inputCase.configOverrides?.length
          ? 'explicit-cli-override'
          : inputCase.lowerLayerConfig?.length
            ? 'lower-layer-config'
            : 'recorded-default-01491',
        lowerLayerConfig: inputCase.lowerLayerConfig ?? [],
        configOverrides: inputCase.configOverrides ?? [],
        terminal: {
          cols: inputCase.initialCols ?? COLS,
          rows: inputCase.initialRows ?? ROWS,
        },
        inputChunks: inputCase.inputChunks,
        expectedSubmission: inputCase.expectedSubmission,
        durableUserText,
        requestUserText,
        screenBeforeFinalWrite,
        popup,
        ...setup,
        ...afterDraft,
      })
    } finally {
      releaseSlowResponse?.()
      releaseSlowResponse = null
      try { session.terminal.kill() } catch { /* Provider may already have exited. */ }
      session.mirror.dispose()
      await rm(session.codexHome, { recursive: true, force: true })
      await rm(session.workspaceRoot, { recursive: true, force: true })
    }
  }
} finally {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  sanitizerVersion: 1,
  provider: {
    cliVersion,
    binarySha256,
    upstreamTag: 'rust-v0.149.1',
  },
  terminal: { cols: COLS, rows: ROWS },
  source: {
    kind: 'real-codex-tui-local-canned-responses',
    fixtureSseSha256: sha256(fixtureSse),
  },
  cases: output,
}, null, 2)}\n`)

async function startSession(inputCase: InputCase): Promise<LiveSession> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-input-home-'))
  const workspaceAlias = await mkdtemp(join(tmpdir(), 'codex-input-workspace-'))
  // WHY Codex realpaths cwd before matching `[projects]`. macOS exposes the
  // temp root through both /var and /private/var; recording the alias in config
  // silently leaves the supposedly trusted control cases on the trust modal.
  const workspaceRoot = await realpath(workspaceAlias)
  const workspace = inputCase.workspaceSuffix
    ? join(workspaceRoot, inputCase.workspaceSuffix)
    : workspaceRoot
  if (inputCase.workspaceSuffix) await mkdir(workspace, { recursive: true })
  await mkdir(join(codexHome, 'skills', 'recorded-evidence'), { recursive: true })
  await writeFile(
    join(codexHome, 'skills', 'recorded-evidence', 'SKILL.md'),
    '# Recorded evidence\n\nA harmless local fixture used only by the prompt-input recorder.\n',
  )
  const trusted = inputCase.trusted ?? true
  const config = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "low"',
    'model_provider = "recorded_fixture"',
    '',
    '[model_providers.recorded_fixture]',
    'name = "Recorded fixture"',
    `base_url = ${JSON.stringify(providerBaseUrl)}`,
    'wire_api = "responses"',
    'env_key = "RECORDED_FIXTURE_API_KEY"',
    '',
    ...(trusted ? [
      `[projects.${JSON.stringify(workspace)}]`,
      'trust_level = "trusted"',
      '',
    ] : []),
    ...(inputCase.lowerLayerConfig ?? []),
    ...(inputCase.lowerLayerConfig?.length ? [''] : []),
  ].join('\n')
  await writeFile(join(codexHome, 'config.toml'), config)

  const args = [
    '--sandbox', 'read-only',
    '--ask-for-approval', 'never',
    '--no-alt-screen',
  ]
  for (const override of inputCase.configOverrides ?? []) {
    args.push('-c', override)
  }
  const terminal = pty.spawn(CODEX_BINARY, args, {
    name: 'xterm-256color',
    cols: inputCase.initialCols ?? COLS,
    rows: inputCase.initialRows ?? ROWS,
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      RECORDED_FIXTURE_API_KEY: 'local-fixture-only',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>,
  })
  const mirror = new HeadlessTerminal({
    pty: terminal,
    cols: inputCase.initialCols ?? COLS,
    rows: inputCase.initialRows ?? ROWS,
    snapshotIntervalMs: 20,
  })
  const rawPtyChunks: string[] = []
  mirror.on('pty-data', data => { rawPtyChunks.push(data) })
  const session: LiveSession = {
    terminal,
    mirror,
    codexHome,
    workspace,
    workspaceRoot,
    workspaceSuffix: inputCase.workspaceSuffix,
    requests,
    rawPtyChunks,
    exitOutcome: null,
  }
  mirror.on('exit', outcome => { session.exitOutcome = outcome })
  mirror.attach()
  return session
}

async function serveFixture(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(req.url ?? '')) {
    res.statusCode = 404
    res.end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const bodyText = Buffer.concat(chunks).toString('utf8')
  const body = JSON.parse(bodyText) as unknown
  requests.push({ body, receivedAt: Date.now() })
  if (bodyText.includes('RECORDED_SLOW_TURN')) {
    // Keep the HTTP request pending before any SSE bytes are written. Splitting
    // an old canned stream at an arbitrary event boundary made exact 0.149.1
    // report an incomplete stream; holding the request itself preserves the
    // provider's real working/queue UI while the eventual response remains the
    // same independently validated complete fixture used by the control turns.
    await new Promise<void>(resolveRelease => { releaseSlowResponse = resolveRelease })
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.end(fixtureSse)
}

async function waitForComposer(session: LiveSession): Promise<void> {
  await waitForScreen(session, screen => {
    if (screen.includes('Do you trust the contents of this directory')) return false
    if (screen.includes('Working (')) return false
    // WHY the local canned provider does not necessarily render the production
    // model/context footer. The provider's own empty composer placeholder is
    // the independent fact needed by this recorder; production readiness keeps
    // its intentionally narrower model-row check.
    return screen.split('\n').some(line =>
      /^\s*›\s*(?:Ask Codex to do anything)?\s*$/.test(line),
    )
  })
}

async function waitForScreen(
  session: LiveSession,
  predicate: (screen: string) => boolean,
): Promise<void> {
  try {
    await waitFor(() => predicate(session.mirror.snapshotPlain()), 'screen predicate')
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
      `last screen=${JSON.stringify(structuralScreen(session))}`,
    )
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(40)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function structuralScreen(session: LiveSession): string[] {
  const screenRows = session.mirror.snapshotPlain().split('\n')
  const rowCount = screenRows.some(row => row.includes('Do you trust the contents')) ? 12 : 8
  return screenRows.slice(-rowCount).map(row => sanitizeScreenRow(session, row))
}

function sanitizeScreenRow(session: LiveSession, row: string): string {
  let sanitized = row
  // Preserve only the public suffix needed by the Vim-sentinel counterexample.
  // Replacing the full cwd with a generic token would erase the provider fact
  // under test; retaining the random temp parent would expose host-local data.
  sanitized = sanitized.split(session.workspaceRoot).join(
    session.workspaceSuffix ? '<recorded-workspace>' : '<private-path>',
  )
  for (const value of [session.codexHome, process.env.HOME ?? ''].filter(Boolean)) {
    sanitized = sanitized.split(value).join('<private-path>')
  }
  sanitized = sanitized.replace('/private<private-path>', '<private-path>')
  sanitized = sanitized.replace(
    /(?:\/private)?\/var\/folders\/[^\s]+\/T\/codex-input-(?:workspace-[A-Za-z0-9]+|wo…)/g,
    '<recorded-workspace>',
  )
  sanitized = sanitized.replace(
    /(?:\/private)?\/var\/folders\/[^\s·…]*…/g,
    '<private-path>',
  )
  sanitized = sanitized.replace(
    /(?:\/private)?\/var\/…\/T\/codex-input-workspace-[A-Za-z0-9]+/g,
    '<recorded-workspace>',
  )
  sanitized = sanitized.replace(/[•◦] Working \(\d+s/, '<activity> Working (<elapsed>')
  sanitized = sanitized.replaceAll(`127.0.0.1:${port}`, '<fixture-server>')
  return sanitized
}

async function recordResizeBoundary(
  session: LiveSession,
  cols: number,
  rows: number,
): Promise<Record<string, unknown>> {
  await waitForPtyQuiet(session)
  const narrow = session.mirror.snapshotStableFrame()
  if (!narrow) throw new Error('narrow frame was still parsing after PTY quiet')

  const rawChunkCountBeforeResize = session.rawPtyChunks.length
  session.mirror.resize(cols, rows)
  // HeadlessTerminal.resize() changes xterm geometry synchronously in the same
  // JavaScript turn. No PTY callback can run between the call and this sample,
  // making it a real pre-provider-redraw frame rather than a timing guess.
  const beforeProviderRedraw = session.mirror.snapshotStableFrame()
  const rawChunkCountBeforeProviderRedraw = session.rawPtyChunks.length
  if (!beforeProviderRedraw) {
    throw new Error('resize unexpectedly overlapped an in-flight PTY parse')
  }
  if (beforeProviderRedraw.generation !== narrow.generation ||
    rawChunkCountBeforeProviderRedraw !== rawChunkCountBeforeResize) {
    throw new Error('provider bytes arrived inside the synchronous resize boundary')
  }

  await waitFor(() => {
    const frame = session.mirror.snapshotStableFrame()
    return frame !== null && frame.generation > beforeProviderRedraw.generation
  }, 'provider redraw after resize')
  await waitForPtyQuiet(session)
  const afterProviderRedraw = session.mirror.snapshotStableFrame()
  if (!afterProviderRedraw ||
    afterProviderRedraw.generation <= beforeProviderRedraw.generation) {
    throw new Error('resize did not produce a complete newer provider frame')
  }

  return {
    resizeTrace: {
      requested: { cols, rows },
      rawChunkCountBeforeResize,
      rawChunkCountBeforeProviderRedraw,
      rawChunkCountAfterProviderRedraw: session.rawPtyChunks.length,
      preRedrawGenerationUnchanged:
        beforeProviderRedraw.generation === narrow.generation,
      postRedrawGenerationAdvanced:
        afterProviderRedraw.generation > beforeProviderRedraw.generation,
      narrow: structuralStableFrame(session, narrow),
      beforeProviderRedraw: structuralStableFrame(session, beforeProviderRedraw),
      afterProviderRedraw: structuralStableFrame(session, afterProviderRedraw),
    },
  }
}

async function recordUnchangedRedrawAfterEdit(
  session: LiveSession,
  edit: string,
): Promise<Record<string, unknown>> {
  const beforeSetupUsers = await readDurableUserTexts(session.codexHome)
  const beforeSetupRequests = session.requests.length
  session.terminal.write('RECORDED_SLOW_TURN')
  await delay(300)
  session.terminal.write('\r')
  await waitFor(async () => {
    const values = await readDurableUserTexts(session.codexHome)
    return values.length > beforeSetupUsers.length
  }, 'unchanged-redraw slow setup prompt to become durable')
  await waitFor(() => session.requests.length > beforeSetupRequests,
    'unchanged-redraw slow setup request')
  await waitForScreen(session, screen => screen.includes('Working ('))
  const baseDraft = 'RECORDED_UNCHANGED_BASE'
  session.terminal.write(baseDraft)
  await waitForScreen(session, screen => screen.includes(baseDraft))
  let beforeEdit: StableTerminalFrame | null = null
  await waitFor(() => {
    beforeEdit = session.mirror.snapshotStableFrame()
    return beforeEdit !== null
  }, 'complete active-composer frame before edit')
  if (!beforeEdit) throw new Error('missing complete frame before edit')
  const beforeRevision = composerRevision(beforeEdit)
  if (!beforeRevision) throw new Error('missing composer revision before edit')

  const rawChunkCountBeforeEdit = session.rawPtyChunks.length
  let editIssued = false
  let childStopped = false
  const issueEditInsideProviderChunk = () => {
    if (editIssued) return
    editIssued = true
    // WHY this listener runs synchronously from HeadlessTerminal's `pty-data`
    // event before that already-produced provider chunk is parsed into xterm.
    // The edit therefore happens after frame F but before the unrelated status
    // bytes advance the mirror generation, reproducing the exact causality the
    // generation-only acknowledgement mistakes for an edit paint.
    session.terminal.write(edit)
    // Freeze only this isolated fixture process after the kernel accepts the
    // edit. The already-emitted status chunk can now finish parsing into the
    // mirror before Codex consumes the edit and paints it. This scheduling
    // control changes no bytes or screen content; it makes the otherwise tiny
    // real race independently inspectable and repeatable.
    process.kill(session.terminal.pid, 'SIGSTOP')
    childStopped = true
  }
  session.mirror.on('pty-data', issueEditInsideProviderChunk)
  try {
    await waitFor(() => editIssued, 'next provider status redraw after arming edit')
  } finally {
    session.mirror.off('pty-data', issueEditInsideProviderChunk)
  }
  let unchangedAfterEdit: StableTerminalFrame | null = null
  let rawChunkCountAtUnchangedRedraw: number | null = null
  try {
    await waitFor(() => {
      const frame = session.mirror.snapshotStableFrame()
      if (!frame || frame.generation <= beforeEdit.generation) return false
      const revision = composerRevision(frame)
      if (!revision || !sameComposerRevision(revision, beforeRevision)) return false
      unchangedAfterEdit = frame
      rawChunkCountAtUnchangedRedraw = session.rawPtyChunks.length
      return true
    }, 'newer provider generation with unchanged pre-edit composer revision')
  } finally {
    if (childStopped) {
      process.kill(session.terminal.pid, 'SIGCONT')
      childStopped = false
    }
  }

  let paintedEdit: StableTerminalFrame | null = null
  await waitFor(() => {
    const frame = session.mirror.snapshotStableFrame()
    if (!frame || frame.generation <= unchangedAfterEdit!.generation) return false
    if (!composerRevision(frame)?.draftText.includes(edit)) return false
    paintedEdit = frame
    return true
  }, 'provider paint that contains the recorded edit')
  if (!unchangedAfterEdit) {
    throw new Error('no newer provider generation retained the pre-edit composer revision')
  }
  if (!paintedEdit) throw new Error('provider never painted the recorded edit')

  const setupDurableUserText = (await readDurableUserTexts(session.codexHome)).at(-1) ?? null
  const setupRequestUserText = extractLastRequestUserText(
    session.requests.at(beforeSetupRequests)?.body,
  )
  if (setupDurableUserText !== 'RECORDED_SLOW_TURN' ||
    setupRequestUserText !== 'RECORDED_SLOW_TURN') {
    throw new Error('slow setup prompt did not agree at rollout/request boundaries')
  }

  releaseSlowResponse?.()
  releaseSlowResponse = null
  await waitForScreen(session, screen =>
    !screen.includes('Working (') && screen.includes(edit),
  )
  await waitForPtyQuiet(session)

  return {
    editAcknowledgementTrace: {
      baseDraft,
      edit,
      setupDurableUserText,
      setupRequestUserText,
      rawChunkCountBeforeEdit,
      rawChunkCountAtUnchangedRedraw,
      schedulingControl: 'SIGSTOP_AFTER_EDIT_WRITE_BEFORE_PROVIDER_PARSE',
      beforeEdit: structuralStableFrame(
        session,
        beforeEdit,
        stableFrameContentEnd(beforeEdit),
      ),
      unchangedAfterEdit: structuralStableFrame(
        session,
        unchangedAfterEdit,
        stableFrameContentEnd(unchangedAfterEdit),
      ),
      paintedEdit: structuralStableFrame(
        session,
        paintedEdit,
        stableFrameContentEnd(paintedEdit),
      ),
      unchangedGenerationAdvanced:
        unchangedAfterEdit.generation > beforeEdit.generation,
      unchangedComposerRevision:
        sameComposerRevision(
          composerRevision(unchangedAfterEdit)!,
          beforeRevision,
        ),
      paintedGenerationAdvanced:
        paintedEdit.generation > unchangedAfterEdit.generation,
    },
  }
}

type ComposerRevision = {
  draftText: string
  cursor: Readonly<{ x: number; y: number }>
}

function composerRevision(frame: StableTerminalFrame): ComposerRevision | null {
  const rows = frame.rows.map(row => row.text.replace(/[ \t]+$/u, ''))
  let composerRow = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (/^›(?: |$)/u.test(rows[index] ?? '')) {
      composerRow = index
      break
    }
  }
  if (composerRow < 0) return null
  const separatorRow = rows.findIndex((row, index) =>
    index > composerRow && row.trim() === '',
  )
  if (separatorRow < 0) return null
  return {
    draftText: rows.slice(composerRow, separatorRow).join('\n'),
    cursor: frame.cursor,
  }
}

function sameComposerRevision(
  left: ComposerRevision,
  right: ComposerRevision,
): boolean {
  return left.draftText === right.draftText &&
    left.cursor.x === right.cursor.x &&
    left.cursor.y === right.cursor.y
}

async function waitForPtyQuiet(session: LiveSession, quietMs = 200): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  let lastCount = session.rawPtyChunks.length
  let unchangedSince = Date.now()
  while (Date.now() < deadline) {
    await delay(20)
    const currentCount = session.rawPtyChunks.length
    if (currentCount !== lastCount) {
      lastCount = currentCount
      unchangedSince = Date.now()
      continue
    }
    if (Date.now() - unchangedSince >= quietMs &&
      session.mirror.snapshotStableFrame() !== null) return
  }
  throw new Error('Timed out waiting for a complete quiet PTY frame')
}

function structuralStableFrame(
  session: LiveSession,
  frame: StableTerminalFrame,
  end = frame.rows.length,
): Record<string, unknown> {
  const start = Math.max(0, end - 10)
  return {
    generation: frame.generation,
    cols: frame.cols,
    cursor: frame.cursor,
    rows: frame.rows.slice(start, end).map((row, offset) => ({
      viewportRow: start + offset,
      text: sanitizeScreenRow(session, row.text),
      isWrapped: row.isWrapped,
    })),
  }
}

function stableFrameContentEnd(frame: StableTerminalFrame): number {
  for (let index = frame.rows.length - 1; index >= 0; index -= 1) {
    if (frame.rows[index]!.text.trim() !== '') return index + 1
  }
  return frame.rows.length
}

async function readDurableUserTexts(codexHome: string): Promise<string[]> {
  const sessionsDir = join(codexHome, 'sessions')
  const files = await listFiles(sessionsDir).catch(() => [])
  const values: string[] = []
  for (const file of files.filter(value => value.endsWith('.jsonl'))) {
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as {
          type?: string
          payload?: { type?: string; role?: string; content?: unknown }
        }
        if (parsed.type !== 'response_item' || parsed.payload?.type !== 'message' ||
          parsed.payload.role !== 'user') continue
        const content = Array.isArray(parsed.payload.content) ? parsed.payload.content : []
        const joined = content.map(item => {
          if (!item || typeof item !== 'object') return ''
          const value = item as { type?: string; text?: string }
          return value.type === 'input_text' && typeof value.text === 'string' ? value.text : ''
        }).join('')
        if (joined) values.push(joined)
      } catch { /* Ignore a partial final line while Codex appends. */ }
    }
  }
  return values
}

function extractLastRequestUserText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const input = (body as { input?: unknown }).input
  if (!Array.isArray(input)) return null
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (!item || typeof item !== 'object') continue
    const message = item as { role?: string; content?: unknown }
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    const text = message.content.map(part => {
      if (!part || typeof part !== 'object') return ''
      const value = part as { type?: string; text?: string }
      return value.type === 'input_text' && typeof value.text === 'string' ? value.text : ''
    }).join('')
    if (text) return text
  }
  return null
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    if ((await stat(path)).isDirectory()) files.push(...await listFiles(path))
    else files.push(path)
  }
  return files
}

async function hashRolloutCorpus(codexHome: string): Promise<string> {
  const files = (await listFiles(join(codexHome, 'sessions')).catch(() => []))
    .filter(file => file.endsWith('.jsonl'))
    .sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(await readFile(file))
  return hash.digest('hex')
}

async function binaryVersion(): Promise<string> {
  const child = pty.spawn(CODEX_BINARY, ['--version'], {
    name: 'xterm-256color', cols: 80, rows: 10, cwd: process.cwd(),
    env: process.env as Record<string, string>,
  })
  let output = ''
  child.onData(data => { output += data })
  await new Promise<void>(resolveExit => child.onExit(() => resolveExit()))
  return output.replace(/\x1b\[[0-9;?]*[@-~]/g, '').trim()
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}
