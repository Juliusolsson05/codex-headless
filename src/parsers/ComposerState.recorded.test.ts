import type { IPty } from 'node-pty'
import { readFileSync } from 'node:fs'

import { afterEach, expect, it } from 'vitest'

import { HeadlessTerminal } from '../terminal/HeadlessTerminal.js'
import { classifyCodexComposerState } from './ComposerState.js'

// agent-code#800 / #1313: a raw PTY recording of codex-cli 0.157.0 (see the
// fixture's `source`). Replayed through the real terminal so the dim
// attribute the classifier depends on comes from xterm's own parse of
// Codex's bytes, not from a hand-written row.
type Recording = { cols: number; rows: number; events: Array<{ t: number; dir: string; label?: string; data?: string }> }
const recording = JSON.parse(readFileSync(
  new URL('../../testing/fixtures/composer-0157/idle-draft-ctrlc.json', import.meta.url),
  'utf8',
)) as Recording
const at = (label: string) => recording.events.find(event => event.label === label)!.t

const terminals: HeadlessTerminal[] = []
// The PTY listeners of each replayed terminal, so a test can deliver more
// recorded bytes after the replay cut.
const feeders = new WeakMap<HeadlessTerminal, Set<(data: string) => void>>()
const feed = (terminal: HeadlessTerminal, data: string) => { for (const listener of feeders.get(terminal)!) listener(data) }
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })

// Waits until xterm has parsed every byte fed so far (#57 reviews A and B).
// These waits used to give up after 2 s of wall clock and then read whatever
// frame existed: under load the 110 KB tall-draft replay was still parsing,
// and a half-painted frame read `unknown`. Draining is the real completion
// signal; a parser that never drains fails on the test timeout instead of
// passing a wrong frame.
async function drained(terminal: HeadlessTerminal): Promise<void> {
  while ((terminal as unknown as { pendingWrites: number }).pendingWrites !== 0) await new Promise(resolve => setImmediate(resolve))
}
// Feeds recorded chunks ONE AT A TIME, letting xterm drain between them, as a
// PTY delivers them (#57 review, Pi a). Dumping ~630 events in one synchronous
// burst could leave `pendingWrites` stuck (HeadlessTerminal's documented
// write-callback stall), which no wait can recover from.
async function feedPaced(terminal: HeadlessTerminal, listeners: Set<(data: string) => void>, chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    for (const listener of listeners) listener(chunk)
    await drained(terminal)
  }
}

async function replayUntil(until: number): Promise<HeadlessTerminal> {
  const listeners = new Set<(data: string) => void>()
  const pty = {
    write: () => undefined,
    resize: () => undefined,
    onData: (listener: (data: string) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
  const terminal = new HeadlessTerminal({ pty, cols: recording.cols, rows: recording.rows, snapshotIntervalMs: 1 })
  terminals.push(terminal)
  feeders.set(terminal, listeners)
  terminal.attach()
  await feedPaced(terminal, listeners, recording.events.filter(event => event.dir === 'out' && event.t < until).map(event => event.data!))
  return terminal
}

it('reads the idle composer with its dim placeholder as empty', async () => {
  const terminal = await replayUntil(at('type-draft'))
  expect(terminal.snapshotPlain()).toContain('› Ask Codex to do anything')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).toBe('empty')
})

it('reads a typed draft as drafted', async () => {
  const terminal = await replayUntil(at('ctrl-c-1'))
  expect(terminal.snapshotPlain()).toContain('› please review the draft')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).toBe('drafted')
})

it('reads the composer as empty again after Ctrl+C clears the draft', async () => {
  const terminal = await replayUntil(at('ctrl-c-2'))
  expect(terminal.snapshotPlain()).not.toContain('please review the draft')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).toBe('empty')
})

// #54 review C: the second Ctrl+C paints `› Shutting down...` DIM and wipes
// the hint row. Cells alone read that as an empty composer; an empty-only
// caller would write into an exiting process.
it('never reads the quit frame as empty', async () => {
  // Cut right after the paint that shows `› Shutting down...` (#54 review
  // round 2 B: the exit event comes after the screen was cleared).
  const quit = recording.events.find(event => event.dir === 'out' && event.data!.includes('Shutting down'))!.t
  const terminal = await replayUntil(quit + 1)
  expect(terminal.snapshotPlain()).toContain('› Shutting down...')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).not.toBe('empty')
})

