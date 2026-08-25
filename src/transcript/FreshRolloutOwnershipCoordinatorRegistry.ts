import { createHmac, randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'

import type { FSWatcher } from 'chokidar'
import { watch } from 'chokidar'

import { parseFreshRolloutCandidate } from './FreshRolloutClaim.js'
import {
  FreshRolloutOwnershipCoordinator,
  type FreshRolloutCandidateObservation,
} from './FreshRolloutOwnershipCoordinator.js'

// WHY this schema number covers the process-global object layout, not the npm
// API. A dev process can load two compiled copies during hot reload; accepting
// a v1 registry here would mix the old raw-evidence coordinator with the new
// HMAC/tombstone semantics and silently recreate split-brain ownership.
const REGISTRY_SCHEMA_VERSION = 3
const REGISTRY_SYMBOL = Symbol.for(
  'codex-headless.fresh-rollout-ownership-coordinator-registry',
)
const ROLLOUT_CANDIDATE_READ_BYTES = 4 * 1024 * 1024
const CANDIDATE_RESCAN_MS = 500
const RECENT_INITIAL_FILE_GRACE_MS = 5000
const CODEX_ROLLOUT_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

type FileSnapshot = {
  byteLength: number
  mtimeMs: number
  birthtimeMs: number | null
  generationId: string
  fingerprint: string
}

type ReservedObservation = {
  filePath: string
  snapshot: FileSnapshot
  observation: FreshRolloutCandidateObservation
}

type RootEntry = {
  coordinator: FreshRolloutOwnershipCoordinator
  watcher: FSWatcher | null
  starting: Promise<void> | null
  stopping: Promise<void> | null
  stopWatcherMaintenance: (() => void) | null
  retentionTimer: ReturnType<typeof setTimeout> | null
  maintenanceQueue: Promise<void>
  readQueue: Promise<void>
  referenceCount: number
  errorListeners: Set<(error: Error) => void>
}

type Registry = {
  schemaVersion: number
  hmacKey: Buffer
  roots: Map<string, RootEntry>
}

export type FreshRolloutCoordinatorAcquisition = {
  coordinator: FreshRolloutOwnershipCoordinator
  release(): Promise<void>
}

function getRegistry(): Registry {
  const globalWithRegistry = globalThis as typeof globalThis & {
    [REGISTRY_SYMBOL]?: Registry
  }
  const current = globalWithRegistry[REGISTRY_SYMBOL]
  if (current) {
    if (current.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
      // WHY incompatible duplicate package copies must fail closed: two
      // independent registries restore split-brain candidate visibility.
      throw new Error(
        `Incompatible fresh rollout coordinator registry schema ` +
          `${current.schemaVersion}; expected ${REGISTRY_SCHEMA_VERSION}`,
      )
    }
    return current
  }

  const created: Registry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    hmacKey: randomBytes(32),
    roots: new Map(),
  }
  globalWithRegistry[REGISTRY_SYMBOL] = created
  return created
}

export async function acquireFreshRolloutCoordinator(options: {
  sessionsRoot: string
  normalizeCwd: (cwd: string) => string
  normalizePath: (filePath: string) => string
  onError: (error: Error) => void
}): Promise<FreshRolloutCoordinatorAcquisition> {
  await mkdir(options.sessionsRoot, { recursive: true })
  const root = options.normalizePath(options.sessionsRoot)
  const registry = getRegistry()
  // WHY the raw sessions root is needed only by the live watcher. Keeping it
  // as a global Map key leaked every private CODEX_HOME for the process
  // lifetime even after all candidate evidence was scrubbed.
  const rootFingerprint = createHmac('sha256', registry.hmacKey)
    .update('sessions-root\0')
    .update(root)
    .digest('hex')
  let entry = registry.roots.get(rootFingerprint)
  if (!entry) {
    entry = {
      coordinator: new FreshRolloutOwnershipCoordinator({
        normalizeCwd: options.normalizeCwd,
        normalizePath: options.normalizePath,
      }),
      watcher: null,
      starting: null,
      stopping: null,
      stopWatcherMaintenance: null,
      retentionTimer: null,
      maintenanceQueue: Promise.resolve(),
      readQueue: Promise.resolve(),
      referenceCount: 0,
      errorListeners: new Set(),
    }
    registry.roots.set(rootFingerprint, entry)
  }

  if (entry.stopping) await entry.stopping
  entry.referenceCount += 1
  entry.errorListeners.add(options.onError)
  try {
    await ensureWatcher(root, entry)
  } catch (error) {
    entry.referenceCount -= 1
    entry.errorListeners.delete(options.onError)
    if (entry.referenceCount === 0) await stopRootWatcher(entry)
    throw error
  }

  let released = false
  return {
    coordinator: entry.coordinator,
    release: async () => {
      if (released) return
      released = true
      entry?.errorListeners.delete(options.onError)
      if (!entry) return
      entry.referenceCount = Math.max(0, entry.referenceCount - 1)
      if (entry.referenceCount !== 0) return
      await stopRootWatcher(entry)
    },
  }
}

