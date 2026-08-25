import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'

import {
  decideFreshRolloutClaim,
  normalizePromptForOwnership,
  parseFreshRolloutCandidate,
} from '../src/transcript/FreshRolloutClaim.js'
import { decideLegacyFreshRollout } from '../src/transcript/LegacyFreshRolloutOracle.js'

type FixtureSource = {
  id: string
  sourcePath: string
  sourceLineLimit?: number
  sessionRecordingId: string | null
  sessionClass: 'fresh' | 'resume' | 'subagent'
  localPromptObservationIndex: number | null
  expectedLegacyDecision: 'accept' | 'hold' | 'not-applicable'
  expectedTargetDecision: 'accept' | 'hold' | 'ambiguous' | 'not-applicable'
  note: string
}

type FixtureManifest = {
  sources: FixtureSource[]
}

type JsonRecord = Record<string, unknown>

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultOutputRoot = resolve(
  scriptDir,
  '../testing/fixtures/rollout-ownership',
)
const TEXT_WRAPPER_RE =
  /<user_input>|<\/user_input>|USER_MESSAGE_BEGIN|USER_MESSAGE_END/g
const equalityTokenOwners = new Map<string, string>()

const manifestPath = optionValue('--manifest')
if (!manifestPath) {
  throw new Error(
    'Usage: tsx scripts/extract-rollout-ownership-fixtures.mts ' +
      '--manifest <private-source-manifest.json> [--output <directory>] [--verify]',
  )
}
const outputRoot = resolve(optionValue('--output') ?? defaultOutputRoot)
const verifyOnly = process.argv.includes('--verify')
const censusRoot = optionValue('--census-root')
const manifest = JSON.parse(
  await readFile(resolve(manifestPath), 'utf8'),
) as FixtureManifest

if (!verifyOnly) await mkdir(outputRoot, { recursive: true })

for (const source of manifest.sources) {
  const sourceText = await readFile(resolve(source.sourcePath), 'utf8')
  const raw = source.sourceLineLimit === undefined
    ? sourceText
    : boundedSourcePrefix(source.id, sourceText, source.sourceLineLimit)
  const generated = buildFixture(source, raw)
  const outputPath = resolve(outputRoot, `${source.id}.json`)

  if (verifyOnly) {
    const committed = JSON.parse(await readFile(outputPath, 'utf8')) as JsonRecord
    const expected = JSON.stringify(generated)
    const actual = JSON.stringify(committed)
    if (actual !== expected) {
      throw new Error(
        `${source.id}: committed fixture differs from the private recording projection`,
      )
    }
  } else {
    await writeFile(outputPath, `${JSON.stringify(generated, null, 2)}\n`)
  }

  process.stdout.write(
    `${verifyOnly ? 'verified' : 'wrote'} ${source.id} ` +
      `(${generated.provenance.cliVersion}, ` +
      `${generated.provenance.userObservationCount} user observations)\n`,
  )
}

if (censusRoot) await printCorpusCensus(resolve(censusRoot))