// #54 review round 2 (A, B, C): the status row carries the cwd, which is
// user-controlled, so a hint word in it must never count as Codex's hint.
it('never takes a hint from the cwd in the status row', () => {
  const status = (cwd: string) => row(`  GPT-6-Sol high fast · ${cwd}`)
  expect(classifyCodexComposerState([row('  [Image #1]'), row(''), row('› Ask Codex to do anything', true), row(''), status('~/for shortcuts')])).toBe('unknown')
  expect(classifyCodexComposerState([row('› Shutting down...', true), row(''), status('~/for shortcuts')])).toBe('unknown')
  expect(classifyCodexComposerState([row('› Ask Codex to do anything', true), row(''), status('~/to queue message'), row('  ← for agents · ? for shortcuts')])).toBe('empty')
})

const row = (text: string, dim = false) => ({ text, cells: [...text].filter(c => c.trim()).map(chars => ({ chars, dim })) })
const IDLE_FOOTER = [row('  GPT-6-Sol high fast · ~/p'), row('  ← for agents · ? for shortcuts')]
const STATUS_ONLY = [row('  GPT-6-Sol high fast · ~/p')]

it('is empty only when Codex says so, with the shortcuts hint', () => {
  expect(classifyCodexComposerState([row('› '), row('Ask Codex to do anything', true), row(''), ...IDLE_FOOTER])).toBe('empty')
  expect(classifyCodexComposerState([row('›'), row(''), ...IDLE_FOOTER])).toBe('empty')
  // No hint (a draft hid it, a narrow pane dropped it, or Codex is quitting):
  // not provably empty.
  expect(classifyCodexComposerState([row('›'), row(''), ...STATUS_ONLY])).toBe('unknown')
})

// agent-code#1319 review round 2 B: only Codex's shortcuts hint proves empty.
// Another indented footer row (a warning line) under a dim placeholder with
// an image above it must not, or a restart would submit the unseen image.
it('never takes a warning row for the shortcuts hint', () => {
  expect(classifyCodexComposerState([row('  [Image #1]'), row(''), row('› Ask Codex to do anything', true), row(''), ...STATUS_ONLY, row('  ⚠ 1 warning · f2 to view')])).toBe('unknown')
})

// agent-code#1319 review round 2 A2: the plain screen shows the previous
// paint while a chunk is still being parsed. The settled read refuses to
// answer then, so a text proof of an empty composer cannot come from a
// stale frame.
it('has no settled screen while the draft chunk is still being parsed', async () => {
  const terminal = await replayUntil(at('type-draft'))
  expect(terminal.snapshotSettledPlain()).toContain('› Ask Codex to do anything')
  const draft = recording.events.filter(event => event.dir === 'out' && event.t >= at('type-draft') && event.t < at('ctrl-c-1'))
  expect(draft.length).toBeGreaterThan(0)
  for (const event of draft) feed(terminal, event.data!)
  // Synchronously after the bytes arrive: the old paint is all there is.
  // Pinned exactly (#55 review B), so this test keeps proving the dangerous
  // stale empty-composer frame exists, not merely that the draft is absent.
  expect(terminal.snapshotPlain()).toContain('› Ask Codex to do anything')
  expect(terminal.snapshotPlain()).toContain('? for shortcuts')
  expect(terminal.snapshotSettledPlain()).toBeNull()
  await settled(terminal)
  expect(terminal.snapshotSettledPlain()).toContain('› please review the draft')
})

// The draft window's recorded output chunks, in order.
const draftChunks = () => recording.events.filter(event => event.dir === 'out' && event.t >= at('type-draft') && event.t < at('ctrl-c-1')).map(event => event.data!)
// Waits for xterm to parse everything admitted so far. Reads the private
// counter because the public settled reads are what these tests pin.
async function parsed(terminal: HeadlessTerminal): Promise<void> {
  await drained(terminal)
}
async function settled(terminal: HeadlessTerminal): Promise<void> {
  await drained(terminal)
}

