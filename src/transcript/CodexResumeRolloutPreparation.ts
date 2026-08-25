import { randomUUID } from 'node:crypto'

import { collectRolloutLineageIds } from './ResumeForkCandidate.js'
import {
  findCodexRolloutByThreadId,
  readCodexRolloutGeneration,
} from './RolloutLocator.js'
import { getCodexSessionsDir } from './ProjectDir.js'
import {
  acquireFreshRolloutCoordinator,
  type FreshRolloutCoordinatorAcquisition,
} from './FreshRolloutOwnershipCoordinatorRegistry.js'
import type {
  FreshRolloutLease,
  ResumeRolloutParticipantDecision,
  ResumeRolloutParticipantHandle,
} from './FreshRolloutOwnershipCoordinator.js'
import { normalizeRolloutOwnershipPath } from './OwnershipNormalization.js'

const RESUME_LINEAGE_MIN_OVERLAP = 3
const RESUME_LINEAGE_ID_CAP = 8000
const PREPARATION_CONSTRUCTION_TOKEN = Symbol(
  'codex-headless.resume-rollout-preparation-construction',
)
const issuedResumeRolloutPreparations = new WeakSet<object>()
declare const resumeRolloutPreparationBrand: unique symbol

type PreparationHandlers = {
  onLease: (lease: FreshRolloutLease) => void
  onDecision: (decision: ResumeRolloutParticipantDecision) => void
}

/**
 * Public rollback authority returned by `prepareCodexResumeRollout`.
 *
 * WHY the public type exposes only disposal: exact paths, generations, owner
 * ids, lineage callbacks, and watcher handles are policy substrate, not data a
 * caller should reconstruct or mutate. Agent Code must be able to release the
 * pre-spawn reservation if PTY construction fails; CodexHeadless is the sole
 * consumer of every other operation through the issuer-checked internal view.
 */
export interface CodexResumeRolloutPreparation {
  readonly [resumeRolloutPreparationBrand]: never
  dispose(clean?: boolean): Promise<void>
}

/**
 * Opaque ownership capability prepared before the consumer spawns Codex.
 *
 * WHY this object exists instead of exporting coordinator primitives: provider
 * spawn is the last moment at which stronger resume evidence can be made
 * authoritative without racing reconstructed file Y. The package performs the
 * locator, exact reservation, lineage read, and participant registration as one
 * capability; Agent Code may move the spawn boundary around it but cannot
 * recreate or partially apply ownership policy.
 */
