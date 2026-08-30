import { decompress as decompressWithFzstd } from 'fzstd'
import * as zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

type NativeZstd = typeof zlib & {
  zstdDecompressSync?: (
    input: ArrayBufferView,
    options?: {
      maxOutputLength?: number
    },
  ) => Buffer
}

type ZstdFrame = {
  contentSize: number | null
  headerBytes: number
  checksum: boolean
}

/**
 * Decode one bounded Zstandard frame on every Node version supported by the
 * package.
 *
 * WHY there are two implementations: Node did not add its native zstd helpers
 * until 22.15, while codex-headless intentionally still supports Node 20.19.
 * Silently catching an undefined native helper made the exact rollout identity
 * feature disappear on a declared-supported runtime. The pure-JS fallback is
 * given an exact preallocated output buffer, and we reject unknown-size,
 * concatenated, or over-cap frames before it runs. That preserves the native
 * path's memory bound instead of replacing a compatibility bug with a
 * decompression allocation oracle.
 */
export function decompressZstdBounded(
  input: Uint8Array,
  maxOutputLength: number,
): Buffer {
  // WHY frame validation is shared by both decoders: Node's zstd one-shot API
  // accepts the first frame and silently ignores concatenated/trailing bytes.
  // That is useful for some streaming callers, but this boundary carries one
  // JSON request whose identity can claim a transcript. Requiring exactly one
  // structurally complete frame prevents an accepted prefix from laundering
  // unexamined bytes regardless of which Node runtime executes this package.
  const frame = inspectSingleZstdFrame(input)
  assertSingleFrameBoundary(input, frame)

  const native = (zlib as NativeZstd).zstdDecompressSync
  if (typeof native === 'function') {
    return native(input, {
      maxOutputLength,
    })
  }

  // fzstd intentionally does not validate the optional frame checksum. A
  // corrupted identity document can still be valid JSON, so treating its
  // output as authenticated enough to select a rollout would fail open. Older
  // Node versions therefore accept only the checksum-free provider shape we
  // recorded; checksum-bearing frames wait for native Node verification.
  if (frame.checksum) {
    throw new Error('checksummed zstd frames require native checksum validation')
  }
  if (frame.contentSize === null) {
    // Unknown-size frames are valid zstd, and native Node can enforce the cap
    // while decoding them. fzstd cannot receive a caller-owned bounded output
    // buffer without a declared size, so portable runtimes must fail closed.
    throw new Error('zstd frame does not declare its output size')
  }
  if (frame.contentSize > maxOutputLength) {
    throw new Error('zstd output exceeds the configured limit')
  }

  // WHY the output buffer is exact rather than merely capped: fzstd's
  // one-shot bounded API expects the caller to know the complete frame size.
  // Its parser would otherwise allocate from an attacker-controlled window
  // descriptor before our post-decode byte count could run.
  const output = new Uint8Array(frame.contentSize)
  const decoded = decompressWithFzstd(input, output)
  if (decoded.byteLength !== frame.contentSize) {
    throw new Error('zstd output size did not match its frame header')
  }
  return Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength)
}

function inspectSingleZstdFrame(input: Uint8Array): ZstdFrame {
  if (input.byteLength < 6 || readU32(input, 0) !== ZSTD_MAGIC) {
    throw new Error('not a zstd frame')
  }

  const descriptor = input[4]!
  if ((descriptor & 0x08) !== 0) {
    throw new Error('zstd frame uses a reserved descriptor bit')
  }
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const contentSizeFlag = descriptor >>> 6
  const dictionaryBytes = dictionaryFlag === 0
    ? 0
    : dictionaryFlag === 3
      ? 4
      : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0
    ? (singleSegment ? 1 : 0)
    : 1 << contentSizeFlag

  const contentSizeOffset = 5 + (singleSegment ? 0 : 1) + dictionaryBytes
  const headerBytes = contentSizeOffset + contentSizeBytes
  if (headerBytes > input.byteLength) throw new Error('truncated zstd frame header')
  if (contentSizeBytes === 0) {
    return { contentSize: null, headerBytes, checksum }
  }
  let size = readUnsignedLittleEndian(input, contentSizeOffset, contentSizeBytes)
  if (contentSizeFlag === 1) size += 256n
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('zstd frame output size is not safely representable')
  }
  return { contentSize: Number(size), headerBytes, checksum }
}

function assertSingleFrameBoundary(input: Uint8Array, frame: ZstdFrame): void {
  let offset = frame.headerBytes
  let last = false
  while (!last) {
    if (offset + 3 > input.byteLength) throw new Error('truncated zstd block header')
    const header = input[offset]! |
      (input[offset + 1]! << 8) |
      (input[offset + 2]! << 16)
    offset += 3
    last = (header & 1) !== 0
    const blockType = (header >>> 1) & 0x03
    const blockSize = header >>> 3
    if (blockType === 3) throw new Error('zstd frame uses a reserved block type')
    const payloadBytes = blockType === 1 ? 1 : blockSize
    offset += payloadBytes
    if (offset > input.byteLength) throw new Error('truncated zstd block payload')
  }
  if (frame.checksum) offset += 4
  if (offset !== input.byteLength) {
    throw new Error('zstd body contains trailing or concatenated frame bytes')
  }
}

function readU32(input: Uint8Array, offset: number): number {
  if (offset + 4 > input.byteLength) throw new Error('truncated zstd integer')
  return (
    input[offset]! |
    (input[offset + 1]! << 8) |
    (input[offset + 2]! << 16) |
    (input[offset + 3]! << 24)
  ) >>> 0
}

function readUnsignedLittleEndian(
  input: Uint8Array,
  offset: number,
  byteLength: number,
): bigint {
  let value = 0n
  for (let index = 0; index < byteLength; index += 1) {
    value |= BigInt(input[offset + index]!) << BigInt(index * 8)
  }
  return value
}