// #55 review C1: the production race is ONE chunk in flight (the human's
// first keystroke's echo), not the 27 queued above. A `pendingWrites > 1`
// typo would answer here with the stale empty composer.
it('has no settled screen while a single chunk is being parsed', async () => {
  const terminal = await replayUntil(at('type-draft'))
  feed(terminal, draftChunks()[0]!)
  expect(terminal.snapshotSettledPlain()).toBeNull()
  expect(terminal.snapshotComposerCells()).toBeNull()
  await settled(terminal)
  expect(terminal.snapshotSettledPlain()).not.toBeNull()
})

// #55 review A1: 'pty-data' listeners run synchronously on arrival, before
// the chunk reaches xterm. A settled read from inside one must not answer
// with the paint from before the chunk.
it('has no settled screen inside a pty-data listener', async () => {
  const terminal = await replayUntil(at('type-draft'))
  const seen: unknown[] = []
  terminal.on('pty-data', () => seen.push(terminal.snapshotSettledPlain(), terminal.snapshotComposerCells()))
  feed(terminal, draftChunks()[0]!)
  expect(seen).toEqual([null, null])
})

// #55 review A2: Codex opens a synchronized update in one chunk and closes it
// in the next (chunks 74/75 of this recording). In between every byte is
// parsed, but the buffer is half a redraw: the hint is already cleared over
// the old composer.
it('has no settled screen inside an open synchronized update', async () => {
  const chunks = draftChunks()
  const openOnly = chunks.findIndex(data => data.includes('\x1b[?2026h') && !data.includes('\x1b[?2026l'))
  expect(openOnly).toBeGreaterThan(0)
  expect(chunks[openOnly + 1]).toContain('\x1b[?2026l')
  const terminal = await replayUntil(at('type-draft'))
  for (const data of chunks.slice(0, openOnly + 1)) feed(terminal, data)
  await parsed(terminal)
  expect(terminal.snapshotPlain()).not.toBe('')
  expect(terminal.snapshotSettledPlain()).toBeNull()
  expect(terminal.snapshotComposerCells()).toBeNull()
  feed(terminal, chunks[openOnly + 1]!)
  await parsed(terminal)
  expect(terminal.snapshotSettledPlain()).not.toBeNull()
})

// A PTY read can split the escape sequence itself. The same recorded chunk,
// cut inside `\x1b[?2026h`, must still count as opening the update.
it('sees a synchronized update opened across two chunks', async () => {
  const chunks = draftChunks()
  const openOnly = chunks.findIndex(data => data.includes('\x1b[?2026h') && !data.includes('\x1b[?2026l'))
  const data = chunks[openOnly]!
  const cut = data.indexOf('\x1b[?2026h') + 4
  const terminal = await replayUntil(at('type-draft'))
  for (const earlier of chunks.slice(0, openOnly)) feed(terminal, earlier)
  feed(terminal, data.slice(0, cut))
  feed(terminal, data.slice(cut))
  await parsed(terminal)
  expect(terminal.snapshotSettledPlain()).toBeNull()
})

// #55 review A3: xterm reflows on resize at once, Codex redraws only after
// SIGWINCH. Until a post-resize chunk is parsed the rows are old paint under
// the new geometry.
it('has no settled screen after a resize until the provider paints again', async () => {
  const terminal = await replayUntil(at('type-draft'))
  expect(terminal.snapshotSettledPlain()).not.toBeNull()
  terminal.resize(recording.cols - 10, recording.rows)
  expect(terminal.snapshotSettledPlain()).toBeNull()
  expect(terminal.snapshotComposerCells()).toBeNull()
  feed(terminal, draftChunks()[0]!)
  await parsed(terminal)
  expect(terminal.snapshotSettledPlain()).not.toBeNull()
})

// #54 review A: an attached image sits ABOVE the textarea, which keeps its
// dim placeholder. Codex then shows no shortcuts hint (its is_empty counts
// attachments), so it is never empty; an image label in the composer rows
// is a draft outright.
it('never reads an image attachment as empty', () => {
  expect(classifyCodexComposerState([row('  [Image #1]'), row(''), row('› Ask Codex to do anything', true), row(''), ...STATUS_ONLY])).toBe('unknown')
  expect(classifyCodexComposerState([row('› [Image #1]', true), row(''), ...IDLE_FOOTER])).toBe('drafted')
})

