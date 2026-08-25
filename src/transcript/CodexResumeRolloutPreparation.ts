import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { collectRolloutLineageIds } from './ResumeForkCandidate.js'
import { findCodexRolloutPathByThreadId } from './RolloutLocator.js'
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

type PreparationHandlers = {
  onLease: (lease: FreshRolloutLease) => void
  onDecision: (decision: ResumeRolloutParticipantDecision) => void
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
export class CodexResumeRolloutPreparation {
  readonly ownerId = randomUUID()
  readonly sessionsDir: string
  readonly initialPath: string | null
  readonly resumeThreadId: string
  readonly cwd: string

  private acquisition: FreshRolloutCoordinatorAcquisition | null
  private resumeParticipant: ResumeRolloutParticipantHandle | null = null
  private handlers: PreparationHandlers | null = null
  private pendingLeases: FreshRolloutLease[] = []
  private pendingDecisions: ResumeRolloutParticipantDecision[] = []
  private watcherReleasePromise: Promise<void> | null = null
  private consumed = false
  private disposed = false

  constructor(options: {
    sessionsDir: string
    initialPath: string | null
    resumeThreadId: string
    cwd: string
    acquisition: FreshRolloutCoordinatorAcquisition | null
  }) {
    this.sessionsDir = options.sessionsDir
    this.initialPath = options.initialPath
    this.resumeThreadId = options.resumeThreadId
    this.cwd = options.cwd
    this.acquisition = options.acquisition
  }

  registerLineage(lineageIds: ReadonlySet<string>): void {
    if (!this.acquisition || !this.initialPath) return
    this.resumeParticipant = this.acquisition.coordinator.registerResumeParticipant({
      participantId: this.ownerId,
      cwd: this.cwd,
      lineageIds,
      requiredOverlapLimit: RESUME_LINEAGE_MIN_OVERLAP,
      // WHY callbacks buffer until CodexHeadless has opened exact tail X. Y may
      // appear immediately after provider spawn and before start() runs; losing
      // this callback would repair attribution but still leave the committed
      // channel pinned to X.
      onLease: lease => {
        if (this.handlers) this.handlers.onLease(lease)
        else this.pendingLeases.push(lease)
      },
      onDecision: decision => {
        if (this.handlers) this.handlers.onDecision(decision)
        else this.pendingDecisions.push(decision)
      },
    })
  }

  consume(options: {
    resumeThreadId: string
    cwd: string
    handlers: PreparationHandlers
  }): void {
    if (this.consumed) throw new Error('Codex resume rollout preparation was already consumed')
    if (this.disposed) throw new Error('Codex resume rollout preparation was disposed')
    if (options.resumeThreadId !== this.resumeThreadId ||
      normalizeRolloutOwnershipPath(options.cwd) !==
        normalizeRolloutOwnershipPath(this.cwd)) {
      throw new Error('Codex resume rollout preparation does not match this session')
    }
    this.consumed = true
    this.handlers = options.handlers
    for (const decision of this.pendingDecisions.splice(0)) {
      options.handlers.onDecision(decision)
    }
    for (const lease of this.pendingLeases.splice(0)) {
      options.handlers.onLease(lease)
    }
  }

  unregisterResumeParticipant(): void {
    this.resumeParticipant?.unregister()
    this.resumeParticipant = null
  }

  retirePathLease(filePath: string, clean: boolean): void {
    this.acquisition?.coordinator.retirePathLease(this.ownerId, filePath, clean)
  }

  retireOwnerLeases(clean: boolean): void {
    this.acquisition?.coordinator.retireOwnerLeases(this.ownerId, clean)
  }

  releaseWatcher(): Promise<void> {
    if (!this.watcherReleasePromise) {
      const acquisition = this.acquisition
      this.watcherReleasePromise = acquisition?.release() ?? Promise.resolve()
    }
    return this.watcherReleasePromise
  }

  async dispose(clean = true): Promise<void> {
    if (this.disposed) {
      await this.watcherReleasePromise
      return
    }
    this.disposed = true
    this.unregisterResumeParticipant()
    this.retireOwnerLeases(clean)
    await this.releaseWatcher()
    this.handlers = null
    this.pendingLeases = []
    this.pendingDecisions = []
    this.acquisition = null
  }
}

export async function prepareCodexResumeRollout(options: {
  cwd: string
  resumeThreadId: string
  sessionsDir?: string
  onError?: (error: Error) => void
}): Promise<CodexResumeRolloutPreparation> {
  const sessionsDir = options.sessionsDir ?? getCodexSessionsDir()
  const initialPath = await findCodexRolloutPathByThreadId(
    sessionsDir,
    options.resumeThreadId,
  )
  if (!initialPath) {
    // WHY absence is still represented as a consumed pre-spawn capability:
    // CodexHeadless can deliberately enter its fail-closed new-file fallback,
    // while callers cannot accidentally skip preparation on the ordinary exact
    // route merely because both cases previously used one optional string.
    return new CodexResumeRolloutPreparation({
      sessionsDir,
      initialPath: null,
      resumeThreadId: options.resumeThreadId,
      cwd: options.cwd,
      acquisition: null,
    })
  }

  const acquisition = await acquireFreshRolloutCoordinator({
    sessionsRoot: sessionsDir,
    normalizeCwd: normalizeRolloutOwnershipPath,
    normalizePath: normalizeRolloutOwnershipPath,
    onError: options.onError ?? (() => undefined),
  })
  const preparation = new CodexResumeRolloutPreparation({
    sessionsDir,
    initialPath,
    resumeThreadId: options.resumeThreadId,
    cwd: options.cwd,
    acquisition,
  })
  const reserved = acquisition.coordinator.reservePath({
    ownerId: preparation.ownerId,
    filePath: initialPath,
    kind: 'exact-id',
    proofIdentity: options.resumeThreadId,
  })
  if (!reserved) {
    await preparation.dispose(true)
    throw new Error('Codex exact rollout path is already leased by another live session')
  }

  try {
    const text = await readFile(initialPath, 'utf8')
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