function buildFixture(source: FixtureSource, raw: string) {
  const candidate = parseFreshRolloutCandidate(source.sourcePath, raw)
  if (!candidate || !candidate.cwd || !candidate.cliVersion) {
    throw new Error(`${source.id}: source is not a parseable rollout candidate`)
  }

  const tokenByNormalizedText = new Map<string, string>()
  for (const message of candidate.userMessages) {
    if (!tokenByNormalizedText.has(message.normalized)) {
      tokenByNormalizedText.set(
        message.normalized,
        equalityClassToken(`${source.id}:${tokenByNormalizedText.size}`),
      )
    }
  }

  const localObservation = source.localPromptObservationIndex === null
    ? null
    : candidate.userMessages[source.localPromptObservationIndex]
  if (source.localPromptObservationIndex !== null && !localObservation) {
    throw new Error(
      `${source.id}: localPromptObservationIndex is outside the recorded evidence`,
    )
  }
  const localPromptToken = localObservation
    ? tokenByNormalizedText.get(localObservation.normalized) ?? null
    : null

  const lines = raw
    .split('\n')
    .map((line, originalLineIndex) => ({ line, originalLineIndex }))
    .filter(item => item.line.trim().length > 0)
    .map(item => ({
      parsed: JSON.parse(item.line) as JsonRecord,
      originalLineIndex: item.originalLineIndex,
    }))
    .flatMap(item => {
      const sanitized = sanitizeOwnershipLine(
        item.parsed,
        item.originalLineIndex,
        tokenByNormalizedText,
        source.id,
      )
      return sanitized ? [sanitized] : []
    })

  const fixtureText = lines.map(line => JSON.stringify(line)).join('\n')
  const fixtureCandidate = parseFreshRolloutCandidate(
    `/recorded/${source.id}.jsonl`,
    fixtureText,
  )
  if (!fixtureCandidate) {
    throw new Error(`${source.id}: sanitized projection no longer parses`)
  }

  const sourceShape = collectOwnershipWireShape(
    raw,
    normalized => tokenByNormalizedText.get(normalized) ?? null,
  )
  const fixtureShape = collectOwnershipWireShape(
    fixtureText,
    normalized => normalized,
  )
  if (JSON.stringify(sourceShape) !== JSON.stringify(fixtureShape)) {
    throw new Error(
      `${source.id}: sanitization changed ordered user wire shape`,
    )
  }

  if (source.expectedLegacyDecision !== 'not-applicable') {
    if (!localPromptToken) {
      throw new Error(`${source.id}: fresh fixture lacks a local prompt token`)
    }
    const sourceLegacyDecision = decideLegacyFreshRollout(
      raw,
      candidate.cwd,
      localObservation?.text ?? '',
    )
    const fixtureLegacyDecision = decideLegacyFreshRollout(
      fixtureText,
      '/recorded/worktree',
      localPromptToken,
    )
    if (sourceLegacyDecision !== source.expectedLegacyDecision ||
      fixtureLegacyDecision !== source.expectedLegacyDecision) {
      throw new Error(
        `${source.id}: expected frozen legacy ${source.expectedLegacyDecision}, ` +
          `observed source=${sourceLegacyDecision}, fixture=${fixtureLegacyDecision}`,
      )
    }

    const sourceTargetDecision = decideFreshRolloutClaim({
      ownCwd: candidate.cwd,
      prompts: [{
        text: localObservation?.text ?? '',
        normalized: localObservation?.normalized ?? '',
        ts: 0,
      }],
      candidates: [candidate],
      normalizeCwd: value => value,
    })
    const fixtureTargetDecision = decideFreshRolloutClaim({
      ownCwd: '/recorded/worktree',
      prompts: [{
        text: localPromptToken,
        normalized: normalizePromptForOwnership(localPromptToken),
        ts: 0,
      }],
      candidates: [fixtureCandidate],
      normalizeCwd: value => value,
    })
    if (sourceTargetDecision.type !== source.expectedTargetDecision ||
      fixtureTargetDecision.type !== source.expectedTargetDecision) {
      throw new Error(
        `${source.id}: expected target ${source.expectedTargetDecision}, ` +
          `observed source=${sourceTargetDecision.type}, ` +
          `fixture=${fixtureTargetDecision.type}`,
      )
    }
  }

  const serialized = JSON.stringify(lines)
  if (serialized.includes(homedir()) || serialized.includes(candidate.cwd)) {
    throw new Error(`${source.id}: sanitized fixture leaked a private path`)
  }
  for (const message of candidate.userMessages) {
    // WHY check the complete original message rather than a blacklist of known
    // prompts: new bootstrap shapes are exactly what this corpus is meant to
    // discover. A whitelist projection plus this assertion makes the extractor
    // fail closed if a future edit accidentally copies recorded user content.
    if (message.text.length >= 32 && serialized.includes(message.text)) {
      throw new Error(`${source.id}: sanitized fixture leaked recorded user text`)
    }
  }

  return {
    schemaVersion: 2,
    id: source.id,
    provenance: {
      // WHY the committed projection keeps only an opaque source label: Codex
      // rollout basenames embed the real provider thread UUID. The private
      // manifest is the authorized lookup bridge; provenance must not publish
      // that identity merely to make local regeneration convenient.
      // Derive this from the public fixture id, not the private basename. Even
      // a one-way basename digest is a stable provider-identity correlator for
      // someone who already possesses another copy of that rollout name.
      sourceLabel: `recorded-source-${sha256(source.id).slice(0, 16)}`,
      sourceSha256: sha256(raw),
      sessionRecordingId: source.sessionRecordingId,
      cliVersion: candidate.cliVersion,
      sessionClass: source.sessionClass,
      originalLineCount: raw.split('\n').filter(Boolean).length,
      userObservationCount: candidate.userMessages.length,
      originalUserObservations: candidate.userMessages.map(message => ({
        source: message.source,
        originalLineIndex: message.lineIndex,
        token: tokenByNormalizedText.get(message.normalized),
        characterCount: message.text.length,
      })),
      wireShape: sourceShape,
      transformation: 'ownership-projection-v2',
    },
    ownership: {
      localPromptToken,
      expectedLegacyDecision: source.expectedLegacyDecision,
      expectedTargetDecision: source.expectedTargetDecision,
      note: source.note,
    },
    lines,
  }
}

