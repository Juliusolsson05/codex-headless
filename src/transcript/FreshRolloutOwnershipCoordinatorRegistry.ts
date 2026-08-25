import { mkdir, readFile } from 'node:fs/promises'

import type { FSWatcher } from 'chokidar'
import { watch } from 'chokidar'

import { parseFreshRolloutCandidate } from './FreshRolloutClaim.js'
import { FreshRolloutOwnershipCoordinator } from './FreshRolloutOwnershipCoordinator.js'

const REGISTRY_SCHEMA_VERSION = 1
const REGISTRY_SYMBOL = Symbol.for(
  'codex-headless.fresh-rollout-ownership-coordinator-registry',
)
const ROLLOUT_CANDIDATE_READ_BYTES = 4 * 1024 * 1024
const CODEX_ROLLOUT_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

type RootEntry = {
  coordinator: FreshRolloutOwnershipCoordinator
  watcher: FSWatcher | null
  starting: Promise<void> | null
  stopping: Promise<void> | null
  readQueue: Promise<void>
  referenceCount: number
  errorListeners: Set<(error: Error) => void>
}

type Registry = {
  schemaVersion: number
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
      // independent registries would restore the very split-brain ownership
      // bug this process-wide boundary exists to remove. A loud startup error
      // is safer than silently tailing the same global rollout twice.
      throw new Error(
        `Incompatible fresh rollout coordinator registry schema ` +
          `${current.schemaVersion}; expected ${REGISTRY_SCHEMA_VERSION}`,
      )
    }
    return current
  }

  const created: Registry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
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
  let entry = registry.roots.get(root)
  if (!entry) {
    entry = {
      coordinator: new FreshRolloutOwnershipCoordinator({
        normalizeCwd: options.normalizeCwd,
        normalizePath: options.normalizePath,
      }),
      watcher: null,
      starting: null,
      stopping: null,
      readQueue: Promise.resolve(),
      referenceCount: 0,
      errorListeners: new Set(),
    }
    registry.roots.set(root, entry)
  }

  if (entry.stopping) await entry.stopping
  entry.referenceCount += 1
  entry.errorListeners.add(options.onError)
  try {
    await ensureWatcher(root, entry)
  } catch (error) {
    entry.referenceCount -= 1
    entry.errorListeners.delete(options.onError)
    if (entry.referenceCount === 0 && entry.watcher) {
      const failedWatcher = entry.watcher
      entry.watcher = null
      await failedWatcher.close().catch(() => undefined)
    }
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
      if (entry.referenceCount !== 0 || !entry.watcher) return

      const watcher = entry.watcher
      entry.watcher = null
      entry.stopping = (async () => {
        // WHY queued reads drain before closing the root lifecycle: otherwise a
        // read already admitted by chokidar could commit evidence and invoke a
        // participant after its owning CodexHeadless had completed cleanup.
        // Participant revocation still happens in the consumer first; draining
        // here closes the second half of that callback race.
        await entry?.readQueue
        await watcher.close()
      })().finally(() => {
        if (entry) entry.stopping = null
      })
      await entry.stopping
    },
  }
}

async function ensureWatcher(root: string, entry: RootEntry): Promise<void> {
  if (entry.starting) return entry.starting
  if (entry.watcher) return

  entry.starting = new Promise<void>((resolve, reject) => {
    let ready = false
    let settled = false
    const watcher = watch(root, {
      persistent: true,
      ignoreInitial: false,
      depth: 4,
    })
    entry.watcher = watcher

    const enqueue = (filePath: string): void => {
      if (!ready || !isRolloutPath(filePath)) return

      // WHY the observation sequence is reserved in the synchronous watcher
      // callback rather than after readFile resolves: prompt registration may
      // happen while a large prefix is being read. Its later sequence must not
      // retroactively claim evidence whose filesystem event was already visible.
      const observation = entry.coordinator.beginCandidateObservation(filePath)
      entry.readQueue = entry.readQueue
        .then(async () => {
          let raw: Buffer
          try {
            raw = await readFile(filePath)
          } catch {
            return
          }
          const prefix = raw
            .subarray(0, ROLLOUT_CANDIDATE_READ_BYTES)
            .toString('utf8')
          const candidate = parseFreshRolloutCandidate(filePath, prefix)
          if (!candidate) return
          entry.coordinator.commitCandidateObservation(observation, candidate, {
            readCapExceeded: raw.byteLength > ROLLOUT_CANDIDATE_READ_BYTES,
          })
        })
        .catch(error => emitError(entry, error))
    }

    watcher.on('add', enqueue)
    watcher.on('change', enqueue)
    watcher.on('ready', () => {
      if (settled) return
      ready = true
      settled = true
      resolve()
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

function isRolloutPath(filePath: string): boolean {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  return CODEX_ROLLOUT_RE.test(name)
}

function emitError(entry: RootEntry, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  for (const listener of entry.errorListeners) listener(normalized)
}