// #54 review A: during a turn the queue hint replaces the status row. The
// recorded 0.149.1 case `active-footer-tab-queue` (screenBeforeFinalWrite).
it('reads a draft under the running-turn queue footer as drafted', () => {
  const recorded = ['', ' ', '<activity> Working (<elapsed> • esc to interrupt)', ' ', ' ', '› RECORDED_QUEUED_PROMPT', ' ', '  tab to queue message' + ' '.repeat(99) + '100% context left']
  expect(classifyCodexComposerState(recorded.map(text => row(text)))).toBe('drafted')
  // The queue hint is Codex saying "draft" (ComposerHasDraft while a task
  // runs), even when the composer row's cells happen to be styled dim.
  expect(classifyCodexComposerState([row('› [Pasted Content 1204 chars]', true), row(''), row('  tab to queue message' + ' '.repeat(40) + '100% context left')])).toBe('drafted')
})

// #54 review B: text only on a continuation row (a draft that begins with a
// newline) is a draft, and the long-draft bound holds.
it('reads a draft on continuation rows, up to the composer bound', () => {
  expect(classifyCodexComposerState([row('›'), row('  real draft'), row(''), ...IDLE_FOOTER])).toBe('drafted')
  const continuation = (count: number) => Array.from({ length: count }, () => row('  more of the draft'))
  expect(classifyCodexComposerState([row('› start'), ...continuation(11), row(''), ...STATUS_ONLY])).toBe('drafted')
  // agent-code#1327: this used to expect `unknown`, which is the bug the
  // tall-draft recording shows. An unbroken draft past the bound is followed.
  expect(classifyCodexComposerState([row('› start'), ...continuation(12), row(''), ...STATUS_ONLY])).toBe('drafted')
  // Within the bound a blank row inside the draft is fine; past it, a blank
  // row ends the search, so the frame stays unreadable (the residual).
  expect(classifyCodexComposerState([row('› start'), row(''), ...continuation(4), row(''), ...STATUS_ONLY])).toBe('drafted')
  expect(classifyCodexComposerState([row('› start'), row(''), ...continuation(12), row(''), ...STATUS_ONLY])).toBe('unknown')
  // The exact edge (#57 review C, surviving mutant): a marker 12 rows up with
  // a blank row inside is still in the bounded search; 13 rows up it is not.
  expect(classifyCodexComposerState([row('› start'), row(''), ...continuation(10), row(''), ...STATUS_ONLY])).toBe('drafted')
  expect(classifyCodexComposerState([row('› start'), row(''), ...continuation(11), row(''), ...STATUS_ONLY])).toBe('unknown')
})

// A transcript user message starts with `›` too, and it is plain text. With
// no footer directly below it, it must never be read as the composer. And a
// footer with no marker above it is not a composer either (#54 review B).
it('does not read a transcript row, a markerless pane or Vim mode as a composer state', () => {
  expect(classifyCodexComposerState([row('› an earlier user message'), row(''), row('• assistant reply')])).toBe('unknown')
  expect(classifyCodexComposerState([row('  status left'), row(''), ...IDLE_FOOTER])).toBe('unknown')
  expect(classifyCodexComposerState([row('›'), row(''), row('  gpt · ~/p      Vim: Insert')])).toBe('unknown')
  expect(classifyCodexComposerState([row('›'), row(''), row('  gpt · ~/p'), row('  ? for shortcuts      Vim: Normal')])).toBe('unknown')
})

