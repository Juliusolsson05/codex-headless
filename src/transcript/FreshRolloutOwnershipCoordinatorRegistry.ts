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
const REGISTRY_SCHEMA_VERSION = 4
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
  // WHY these transport caches are visible on the private registry entry:
  // privacy regressions cannot be proved through coordinator inspection once
  // coordinator compaction has (correctly) erased its own raw paths. Keeping
  // count-only test visibility here lets the recorded system corpus detect a
  // watcher closure that still retains UUID-bearing paths without exposing any
  // path through the public package API.
  knownPaths: Set<string>
  lastFingerprints: Map<string, string>
  // WHY “no committed candidate” has two causally different meanings: an
  // immutable prefix may still be queued, or its completed bytes may genuinely
  // be invalid/incomplete. Coordinator policy cannot see the transport queue,
  // so maintenance needs this count to protect only the former. A count rather
  // than a Set handles multiple observations of one path without letting the
  // first completion erase evidence that a later read is still pending.
  pendingReadCounts: Map<string, number>
}

type Registry = {
  schemaVersion: number
  hmacKey: Buffer
  roots: Map<string, RootEntry>
}

export type FreshRolloutTransportInspection = Readonly<{
  knownPathCount: number
  lastFingerprintCount: number
  referenceCount: number
  activeWatcherCount: number
}>

export type FreshRolloutReadQueueTestGate = Readonly<{
  release(): void
  hasAdmittedRead(): boolean
  stopEventAdmission(): Promise<void>
}>

type RegistryBridge = Readonly<{
  schemaVersion: number
  begin(options: FreshRolloutCoordinatorOptions):
    StartingFreshRolloutCoordinatorAcquisition
  inspectTransportForTesting(
    coordinator: FreshRolloutOwnershipCoordinator,
  ): FreshRolloutTransportInspection
  holdReadQueueForTesting(
    coordinator: FreshRolloutOwnershipCoordinator,
  ): FreshRolloutReadQueueTestGate
  suppressChangeEventsForTesting(
    coordinator: FreshRolloutOwnershipCoordinator,
  ): void
  emitChangeAndDrainForTesting(
    coordinator: FreshRolloutOwnershipCoordinator,
    filePath: string,
  ): Promise<void>
}>

type FreshRolloutCoordinatorOptions = {
  sessionsRoot: string
  normalizeCwd: (cwd: string) => string
  normalizePath: (filePath: string) => string
  onError: (error: Error) => void
}

export type FreshRolloutCoordinatorAcquisition = {
  coordinator: FreshRolloutOwnershipCoordinator
  release(): Promise<void>
}

export type StartingFreshRolloutCoordinatorAcquisition =
  FreshRolloutCoordinatorAcquisition & {
    ready: Promise<void>
  }

function getRegistryBridge(): RegistryBridge {
  const globalWithRegistry = globalThis as typeof globalThis & {
    [REGISTRY_SYMBOL]?: RegistryBridge
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
    if (!Object.isFrozen(current) ||
      typeof current.begin !== 'function' ||
      typeof current.inspectTransportForTesting !== 'function' ||
      typeof current.holdReadQueueForTesting !== 'function' ||
      typeof current.suppressChangeEventsForTesting !== 'function' ||
      typeof current.emitChangeAndDrainForTesting !== 'function') {
      throw new Error('Malformed fresh rollout coordinator registry bridge')
    }
    installRegistryBridge(globalWithRegistry, current)
    return current
  }

  // WHY the symbol is the only identity duplicate compiled package copies can
  // share. Publishing this Registry object directly made Symbol.for() a
  // process-wide state exfiltration API: reflection reached maps, coordinator,
  // raw paths, participant ids, and the root HMAC key. The frozen bridge keeps
  // only functions and a schema primitive on the global graph. Those functions
  // execute in the first-loaded module's closure, so later copies still share
  // one arbiter without receiving a reference to its Registry or RootEntry.
  const registry: Registry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    hmacKey: randomBytes(32),
    roots: new Map(),
  }
  const created = Object.freeze<RegistryBridge>({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    begin: options => beginWithRegistry(registry, options),
    inspectTransportForTesting: coordinator =>
      inspectTransportWithRegistry(registry, coordinator),
    holdReadQueueForTesting: coordinator =>
      holdReadQueueWithRegistry(registry, coordinator),
    suppressChangeEventsForTesting: coordinator =>
      suppressChangeEventsWithRegistry(registry, coordinator),
    emitChangeAndDrainForTesting: (coordinator, filePath) =>
      emitChangeAndDrainWithRegistry(registry, coordinator, filePath),
  })
  installRegistryBridge(globalWithRegistry, created)
  return created
}

