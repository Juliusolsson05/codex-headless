import { decompress as decompressWithFzstd } from 'fzstd'
import * as zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

type NativeZstd = typeof zlib & {
  zstdDecompressSync?: (
    input: ArrayBufferView,
    options?: {
      maxOutputLength?: number
      rejectGarbageAfterEnd?: boolean
    },
  ) => Buffer
}

type ZstdFrame = {
  contentSize: number
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
  const native = (zlib as NativeZstd).zstdDecompressSync
  if (typeof native === 'function') {
    return native(input, {
      maxOutputLength,
      rejectGarbageAfterEnd: true,
    })
  }

  const frame = inspectSingleZstdFrame(input)
  if (frame.contentSize > maxOutputLength) {
    throw new Error('zstd output exceeds the configured limit')
  }
  assertSingleFrameBoundary(input, frame)

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
  if (contentSizeBytes === 0) {
    // Unknown-size streaming frames are valid zstd, but fzstd cannot decode
    // them into a caller-bounded buffer without first trusting their window.
    // Native Node still accepts them under maxOutputLength; older runtimes fail
    // closed until the provider sends the observed size-bearing form.
    throw new Error('zstd frame does not declare its output size')
  }

  const contentSizeOffset = 5 + (singleSegment ? 0 : 1) + dictionaryBytes
  const headerBytes = contentSizeOffset + contentSizeBytes
  if (headerBytes > input.byteLength) throw new Error('truncated zstd frame header')
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
    // WHY concatenated frames are rejected only on the fallback path: fzstd's
    // bounded one-shot API reuses the supplied buffer per frame and concatenates
    // afterwards, which would allocate outside the advertised cap.
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