function sanitizeOwnershipLine(
  line: JsonRecord,
  originalLineIndex: number,
  tokenByNormalizedText: Map<string, string>,
  fixtureId: string,
): JsonRecord | null {
  const type = typeof line.type === 'string' ? line.type : null
  const timestamp = typeof line.timestamp === 'string'
    ? line.timestamp
    : '2026-01-01T00:00:00.000Z'
  const payload = asRecord(line.payload)
  if (!type || !payload) return null

  if (type === 'session_meta') {
    const threadId = deterministicUuid(`thread:${fixtureId}`)
    return {
      timestamp,
      type,
      payload: {
        id: threadId,
        timestamp,
        cwd: '/recorded/worktree',
        originator: typeof payload.originator === 'string'
          ? payload.originator
          : 'recorded-originator',
        cli_version: payload.cli_version,
        source: sanitizeSessionSource(payload.source),
        ...(payload.forked_from_id
          ? { forked_from_id: deterministicUuid(`parent:${fixtureId}`) }
          : {}),
        ...(payload.agent_nickname
          ? { agent_nickname: 'recorded-agent' }
          : {}),
        ...(payload.agent_role ? { agent_role: 'recorded-role' } : {}),
        ...(payload.agent_path ? { agent_path: '/recorded/agent' } : {}),
      },
      _recordedLineIndex: originalLineIndex,
    }
  }

  if (type === 'turn_context' && typeof payload.cwd === 'string') {
    return {
      timestamp,
      type,
      payload: { cwd: '/recorded/worktree' },
      _recordedLineIndex: originalLineIndex,
    }
  }

  if (type === 'event_msg' && payload.type === 'user_message') {
    const text = typeof payload.message === 'string' ? payload.message : null
    if (!text) return null
    const token = tokenByNormalizedText.get(normalizePromptForOwnership(text))
    if (!token) throw new Error('event_msg user text lacked a recorded token')
    return {
      timestamp,
      type,
      payload: {
        type: 'user_message',
        message: sanitizeTextAtom(text, token, true),
      },
      _recordedLineIndex: originalLineIndex,
    }
  }

  if (
    type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'user'
  ) {
    const content = Array.isArray(payload.content) ? payload.content : []
    const records = content.map(item => asRecord(item))
    if (records.some(item => !item ||
      typeof item.type !== 'string' || typeof item.text !== 'string' ||
      Object.keys(item).some(key => key !== 'type' && key !== 'text'))) {
      throw new Error(
        `${fixtureId}: unsupported user content item; refusing to flatten it`,
      )
    }
    const text = records
      .map(item => item?.text as string)
      .filter(Boolean)
      .join('\n')
    const token = tokenByNormalizedText.get(normalizePromptForOwnership(text))
    if (!token) throw new Error('response_item user text lacked a recorded token')
    let tokenPlaced = false
    return {
      timestamp,
      type,
      payload: {
        type: 'message',
        role: 'user',
        content: records.map(item => {
          const originalText = item?.text as string
          const placeToken = !tokenPlaced && originalText.length > 0
          if (placeToken) tokenPlaced = true
          return {
            type: item?.type,
            text: sanitizeTextAtom(originalText, token, placeToken),
          }
        }),
      },
      _recordedLineIndex: originalLineIndex,
    }
  }

  return null
}