function installRegistryBridge(
  target: typeof globalThis & { [REGISTRY_SYMBOL]?: RegistryBridge },
  bridge: RegistryBridge,
): void {
  // WHY freezing the bridge protects its own fields but not the symbol slot.
  // A writable/configurable global lets any later same-process module replace
  // the bridge and silently create a second ownership graph. Defining the slot
  // as a hidden immutable authority makes duplicate package copies converge on
  // the first bridge and makes attempted reassignment fail instead of splitting
  // watcher/coordinator state. Re-defining the same value also upgrades a
  // configurable v4 slot installed by an earlier hot-reloaded build.
  try {
    Object.defineProperty(target, REGISTRY_SYMBOL, {
      value: bridge,
      writable: false,
      configurable: false,
      enumerable: false,
    })
  } catch {
    throw new Error('Fresh rollout coordinator registry bridge is not immutable')
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, REGISTRY_SYMBOL)
  if (descriptor?.value !== bridge || descriptor.writable ||
    descriptor.configurable || descriptor.enumerable) {
    throw new Error('Fresh rollout coordinator registry bridge is not immutable')
  }
}

export async function acquireFreshRolloutCoordinator(
  options: FreshRolloutCoordinatorOptions,
): Promise<FreshRolloutCoordinatorAcquisition> {
  const starting = beginFreshRolloutCoordinatorAcquisition(options)
  await starting.ready
  return starting
}

/**
 * Reserve the process-wide coordinator synchronously, then prime its watcher.
 *
 * WHY this split exists: an async function yields at `mkdir()` before its
 * caller can register a participant. Agent Code intentionally publishes the
 * already-spawned terminal while `CodexHeadless.start()` is pending, so a human
 * can submit during that yield. The coordinator sequence must record that
 * prompt immediately; replaying it after watcher readiness would falsely make
 * an older durable candidate appear causal. Consumers that do not need this
 * boundary should continue using `acquireFreshRolloutCoordinator()`.
 */
export function beginFreshRolloutCoordinatorAcquisition(
  options: FreshRolloutCoordinatorOptions,
): StartingFreshRolloutCoordinatorAcquisition {
  return getRegistryBridge().begin(options)
}