class CodexResumeRolloutPreparationImpl
  implements CodexResumeRolloutPreparation {
  declare readonly [resumeRolloutPreparationBrand]: never

  // WHY native private fields are required here rather than TypeScript's
  // `private` modifier: this object crosses the parent rollback window and is a
  // tempting target for generic logging. TS-private assignments are enumerable
  // JavaScript properties; `#` state is absent from own-key enumeration, object
  // spread, JSON serialization, and ordinary diagnostic inspection.
  #ownerId: string | null = randomUUID()
  #sessionsDir: string | null
  #initialPath: string | null
  #initialGenerationId: string | null
  #resumeThreadId: string | null
  #cwd: string | null
  #acquisition: FreshRolloutCoordinatorAcquisition | null
  #resumeParticipant: ResumeRolloutParticipantHandle | null = null
  #handlers: PreparationHandlers | null = null
  #pendingLeases: FreshRolloutLease[] = []
  #pendingDecisions: ResumeRolloutParticipantDecision[] = []
  #watcherReleasePromise: Promise<void> | null = null
  #consumed = false
  #disposed = false

  constructor(
    token: typeof PREPARATION_CONSTRUCTION_TOKEN,
    options: {
      sessionsDir: string
      initialPath: string | null
      initialGenerationId: string | null
      resumeThreadId: string
      cwd: string
      acquisition: FreshRolloutCoordinatorAcquisition | null
    },
  ) {
    if (token !== PREPARATION_CONSTRUCTION_TOKEN) {
      // WHY the implementation class being module-private is not sufficient:
      // any holder of a genuine object can recover `.constructor` reflectively.
      // The unexported token makes that recovered constructor fail closed.
      throw new TypeError(
        'Codex resume rollout capability must be created by ' +
          'prepareCodexResumeRollout()',
      )
    }
    this.#sessionsDir = options.sessionsDir
    this.#initialPath = options.initialPath
    this.#initialGenerationId = options.initialGenerationId
    this.#resumeThreadId = options.resumeThreadId
    this.#cwd = options.cwd
    this.#acquisition = options.acquisition
    issuedResumeRolloutPreparations.add(this)
    // Native private fields remain mutable after freeze. Preventing callers from
    // shadowing internal getters with forged own properties keeps the branded
    // instance's visible surface empty for its entire lifecycle.
    Object.freeze(this)
  }

  get ownerId(): string {
    this.#assertUsable()
    return this.#ownerId!
  }

  get sessionsDir(): string {
    this.#assertUsable()
    return this.#sessionsDir!
  }

  get initialPath(): string | null {
    this.#assertUsable()
    return this.#initialPath
  }

  get initialGenerationId(): string | null {
    this.#assertUsable()
    return this.#initialGenerationId
  }

  registerLineage(lineageIds: ReadonlySet<string>): void {
    this.#assertUsable()
    if (!this.#acquisition || !this.#initialPath || !this.#ownerId || !this.#cwd) {
      return
    }
    this.#resumeParticipant = this.#acquisition.coordinator.registerResumeParticipant({
      participantId: this.#ownerId,
      cwd: this.#cwd,
      lineageIds,
      requiredOverlapLimit: RESUME_LINEAGE_MIN_OVERLAP,
      // WHY callbacks buffer until CodexHeadless has opened exact tail X. Y may
      // appear immediately after provider spawn and before start() runs; losing
      // this callback would repair attribution but still leave the committed
      // channel pinned to X.
      onLease: lease => {
        if (this.#handlers) this.#handlers.onLease(lease)
        else this.#pendingLeases.push(lease)
      },
      onDecision: decision => {
        if (this.#handlers) this.#handlers.onDecision(decision)
        else this.#pendingDecisions.push(decision)
      },
    })
  }

  consume(options: {
    resumeThreadId: string
    cwd: string
    handlers: PreparationHandlers
  }): void {
    if (this.#consumed) throw new Error('Codex resume rollout preparation was already consumed')
    if (this.#disposed) throw new Error('Codex resume rollout preparation was disposed')
    if (options.resumeThreadId !== this.#resumeThreadId ||
      normalizeRolloutOwnershipPath(options.cwd) !==
        normalizeRolloutOwnershipPath(this.#cwd ?? '')) {
      throw new Error('Codex resume rollout preparation does not match this session')
    }
    this.#consumed = true
    this.#handlers = options.handlers
    for (const decision of this.#pendingDecisions.splice(0)) {
      try {
        options.handlers.onDecision(decision)
      } catch {
        // Diagnostics are observational. Live coordinator delivery already
        // isolates a throwing listener; buffered pre-start replay must preserve
        // the same contract or an Electron destroyed-window race can close a
        // valid exact X tail and kill the resumed provider. Lease callbacks are
        // deliberately not swallowed below because failure there changes
        // physical-tail ownership and must trigger transactional rollback.
      }
    }
    for (const lease of this.#pendingLeases.splice(0)) {
      options.handlers.onLease(lease)
    }
  }

  unregisterResumeParticipant(): void {
    this.#resumeParticipant?.unregister()
    this.#resumeParticipant = null
  }

  retirePathLease(filePath: string, clean: boolean): void {
    if (!this.#ownerId) return
    this.#acquisition?.coordinator.retirePathLease(
      this.#ownerId,
      filePath,
      clean,
    )
  }

  retireOwnerLeases(clean: boolean): void {
    if (!this.#ownerId) return
    this.#acquisition?.coordinator.retireOwnerLeases(this.#ownerId, clean)
  }

  releaseWatcher(): Promise<void> {
    if (!this.#watcherReleasePromise) {
      const acquisition = this.#acquisition
      this.#watcherReleasePromise = acquisition?.release() ?? Promise.resolve()
    }
    return this.#watcherReleasePromise
  }

  async dispose(clean = true): Promise<void> {
    if (this.#disposed) {
      await this.#watcherReleasePromise
      return
    }
    this.#disposed = true
    this.unregisterResumeParticipant()
    this.retireOwnerLeases(clean)
    try {
      await this.releaseWatcher()
    } finally {
      // WHY disposal is also the privacy boundary. The root coordinator keeps
      // only keyed equality/tombstone facts; this capability no longer needs raw
      // paths, cwd, provider id, generation, callbacks, or the acquisition graph
      // after its admitted watcher work drains. Scrub even when close reports an
      // error so a rejected cleanup promise cannot pin sensitive state forever.
      this.#ownerId = null
      this.#sessionsDir = null
      this.#initialPath = null
      this.#initialGenerationId = null
      this.#resumeThreadId = null
      this.#cwd = null
      this.#handlers = null
      this.#pendingLeases = []
      this.#pendingDecisions = []
      this.#resumeParticipant = null
      this.#acquisition = null
      this.#watcherReleasePromise = null
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error('Codex resume rollout preparation was disposed')
    }
  }
}

/** Internal view used only by CodexHeadless after issuer validation. */
export type CodexResumeRolloutPreparationInternal =
  CodexResumeRolloutPreparationImpl

export function unwrapCodexResumeRolloutPreparation(
  value: CodexResumeRolloutPreparation,
): CodexResumeRolloutPreparationInternal {
  if (typeof value !== 'object' || value === null ||
    !issuedResumeRolloutPreparations.has(value)) {
    // WHY neither a shape check nor instanceof is authority: a plain object can
    // reproduce the method names, and Object.create can reproduce the prototype.
    // WeakSet membership records the one fact neither forgery can manufacture:
    // this module's factory actually issued the object.
    throw new TypeError(
      'Codex resume rollout capability was not created by ' +
        'prepareCodexResumeRollout()',
    )
  }
  return value as CodexResumeRolloutPreparationImpl
}

export async function prepareCodexResumeRollout(options: {
  cwd: string
  resumeThreadId: string
  sessionsDir?: string
  onError?: (error: Error) => void
}): Promise<CodexResumeRolloutPreparation> {
  const sessionsDir = options.sessionsDir ?? getCodexSessionsDir()
  const initialLocation = await findCodexRolloutByThreadId(
    sessionsDir,
    options.resumeThreadId,
  )
  if (!initialLocation) {
    // WHY absence is still represented as a consumed pre-spawn capability:
    // CodexHeadless can deliberately enter its fail-closed new-file fallback,
    // while callers cannot accidentally skip preparation on the ordinary exact
    // route merely because both cases previously used one optional string.
    return new CodexResumeRolloutPreparationImpl(
      PREPARATION_CONSTRUCTION_TOKEN,
      {
        sessionsDir,
        initialPath: null,
        initialGenerationId: null,
        resumeThreadId: options.resumeThreadId,
        cwd: options.cwd,
        acquisition: null,
      },
    )
  }

  const acquisition = await acquireFreshRolloutCoordinator({
    sessionsRoot: sessionsDir,
    normalizeCwd: normalizeRolloutOwnershipPath,
    normalizePath: normalizeRolloutOwnershipPath,
    onError: options.onError ?? (() => undefined),
  })
  const preparation = new CodexResumeRolloutPreparationImpl(
    PREPARATION_CONSTRUCTION_TOKEN,
    {
      sessionsDir,
      initialPath: initialLocation.filePath,
      initialGenerationId: initialLocation.generationId,
      resumeThreadId: options.resumeThreadId,
      cwd: options.cwd,
      acquisition,
    },
  )
  const reserved = acquisition.coordinator.reservePath({
    ownerId: preparation.ownerId,
    filePath: initialLocation.filePath,
    kind: 'exact-id',
    proofIdentity: options.resumeThreadId,
  })
  if (!reserved) {
    await preparation.dispose(true)
    throw new Error('Codex exact rollout path is already leased by another live session')
  }

  try {
    const text = await readCodexRolloutGeneration(initialLocation)
    const lineageIds = new Set<string>()
    collectRolloutLineageIds(text, lineageIds, RESUME_LINEAGE_ID_CAP)
    preparation.registerLineage(lineageIds)
    return preparation
  } catch (error) {
    // No physical tail was opened, so a failed preparation may cleanly release
    // exact X for a later retry in the same process.
    await preparation.dispose(true)
    throw error
  }
}