function sanitizeSessionSource(source: unknown): unknown {
  if (typeof source === 'string') return source
  const sourceRecord = asRecord(source)
  const subagent = asRecord(sourceRecord?.subagent)
  const spawn = asRecord(subagent?.thread_spawn)
  if (!spawn) return 'recorded-source'
  return {
    subagent: {
      thread_spawn: {
        parent_thread_id: deterministicUuid('recorded-parent-thread'),
        depth: typeof spawn.depth === 'number' ? spawn.depth : 1,
        agent_path: '/recorded/agent',
        agent_nickname: 'recorded-agent',
        agent_role: null,
      },
    },
  }
}

function equalityClassToken(owner: string): string {
  // WHY tokens are one UTF-16 code unit yet globally unique across fixtures:
  // exact text lengths include a recorded one-character user message, while
  // concurrent ownership tests must still distinguish alpha's class from
  // beta's. BMP private-use code points preserve that length without leaking
  // text; deterministic probing makes collisions explicit and reproducible.
  const privateUseStart = 0xe000
  const privateUseCount = 0x1900
  const initial = Number.parseInt(sha256(owner).slice(0, 8), 16) % privateUseCount
  for (let offset = 0; offset < privateUseCount; offset += 1) {
    const token = String.fromCharCode(
      privateUseStart + ((initial + offset) % privateUseCount),
    )
    const claimedBy = equalityTokenOwners.get(token)
    if (!claimedBy || claimedBy === owner) {
      equalityTokenOwners.set(token, owner)
      return token
    }
  }
  throw new Error('recorded equality-token namespace exhausted')
}

function sanitizeTextAtom(
  text: string,
  token: string,
  placeToken: boolean,
): string {
  const output = Array<string>(text.length).fill(' ')
  const protectedPositions = Array<boolean>(text.length).fill(false)
  TEXT_WRAPPER_RE.lastIndex = 0
  let wrapper: RegExpExecArray | null
  while ((wrapper = TEXT_WRAPPER_RE.exec(text)) !== null) {
    for (let offset = 0; offset < wrapper[0].length; offset += 1) {
      const index = wrapper.index + offset
      output[index] = text[index] ?? ' '
      protectedPositions[index] = true
    }
  }

  if (placeToken) {
    const index = protectedPositions.findIndex(isProtected => !isProtected)
    if (index < 0) {
      throw new Error('text atom has no private position for equality token')
    }
    output[index] = token
  }
  const sanitized = output.join('')
  if (sanitized.length !== text.length) {
    throw new Error('sanitizer changed exact text atom length')
  }
  return sanitized
}

function collectOwnershipWireShape(
  text: string,
  equalityClass: (normalized: string) => string | null,
) {
  return text
    .split('\n')
    .map((rawLine, parsedLineIndex) => ({ rawLine, parsedLineIndex }))
    .filter(item => item.rawLine.trim().length > 0)
    .flatMap(item => {
      const line = JSON.parse(item.rawLine) as JsonRecord
      const payload = asRecord(line.payload)
      if (!payload) return []
      const originalLineIndex = typeof line._recordedLineIndex === 'number'
        ? line._recordedLineIndex
        : item.parsedLineIndex

      if (line.type === 'event_msg' && payload.type === 'user_message' &&
        typeof payload.message === 'string') {
        return [{
          source: 'event_msg',
          originalLineIndex,
          equalityClass: equalityClass(normalizeRecordedText(payload.message)),
          text: textAtomShape(payload.message),
        }]
      }

      if (line.type === 'response_item' && payload.type === 'message' &&
        payload.role === 'user' && Array.isArray(payload.content)) {
        const content = payload.content.map(item => {
          const record = asRecord(item)
          if (!record || typeof record.type !== 'string') {
            throw new Error('user content item has no structural type')
          }
          return {
            type: record.type,
            keys: Object.keys(record).sort(),
            ...(typeof record.text === 'string'
              ? { text: textAtomShape(record.text) }
              : {}),
          }
        })
        const combined = payload.content
          .map(item => {
            const record = asRecord(item)
            return record && typeof record.text === 'string' ? record.text : ''
          })
          .filter(Boolean)
          .join('\n')
        return [{
          source: 'response_item',
          originalLineIndex,
          equalityClass: equalityClass(normalizeRecordedText(combined)),
          content,
        }]
      }
      return []
    })
}