function beginWithRegistry(
  registry: Registry,
  options: FreshRolloutCoordinatorOptions,
): StartingFreshRolloutCoordinatorAcquisition {
  const root = options.normalizePath(options.sessionsRoot)
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
      knownPaths: new Set(),
      lastFingerprints: new Map(),
      pendingReadCounts: new Map(),
    }
    registry.roots.set(rootFingerprint, entry)
  }

  entry.referenceCount += 1
  entry.errorListeners.add(options.onError)
  const acquiredEntry = entry
  let released = false
  let referenceHeld = true
  const ready = (async () => {
    try {
      await mkdir(options.sessionsRoot, { recursive: true })
      if (acquiredEntry.stopping) await acquiredEntry.stopping
      await ensureWatcher(root, acquiredEntry)
    } catch (error) {
      if (referenceHeld) {
        referenceHeld = false
        acquiredEntry.referenceCount = Math.max(
          0,
          acquiredEntry.referenceCount - 1,
        )
        acquiredEntry.errorListeners.delete(options.onError)
        if (acquiredEntry.referenceCount === 0) {
          await stopRootWatcher(acquiredEntry)
        }
      }
      throw error
    }
  })()
  return {
    coordinator: acquiredEntry.coordinator,
    ready,
    release: async () => {
      if (released) return
      released = true
      // WHY readiness may fail or stop may race watcher priming. Joining it
      // prevents a late ensureWatcher() from installing transport after this
      // reference was retired; the rejection is still observed by start().
      try { await ready } catch { /* acquisition caller owns the error */ }
      if (!referenceHeld) return
      referenceHeld = false
      acquiredEntry.errorListeners.delete(options.onError)
      acquiredEntry.referenceCount = Math.max(
        0,
        acquiredEntry.referenceCount - 1,
      )
      if (acquiredEntry.referenceCount !== 0) {
        // WHY watcher transport is shared but participant lifetime is not. A
        // long-lived sibling keeps filesystem admission open; it must not keep
        // every stopped sibling's prompt/lineage HMAC in the graph forever.
        // Arm the same grace timer used at final shutdown, with expiry ordered
        // behind the reads admitted before that timer fires.
        scheduleInactiveRetention(acquiredEntry)
        return
      }
      await stopRootWatcher(acquiredEntry)
    },
  }
}

/**
 * Return only aggregate transport state for a coordinator already held by the
 * caller. This is deliberately not a general registry enumeration API.
 */
export function inspectFreshRolloutTransportForTesting(
  coordinator: FreshRolloutOwnershipCoordinator,
): FreshRolloutTransportInspection {
  return getRegistryBridge().inspectTransportForTesting(coordinator)
}

/**
 * Install a deterministic queue barrier without exposing the queue or root.
 */
export function holdFreshRolloutReadQueueForTesting(
  coordinator: FreshRolloutOwnershipCoordinator,
): FreshRolloutReadQueueTestGate {
  return getRegistryBridge().holdReadQueueForTesting(coordinator)
}

/** Remove only change-event admission for the caller's held coordinator. */
export function suppressFreshRolloutChangeEventsForTesting(
  coordinator: FreshRolloutOwnershipCoordinator,
): void {
  getRegistryBridge().suppressChangeEventsForTesting(coordinator)
}

/** Deliver one synthetic watcher event and join every read it admitted. */
export function emitFreshRolloutChangeAndDrainForTesting(
  coordinator: FreshRolloutOwnershipCoordinator,
  filePath: string,
): Promise<void> {
  return getRegistryBridge().emitChangeAndDrainForTesting(
    coordinator,
    filePath,
  )
}

function rootEntryForCoordinator(
  registry: Registry,
  coordinator: FreshRolloutOwnershipCoordinator,
): RootEntry {
  for (const entry of registry.roots.values()) {
    if (entry.coordinator === coordinator) return entry
  }
  // WHY test controls must be rooted in a capability the caller already
  // possesses. Accepting a root path or registry key would both reveal the
  // process inventory and recreate the raw identity channel Stage 39 removes.
  throw new Error('Fresh rollout transport is not held by this coordinator')
}

function inspectTransportWithRegistry(
  registry: Registry,
  coordinator: FreshRolloutOwnershipCoordinator,
): FreshRolloutTransportInspection {
  const entry = rootEntryForCoordinator(registry, coordinator)
  // WHY the object is a value snapshot, not a live view. Returning collections,
  // iterators, callbacks over entries, or even a mutable wrapper would let test
  // code walk back into the RootEntry. Counts and one lifecycle boolean are the
  // complete evidence required by the recorded retention contracts.
  return Object.freeze({
    knownPathCount: entry.knownPaths.size,
    lastFingerprintCount: entry.lastFingerprints.size,
    referenceCount: entry.referenceCount,
    activeWatcherCount: entry.watcher === null ? 0 : 1,
  })
}