// agent-code#1327: a raw recording of codex-cli 0.157.1 typing a 20-line
// draft (Ctrl+J newlines, no Enter). Codex does not scroll its marker away:
// the composer grows upward, `›` on row 7 and the draft down to row 26. Our
// 12-row marker search read it `unknown` from 13 composer rows, which published
// provider-not-ready, and Agent Code's own Enter then appended to the draft.
const tall = JSON.parse(readFileSync(
  new URL('../../testing/fixtures/composer-0157/tall-draft-ctrlc.json', import.meta.url),
  'utf8',
)) as Recording
async function replayTallUntil(label: string, settleMs = 800): Promise<HeadlessTerminal> {
  const until = tall.events.find(event => event.label === label)!.t + settleMs
  const listeners = new Set<(data: string) => void>()
  const pty = {
    write: () => undefined,
    resize: () => undefined,
    onData: (listener: (data: string) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
  const terminal = new HeadlessTerminal({ pty, cols: tall.cols, rows: tall.rows, snapshotIntervalMs: 1 })
  terminals.push(terminal)
  terminal.attach()
  await feedPaced(terminal, listeners, tall.events.filter(event => event.dir === 'out' && event.t < until).map(event => event.data!))
  return terminal
}

it('reads a recorded draft as drafted at every height up to 20 rows', async () => {
  for (const [label, rowsShown] of [['type-line-10', 11], ['type-line-14', 15], ['draft-typed', 20]] as const) {
    const terminal = await replayTallUntil(label)
    const plain = terminal.snapshotPlain()
    // The marker is on screen, the whole draft under it.
    expect(plain).toContain('› long draft line 01 with a few words')
    expect(plain).toContain(`  long draft line ${String(rowsShown).padStart(2, '0')} with a few words`)
    expect(classifyCodexComposerState(terminal.snapshotComposerCells())).toBe('drafted')
  }
})

it('reads the recorded composer as empty again after Ctrl+C clears the tall draft', async () => {
  const terminal = await replayTallUntil('ctrl-c-1')
  expect(classifyCodexComposerState(terminal.snapshotComposerCells())).toBe('empty')
})

// Negative first (steering q33/q34): past the 12-row bound the search follows
// only an UNBROKEN block of rows. A `›` further up, across a blank row, is
// transcript, not composer, and must not turn an unreadable frame into a
// draft (or a transcript line into occupancy).
// #57 review C: the blank row can also sit INSIDE the 12-row window. The walk
// past the bound must still stop there (a walk that started above the window
// never saw it and read this markerless frame as `drafted`).
it('does not follow a tall search across a blank row inside the window', () => {
  for (const blankAt of [1, 2, 3, 4, 12]) {
    const rows = [
      row('› old user message in transcript'),
      ...Array.from({ length: 13 }, (_, i) => row(i + 1 === blankAt ? '' : `  continuation ${i}`)),
      row(''),
      row('  GPT-6-Sol high fast · ~/p'),
      row('  ? for shortcuts'),
    ]
    expect(classifyCodexComposerState(rows)).toBe('unknown')
  }
})

// The one blank row the long walk may start above is the empty cursor line a
// Ctrl+J leaves at the bottom of a draft (recorded: type-line-14 cuts right
// after a newline). Two trailing blank rows are not that line.
it('allows only the single trailing cursor line to be blank', () => {
  const draft = (trailingBlanks: number) => [
    row('› start of a tall draft'),
    ...Array.from({ length: 13 }, (_, i) => row(`  draft ${i}`)),
    ...Array.from({ length: trailingBlanks }, () => row('')),
    row(''),
    ...STATUS_ONLY,
  ]
  expect(classifyCodexComposerState(draft(1))).toBe('drafted')
  expect(classifyCodexComposerState(draft(2))).toBe('unknown')
})

// #57 review C (surviving mutant): the long walk runs only when the bounded
// search found no marker. A real empty composer under an older, unbroken
// transcript block is `empty`, not the transcript's `drafted`.
it('keeps the nearest marker when one is within the bound', () => {
  const rows = [
    row('› old user message in transcript'),
    ...Array.from({ length: 13 }, (_, i) => row(`  transcript ${i}`)),
    row('› Ask Codex to do anything', true),
    row(''),
    ...IDLE_FOOTER,
  ]
  expect(classifyCodexComposerState(rows)).toBe('empty')
})

it('does not follow a tall search across a blank row to a transcript marker', () => {
  const rows = [
    row('› an old user message in the transcript'),
    row(''),
    ...Array.from({ length: 13 }, (_, i) => row(`  continuation ${i}`)),
    row(''),
    row('  GPT-6-Sol high fast · ~/p'),
    row('  ? for shortcuts'),
  ]
  expect(classifyCodexComposerState(rows)).toBe('unknown')
})