async function stopRootWatcher(entry: RootEntry): Promise<void> {
  if (entry.stopping) return entry.stopping
  const watcher = entry.watcher
  entry.watcher = null
  entry.stopWatcherMaintenance?.()
  entry.stopWatcherMaintenance = null
  entry.stopping = (async () => {
    // WHY close comes before queue drains: awaiting a Promise snapshots that
    // queue only at that instant. If chokidar stayed open, a later callback
    // could append a read after our await and race compaction. Closing admission
    // first, then maintenance (which may enqueue), then reads creates a real
    // causal barrier before stopped-owner tombstones are removed.
    await watcher?.close()
    await entry.maintenanceQueue
    await entry.readQueue
    entry.coordinator.compactInactiveState()
    scheduleInactiveRetention(entry)
  })().finally(() => {
    entry.stopping = null
  })
  await entry.stopping
}

function scheduleInactiveRetention(entry: RootEntry): void {
  if (entry.retentionTimer) clearTimeout(entry.retentionTimer)
  entry.retentionTimer = null
  const delay = entry.coordinator.millisecondsUntilInactiveExpiry()
  if (delay === null) return

  // WHY this timer begins only after watcher admission/read drain: an earlier
  // queued observation can legitimately take longer than the grace interval.
  // Once drained, retaining each stopped prompt HMAC until its generation
  // window closes protects provider flushes that occur before parent PTY kill.
  entry.retentionTimer = setTimeout(() => {
    entry.retentionTimer = null
    entry.coordinator.expireInactiveParticipants()
    scheduleInactiveRetention(entry)
  }, Math.max(1, delay))
  entry.retentionTimer.unref?.()
}