function holdReadQueueWithRegistry(
  registry: Registry,
  coordinator: FreshRolloutOwnershipCoordinator,
): FreshRolloutReadQueueTestGate {
  const entry = rootEntryForCoordinator(registry, coordinator)
  let releaseGate!: () => void
  let released = false
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const installedQueue = entry.readQueue.then(() => gate)
  entry.readQueue = installedQueue

  // WHY the capability exposes behavior, never the Promise or watcher. The
  // generation-race recordings need to place real callbacks behind a causal
  // barrier and close further admission, but neither operation requires
  // reflecting a RootEntry or mutating its fields from the test process.
  return Object.freeze({
    release: () => {
      if (released) return
      released = true
      releaseGate()
    },
    hasAdmittedRead: () => entry.readQueue !== installedQueue,
    stopEventAdmission: async () => {
      entry.stopWatcherMaintenance?.()
      entry.stopWatcherMaintenance = null
      const watcher = entry.watcher
      entry.watcher = null
      await watcher?.close()
    },
  })
}

function suppressChangeEventsWithRegistry(
  registry: Registry,
  coordinator: FreshRolloutOwnershipCoordinator,
): void {
  rootEntryForCoordinator(registry, coordinator)
    .watcher?.removeAllListeners('change')
}

async function emitChangeAndDrainWithRegistry(
  registry: Registry,
  coordinator: FreshRolloutOwnershipCoordinator,
  filePath: string,
): Promise<void> {
  const entry = rootEntryForCoordinator(registry, coordinator)
  entry.watcher?.emit('change', filePath)
  await entry.readQueue
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
    compactInactiveTransport(entry)
    entry.coordinator.clearStaleCandidateGenerations()
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
    // WHY the timer marks the end of the provider-file grace, but cannot jump
    // ahead of a prefix read already admitted during that grace. Appending the
    // expiry to readQueue preserves that causal barrier without stopping the
    // shared watcher needed by live siblings. Events admitted after the timer
    // are outside this stopped participant's bounded ownership window.
    entry.readQueue = entry.readQueue
      // Candidate paths are callback transport, not durable ownership facts.
      // Once the stopped-owner grace closes behind admitted reads, scrub those
      // raw paths even when a sibling keeps chokidar live. A later append
      // restores the path from its new immutable observation before policy is
      // recomputed; HMAC equality evidence remains available throughout.
      .then(() => compactInactiveTransport(entry))
      .catch(error => emitError(entry, error))
    void entry.readQueue.then(() => scheduleInactiveRetention(entry))
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
      entry.knownPaths.add(reserved.filePath)
      entry.lastFingerprints.set(
        reserved.filePath,
        reserved.snapshot.fingerprint,
      )
      entry.pendingReadCounts.set(
        reserved.filePath,
        (entry.pendingReadCounts.get(reserved.filePath) ?? 0) + 1,
      )
      entry.readQueue = entry.readQueue
        .then(async () => {
          try {
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
          } finally {
            const pendingReads =
              (entry.pendingReadCounts.get(reserved.filePath) ?? 1) - 1
            if (pendingReads <= 0) {
              entry.pendingReadCounts.delete(reserved.filePath)
            } else {
              entry.pendingReadCounts.set(reserved.filePath, pendingReads)
            }
            // WHY an event can be admitted before compaction but run after it.
            // `enqueue` necessarily restores its path so the immutable read can
            // complete, but a terminal candidate (blocked, quarantined, leased,
            // or otherwise path-leased) can never need another rescan. Evict it
            // at the end of this callback or one delayed chokidar event retains
            // a UUID-bearing path indefinitely while an unrelated sibling keeps
            // the shared watcher alive.
            if (entry.coordinator.isCandidateTransportTerminal(
              reserved.filePath,
            )) {
              entry.knownPaths.delete(reserved.filePath)
              entry.lastFingerprints.delete(reserved.filePath)
            }
          }
        })
        .catch(error => emitError(entry, error))
    }

    watcher.on('add', (filePath: string) => {
      if (!isRolloutPath(filePath)) return
      const snapshot = snapshotFile(filePath)
      if (!snapshot) return
      if (!ready && snapshot.mtimeMs <
        watchStartedAt - RECENT_INITIAL_FILE_GRACE_MS) {
        // WHY remember a content-safe generation HMAC even though we reject the
        // old corpus entry itself: on filesystems without birth time, a later
        // change is otherwise indistinguishable from creation. We retain no
        // parsed candidate, path, UUID, or prompt—only path+inode equality—and
        // clear the map when the root watcher fully stops.
        entry.coordinator.rememberStaleCandidateGeneration(
          filePath,
          snapshot.generationId,
        )
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
              for (const filePath of entry.knownPaths) {
                if (maintenanceStopped) break
                if ((entry.pendingReadCounts.get(filePath) ?? 0) > 0) {
                  // WHY coordinator absence is not yet policy evidence while
                  // an immutable prefix read is queued. Skipping here—not
                  // returning true forever from coordinator policy—preserves
                  // the pre-registration callback without retaining a path
                  // after an invalid completed read and inactive claimants.
                  continue
                }
                if (!entry.coordinator.requiresCandidateRescan(filePath)) {
                  // WHY policy can turn false without another filesystem
                  // callback: exact reservation, generation exclusion, and
                  // lineage leasing are coordinator transitions, not writes.
                  // Check the graph before the unchanged-fingerprint shortcut
                  // or a live sibling retains this UUID-bearing path forever.
                  // The pending-read guard above preserves pre-registration
                  // callback order; after completion, only actual live claimant
                  // policy may retain an incomplete file for another rescan.
                  entry.coordinator.compactCandidateTransportPath(filePath)
                  entry.knownPaths.delete(filePath)
                  entry.lastFingerprints.delete(filePath)
                  continue
                }
                const snapshot = snapshotFile(filePath)
                if (!snapshot ||
                  entry.lastFingerprints.get(filePath) === snapshot.fingerprint) {
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
    const openedStat = await handle.stat()
    const openedGenerationId = `${openedStat.dev}:${openedStat.ino}`
    if (openedGenerationId !== reserved.snapshot.generationId ||
      openedStat.size < reserved.snapshot.byteLength) {
      // WHY stat(path) and open(path) are not one operation. An atomic rename
      // can replace inode A with old recorded inode B while this read waits in
      // the serialized queue. Committing B's bytes with A's eligible birth and
      // generation metadata would let old copied history lease as a fresh
      // rollout. fstat binds the opened handle back to the reserved generation;
      // a later watcher observation may reconsider B under B's own metadata.
      return null
    }
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
  for (const listener of entry.errorListeners) {
    try {
      listener(normalized)
    } catch {
      // WHY an observer cannot become the rejection value of readQueue or
      // maintenanceQueue. Every future task chains from that promise; allowing
      // one EventEmitter listener to throw here skips later recorded candidates
      // and can also prevent watcher shutdown from ever crossing its drain.
    }
  }
}

function compactInactiveTransport(entry: RootEntry): void {
  const watcherRemainsLive = entry.referenceCount > 0
  entry.coordinator.compactInactiveState(Date.now(), watcherRemainsLive)
  // WHY raw paths are callback transport, not a single all-or-nothing cache.
  // Terminal candidates are erased immediately, but an unresolved candidate
  // that can still gain prompt/lineage evidence for a live participant must
  // remain in the 500ms poll set: the entire purpose of that poll is recovering
  // a coalesced or omitted filesystem event. Final watcher shutdown retains
  // nothing because no future rescan can consume the path.
  for (const filePath of entry.knownPaths) {
    if (watcherRemainsLive &&
      entry.coordinator.requiresCandidateRescan(filePath)) {
      continue
    }
    entry.knownPaths.delete(filePath)
    entry.lastFingerprints.delete(filePath)
  }
  for (const filePath of entry.lastFingerprints.keys()) {
    if (!entry.knownPaths.has(filePath)) {
      entry.lastFingerprints.delete(filePath)
    }
  }
}