function textAtomShape(text: string) {
  TEXT_WRAPPER_RE.lastIndex = 0
  const wrappers: Array<{ value: string; index: number }> = []
  let wrapper: RegExpExecArray | null
  while ((wrapper = TEXT_WRAPPER_RE.exec(text)) !== null) {
    wrappers.push({ value: wrapper[0], index: wrapper.index })
  }
  return {
    characterCount: text.length,
    byteSizeClass: sizeClass(Buffer.byteLength(text)),
    wrappers,
  }
}

function sizeClass(size: number): string {
  if (size === 0) return '0'
  if (size < 32) return '1-31'
  if (size < 128) return '32-127'
  if (size < 512) return '128-511'
  if (size < 2048) return '512-2047'
  if (size < 8192) return '2048-8191'
  return '8192+'
}

function normalizeRecordedText(text: string): string {
  return text
    .replace(/<user_input>\s*/gi, '')
    .replace(/\s*<\/user_input>/gi, '')
    .replace(/USER_MESSAGE_BEGIN[\r\n]*/g, '')
    .replace(/[\r\n]*USER_MESSAGE_END/g, '')
    .trim()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

function deterministicUuid(seed: string): string {
  const hex = sha256(seed).slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = '8'
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20, 32).join(''),
  ].join('-')
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object'
    ? value as JsonRecord
    : null
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function optionValue(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

function boundedSourcePrefix(
  fixtureId: string,
  sourceText: string,
  lineLimit: number,
): string {
  const lines = sourceText.split('\n')
  const availableLines = lines.at(-1) === '' ? lines.length - 1 : lines.length
  if (availableLines < lineLimit) {
    throw new Error(
      `${fixtureId}: source has ${availableLines} lines, below pinned limit ${lineLimit}`,
    )
  }
  // WHY a live source needs a boundary rather than an ever-changing file hash:
  // Codex appends the current conversation to one rollout. The fixture records
  // the exact prefix observed during the incident; later turns are different
  // evidence and must not silently rewrite a supposedly immutable test case.
  return `${lines.slice(0, lineLimit).join('\n')}\n`
}

async function printCorpusCensus(root: string): Promise<void> {
  const rows = new Map<string, { total: number; withUserEvent: number }>()
  for (const relativePath of await readdir(root, { recursive: true })) {
    if (!relativePath.endsWith('.jsonl')) continue
    const text = await readFile(resolve(root, relativePath), 'utf8')
    const parsed = text
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as JsonRecord]
        } catch {
          return []
        }
      })
    const sessionMeta = parsed.find(line => line.type === 'session_meta')
    const payload = asRecord(sessionMeta?.payload)
    if (!payload || typeof payload.cli_version !== 'string') continue
    const originator = typeof payload.originator === 'string'
      ? payload.originator
      : 'unknown'
    const key = `${payload.cli_version}\t${originator}`
    const row = rows.get(key) ?? { total: 0, withUserEvent: 0 }
    row.total += 1
    if (parsed.some(line => {
      const event = asRecord(line.payload)
      return line.type === 'event_msg' && event?.type === 'user_message'
    })) {
      row.withUserEvent += 1
    }
    rows.set(key, row)
  }

  // WHY the census emits only aggregate wire-shape counts: its job is to make
  // version drift measurable, while paths and prompt text remain private local
  // evidence. The fixture provenance hashes are the opt-in bridge back to a
  // particular recording when a maintainer has the source corpus.
  process.stdout.write('cliVersion\toriginator\trollouts\twithUserMessageEvent\n')
  for (const [key, row] of [...rows].sort(([left], [right]) =>
    left.localeCompare(right, undefined, { numeric: true })
  )) {
    process.stdout.write(`${key}\t${row.total}\t${row.withUserEvent}\n`)
  }
}