async function ensureWatcher(root: string, entry: RootEntry): Promise<void> {
  if (entry.starting) return entry.starting
  if (entry.watcher) return

  entry.starting = new Promise<void>((resolve, reject) => {
    let ready = false
    let settled = false
    let maintenanceStopped = false
    const watchStartedAt = Date.now()
    const knownPaths = new Set<string>()
    const lastFingerprints = new Map<string, string>()
    const primedObservations: ReservedObservation[] = []
    const watcher = watch(root, {
      persistent: true,
      ignoreInitial: false,
      depth: 4,
    })
    entry.watcher = watcher

    const reserve = (
      filePath: string,
      knownSnapshot?: FileSnapshot,
    ): ReservedObservation | null => {
      if (!isRolloutPath(filePath)) return null
      const snapshot = knownSnapshot ?? snapshotFile(filePath)
      if (!snapshot) return null
      return {
        filePath,
        snapshot,
        observation: entry.coordinator.beginCandidateObservation(filePath, {
          byteLength: snapshot.byteLength,
          generationId: snapshot.generationId,
          birthtimeMs: snapshot.birthtimeMs ?? undefined,
        }),
      }
    }

    const enqueue = (reserved: ReservedObservation): void => {
      knownPaths.add(reserved.filePath)
      lastFingerprints.set(reserved.filePath, reserved.snapshot.fingerprint)
      entry.readQueue = entry.readQueue
        .then(async () => {
          const prefix = await readReservedPrefix(reserved)
          if (prefix === null) return
          const candidate = parseFreshRolloutCandidate(
            reserved.filePath,
            prefix,
          )
          if (!candidate) return
          entry.coordinator.commitCandidateObservation(
            reserved.observation,
            candidate,
            {
              readCapExceeded:
                reserved.snapshot.byteLength > ROLLOUT_CANDIDATE_READ_BYTES,
            },
          )
        })
        .catch(error => emitError(entry, error))
    }

    watcher.on('add', (filePath: string) => {
      if (!isRolloutPath(filePath)) return
      const snapshot = snapshotFile(filePath)
      if (!snapshot) return
      if (!ready && snapshot.mtimeMs <
        watchStartedAt - RECENT_INITIAL_FILE_GRACE_MS) {
        // WHY reject old corpus entries before retaining their observations:
        // an initial scan can contain years of rollouts. They cannot belong to
        // a just-started PTY, so even HMAC-only revisions would be needless
        // process-lifetime state and would make the privacy bound misleading.
        return
      }
      const reserved = reserve(filePath, snapshot)
      if (!reserved) return
      if (ready) enqueue(reserved)
      else primedObservations.push(reserved)
    })
    watcher.on('change', (filePath: string) => {
      if (!ready) return
      const reserved = reserve(filePath)
      if (reserved) enqueue(reserved)
    })
    watcher.on('ready', () => {
      if (settled) return
      settled = true
      ready = true
      try {
        for (const primed of primedObservations) {
          if (primed.snapshot.mtimeMs <
            watchStartedAt - RECENT_INITIAL_FILE_GRACE_MS) {
            continue
          }
          enqueue(primed)
        }
        primedObservations.length = 0

        // WHY this poll transports evidence but never decides ownership:
        // chokidar may coalesce the append containing the prompt. A changed
        // inode/size/mtime admits another immutable prefix with a new causal
        // sequence; mutual uniqueness and leases remain the only accept rule.
        const rescanTimer = setInterval(() => {
          if (maintenanceStopped) return
          entry.maintenanceQueue = entry.maintenanceQueue
            .then(() => {
              for (const filePath of knownPaths) {
                if (maintenanceStopped) break
                const snapshot = snapshotFile(filePath)
                if (!snapshot ||
                  lastFingerprints.get(filePath) === snapshot.fingerprint) {
                  continue
                }
                const reserved = reserve(filePath, snapshot)
                if (!maintenanceStopped && reserved) enqueue(reserved)
              }
            })
            .catch(error => emitError(entry, error))
        }, CANDIDATE_RESCAN_MS)
        rescanTimer.unref?.()
        entry.stopWatcherMaintenance = () => {
          maintenanceStopped = true
          clearInterval(rescanTimer)
        }
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    watcher.on('error', (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error))
      emitError(entry, normalized)
      if (!settled) {
        settled = true
        reject(normalized)
      }
    })
  }).finally(() => {
    entry.starting = null
  })
  return entry.starting
}

async function readReservedPrefix(
  reserved: ReservedObservation,
): Promise<string | null> {
  let handle
  try {
    handle = await open(reserved.filePath, 'r')
    const byteLength = Math.min(
      reserved.snapshot.byteLength,
      ROLLOUT_CANDIDATE_READ_BYTES,
    )
    const buffer = Buffer.alloc(byteLength)
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function snapshotFile(filePath: string): FileSnapshot | null {
  try {
    const fileStat = statSync(filePath)
    if (!fileStat.isFile()) return null
    const generationId = `${fileStat.dev}:${fileStat.ino}`
    return {
      byteLength: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      // Some filesystems report zero when birth time is unavailable. Treating
      // zero as a real 1970 generation would disable the sequence fallback and
      // could let a delayed stopped-owner rollout cross-wire to its sibling.
      birthtimeMs: fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : null,
      generationId,
      fingerprint: `${generationId}:${fileStat.size}:${fileStat.mtimeMs}`,
    }
  } catch {
    return null
  }
}

function isRolloutPath(filePath: string): boolean {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  return CODEX_ROLLOUT_RE.test(name)
}

function emitError(entry: RootEntry, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  for (const listener of entry.errorListeners) listener(normalized)
}
