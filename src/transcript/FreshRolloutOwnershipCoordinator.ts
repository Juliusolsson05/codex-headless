import { createHmac, randomBytes } from 'node:crypto'

import {
  normalizePromptForOwnership,
  type FreshRolloutCandidate,
} from './FreshRolloutClaim.js'
import { fingerprintProviderSession } from './ProviderSessionFingerprint.js'

export type FreshRolloutLease = {
  participantId: string
  filePath: string
  candidateFingerprint: string
  generationId: string | null
}

export type FreshRolloutParticipantHandle = {
  registerPrompt(text: string): void
  unregister(): void
}

export type ResumeRolloutParticipantHandle = {
  unregister(): void
}

export type ResumeRolloutParticipantDecision = {
  reason: 'missing-lineage' | 'insufficient-lineage-overlap'
  lineageOverlap: number
  requiredOverlap: number
  candidateFingerprint: string
}

export type FreshRolloutCandidateObservation = {
  filePath: string
  candidateFingerprint: string
  sequence: number
  revision: number
  generationObservedAtMs: number
  byteLength: number | null
  generationId: string | null
  birthtimeMs: number | null
}

export type FreshRolloutOwnershipInspection = {
  activeParticipantCount: number
  observedCandidateCount: number
  leasedPathCount: number
  historicallyContestedPathCount: number
  quarantinedPathCount: number
}

export type FreshRolloutParticipantDecision = {
  decision: 'hold' | 'ambiguous' | 'accept'
  reason:
    | 'awaiting-local-prompt'
    | 'awaiting-candidate-evidence'
    | 'ownership-contended'
    | 'path-leased'
  localPromptCount: number
  candidateCount: number
  sameCwdCandidateCount: number
  matchingCandidateCount: number
  competingParticipantCount: number
  historicallyContestedCandidateCount: number
  candidateFingerprints: string[]
  matchingCandidateFingerprints: string[]
  candidateProviderSessionFingerprints: Array<{
    candidateFingerprint: string
    providerSessionMetaFingerprint: string
  }>
  leasedCandidateFingerprint: string | null
  tailAuthorized: boolean
}

type PromptEvidence = {
  fingerprint: string
  sequence: number
}

type Participant = {
  id: string
  fingerprint: string
  cwdFingerprint: string
  registeredAtMs: number
  prompts: Map<string, PromptEvidence>
  onLease: ((lease: FreshRolloutLease) => void) | null
  onDecision: ((decision: FreshRolloutParticipantDecision) => void) | null
  active: boolean
  withdrawnAtMs: number | null
  leasedCandidateFingerprint: string | null
}

type ResumeParticipant = {
  id: string
  fingerprint: string
  cwdFingerprint: string
  registeredAtMs: number
  registeredSequence: number
  lineageFingerprints: Set<string>
  requiredOverlapLimit: number
  onLease: ((lease: FreshRolloutLease) => void) | null
  onDecision: ((decision: ResumeRolloutParticipantDecision) => void) | null
  publishedDecisionKeys: Map<string, string>
  active: boolean
  withdrawnAtMs: number | null
  leasedCandidateFingerprint: string | null
}

type CandidateState = {
  fingerprint: string
  filePath: string | null
  cwdFingerprint: string | null
  threadFingerprint: string | null
  providerSessionFingerprint: string | null
  messageFirstObservedAt: Map<string, number>
  lineageFingerprints: Set<string>
  historicalContenders: Set<string>
  quarantined: boolean
  blocked: boolean
  leased: boolean
  generationObservedAtMs: number
  firstObservedSequence: number
  generationId: string | null
  birthtimeMs: number | null
}

type PathLease = {
  ownerId: string | null
  kind: 'fresh' | 'exact-id' | 'resume-lineage'
  proofFingerprint: string | null
  status: 'active' | 'retired-clean' | 'tombstoned-uncertain'
}

// WHY the interval extends on both sides of the local participant lifetime:
// Codex can create its rollout just before headless registration or flush it
// just after PTY teardown. Neither scheduler boundary is provider identity. A
// later identical-prompt sibling inside this window must remain ambiguous.
const PARTICIPANT_FILE_GRACE_MS = 5000

// WHY a TypeScript `private` field is still an ordinary JavaScript own
// property. The coordinator is intentionally returned to package consumers,
// so keeping its HMAC key on `this` let routine reflection recover the secret
// that protects every retained prompt, path, cwd, and lineage fingerprint.
// WeakMap custody preserves one key per coordinator without placing either the
// key or a getter for it anywhere on the reachable instance/prototype graph.
const coordinatorHmacKeys = new WeakMap<
  FreshRolloutOwnershipCoordinator,
  Buffer
>()

export class FreshRolloutOwnershipCoordinator {
  private sequence = 0
  private readonly participants = new Map<string, Participant>()
  private readonly resumeParticipants = new Map<string, ResumeParticipant>()
  private readonly candidates = new Map<string, CandidateState>()
  private readonly pathLeases = new Map<string, PathLease>()
  private readonly candidateRevisions = new Map<string, number>()
  private readonly candidateCommittedRevisions = new Map<string, number>()
  // Path and generation are both process-keyed HMACs. The watcher sees stale
  // initial files before a participant can register; when birth time is not
  // available, this is the only trustworthy evidence that a later `change`
  // event did not create a new rollout generation. One value per path lets a
  // replacement inode supersede the tombstone without retaining either raw
  // filesystem identity.
  private readonly staleGenerationFingerprints = new Map<string, string>()
  private recomputing = false
  private recomputeAgain = false

  constructor(private readonly options: {
    normalizeCwd: (cwd: string) => string
    normalizePath: (filePath: string) => string
  }) {
    coordinatorHmacKeys.set(this, randomBytes(32))
  }

  registerParticipant(options: {
    participantId: string
    cwd: string
    onLease: (lease: FreshRolloutLease) => void
    onDecision?: (decision: FreshRolloutParticipantDecision) => void
  }): FreshRolloutParticipantHandle {
    if (this.participants.has(options.participantId)) {
      throw new Error(
        `Fresh rollout participant ${options.participantId} is already registered`,
      )
    }

    const participant: Participant = {
      id: options.participantId,
      fingerprint: this.fingerprint('participant', options.participantId),
      cwdFingerprint: this.fingerprint('cwd', this.options.normalizeCwd(options.cwd)),
      registeredAtMs: Date.now(),
      prompts: new Map(),
      onLease: options.onLease,
      onDecision: options.onDecision ?? null,
      active: true,
      withdrawnAtMs: null,
      leasedCandidateFingerprint: null,
    }
    this.participants.set(participant.id, participant)

    return {
      registerPrompt: text => {
        if (!participant.active || participant.leasedCandidateFingerprint) return
        const normalized = normalizePromptForOwnership(text)
        if (!normalized) return
        const fingerprint = this.fingerprint('prompt', normalized)
        if (participant.prompts.has(fingerprint)) return

        // WHY only the HMAC survives this call: equality is the ownership fact;
        // retaining raw prompts in a process-global registry is not. The random
        // process key prevents exported/debug memory from becoming a reusable
        // prompt dictionary while preserving exact equality inside this root.
        participant.prompts.set(fingerprint, {
          fingerprint,
          sequence: ++this.sequence,
        })
        this.recompute()
      },
      unregister: () => {
        if (!participant.active) return
        participant.active = false
        participant.withdrawnAtMs = Date.now()
        participant.onLease = null
        participant.onDecision = null

        // WHY prompt HMACs remain through both the admitted-read drain and the
        // bounded provider-flush grace: a rollout generated while this PTY was
        // alive can be created after stop. The tombstone must still contend
        // with an identical live sibling, but callbacks and raw text are
        // cleared immediately.
        this.recompute()
      },
    }
  }

  registerResumeParticipant(options: {
    participantId: string
    cwd: string
    lineageIds: ReadonlySet<string>
    requiredOverlapLimit: number
    onLease: (lease: FreshRolloutLease) => void
    onDecision?: (decision: ResumeRolloutParticipantDecision) => void
  }): ResumeRolloutParticipantHandle {
    if (this.resumeParticipants.has(options.participantId)) {
      throw new Error(
        `Resume rollout participant ${options.participantId} is already registered`,
      )
    }
    const participant: ResumeParticipant = {
      id: options.participantId,
      fingerprint: this.fingerprint('participant', options.participantId),
      cwdFingerprint: this.fingerprint(
        'cwd',
        this.options.normalizeCwd(options.cwd),
      ),
      registeredAtMs: Date.now(),
      // WHY resume preparation completes before its PTY exists. Unlike a fresh
      // participant, it cannot legitimately own a generation whose immutable
      // observation was already admitted by this coordinator. Wall-clock grace
      // is intentionally insufficient here: a just-finished sibling can share
      // cwd and copied lineage while being born one millisecond earlier.
      registeredSequence: ++this.sequence,
      // WHY raw Codex item IDs never enter the process-global graph: overlap
      // equality is sufficient to prove copied history. Domain-separated HMACs
      // preserve that equality without retaining provider identifiers.
      lineageFingerprints: new Set(
        [...options.lineageIds]
          .filter(Boolean)
          .map(id => this.fingerprint('lineage', id)),
      ),
      requiredOverlapLimit: options.requiredOverlapLimit,
      onLease: options.onLease,
      onDecision: options.onDecision ?? null,
      publishedDecisionKeys: new Map(),
      active: true,
      withdrawnAtMs: null,
      leasedCandidateFingerprint: null,
    }
    this.resumeParticipants.set(participant.id, participant)
    this.recompute()

    return {
      unregister: () => {
        if (!participant.active) return
        participant.active = false
        participant.withdrawnAtMs = Date.now()
        participant.onLease = null
        participant.onDecision = null
        this.recompute()
      },
    }
  }

  beginCandidateObservation(
    filePath: string,
    snapshot: {
      byteLength?: number
      generationId?: string
      birthtimeMs?: number
    } = {},
  ): FreshRolloutCandidateObservation {
    const normalizedPath = this.options.normalizePath(filePath)
    const candidateFingerprint = this.fingerprint('path', normalizedPath)
    const generationId = snapshot.generationId ?? null
    const generationFingerprint = generationId === null
      ? null
      : this.fingerprint(
          'generation',
          `${normalizedPath}\0${generationId}`,
        )
    const rememberedStaleGeneration =
      this.staleGenerationFingerprints.get(candidateFingerprint)
    const generationWasAlreadyStale = generationFingerprint !== null &&
      rememberedStaleGeneration === generationFingerprint
    if (rememberedStaleGeneration && generationFingerprint !== null &&
      rememberedStaleGeneration !== generationFingerprint) {
      // A different inode/generation at the same pathname is new evidence, not
      // a mutation of the ignored old file. Remove the old HMAC so replacement
      // files remain eligible under the ordinary birth/observation checks.
      this.staleGenerationFingerprints.delete(candidateFingerprint)
    }
    const revision = (this.candidateRevisions.get(candidateFingerprint) ?? 0) + 1
    this.candidateRevisions.set(candidateFingerprint, revision)
    const sequence = ++this.sequence
    return {
      filePath: normalizedPath,
      candidateFingerprint,
      sequence,
      revision,
      // Zero is an intentional fail-closed lower bound. Observation time says
      // when the old inode changed, not when it was created; substituting now
      // is what allowed copied history from old exact X to look fresh on
      // filesystems whose stat has no birth time.
      generationObservedAtMs: generationWasAlreadyStale ? 0 : Date.now(),
      byteLength: snapshot.byteLength ?? null,
      generationId,
      birthtimeMs: snapshot.birthtimeMs ?? null,
    }
  }

  rememberStaleCandidateGeneration(
    filePath: string,
    generationId: string,
  ): void {
    const normalizedPath = this.options.normalizePath(filePath)
    const pathFingerprint = this.fingerprint('path', normalizedPath)
    this.staleGenerationFingerprints.set(
      pathFingerprint,
      this.fingerprint('generation', `${normalizedPath}\0${generationId}`),
    )
  }

  clearStaleCandidateGenerations(): void {
    // Safe only after watcher admission and queued reads have stopped. A later
    // acquisition completes a fresh initial scan before returning to its
    // caller, so every still-existing old generation is re-established before
    // a new participant can register.
    this.staleGenerationFingerprints.clear()
  }

  observeCandidate(candidate: FreshRolloutCandidate): void {
    this.commitCandidateObservation(
      this.beginCandidateObservation(candidate.filePath),
      candidate,
    )
  }

  commitCandidateObservation(
    observation: FreshRolloutCandidateObservation,
    candidate: FreshRolloutCandidate,
    options: { readCapExceeded?: boolean } = {},
  ): void {
    const normalizedPath = this.options.normalizePath(candidate.filePath)
    const candidateFingerprint = this.fingerprint('path', normalizedPath)
    const committedRevision = this.candidateCommittedRevisions.get(
      candidateFingerprint,
    ) ?? 0
    if (candidateFingerprint !== observation.candidateFingerprint ||
      observation.revision <= committedRevision) {
      // WHY reservation order and completion order are different facts. The
      // registry deliberately serializes reads, so O1 must commit even when O2
      // was reserved while O1 was queued; discarding O1 would make bytes already
      // durable in its prefix look causally newer. If a non-registry caller
      // actually completes O2 first, the committed-revision fence still rejects
      // the later-arriving O1 and prevents evidence rollback.
      return
    }
    this.candidateCommittedRevisions.set(
      candidateFingerprint,
      observation.revision,
    )

    const cwdFingerprint = candidate.cwd
      ? this.fingerprint('cwd', this.options.normalizeCwd(candidate.cwd))
      : null
    const threadFingerprint = candidate.threadId
      ? this.fingerprint('thread', candidate.threadId)
      : null
    const providerSessionFingerprint = fingerprintProviderSession(candidate.threadId)
    const messages = new Set(
      candidate.userMessages
        .map(message => message.normalized)
        .filter(Boolean)
        .map(normalized => this.fingerprint('prompt', normalized)),
    )
    const lineageFingerprints = new Set(
      candidate.lineageIds
        .filter(Boolean)
        .map(id => this.fingerprint('lineage', id)),
    )
    const previous = this.candidates.get(candidateFingerprint)

    if (!previous) {
      this.candidates.set(candidateFingerprint, {
        fingerprint: candidateFingerprint,
        filePath: normalizedPath,
        cwdFingerprint,
        threadFingerprint,
        providerSessionFingerprint,
        messageFirstObservedAt: new Map(
          [...messages].map(message => [message, observation.sequence]),
        ),
        lineageFingerprints,
        historicalContenders: new Set(),
        quarantined: options.readCapExceeded === true,
        blocked: false,
        leased: false,
        generationObservedAtMs: observation.generationObservedAtMs,
        firstObservedSequence: observation.sequence,
        generationId: observation.generationId,
        birthtimeMs: observation.birthtimeMs,
      })
      this.recompute()
      return
    }

    if (previous.quarantined || previous.blocked || previous.leased) return
    previous.filePath = normalizedPath
    if (options.readCapExceeded) {
      previous.quarantined = true
      this.recompute()
      return
    }

    const lostEvidence = [...previous.messageFirstObservedAt.keys()]
      .some(message => !messages.has(message))
    const lostLineageEvidence = [...previous.lineageFingerprints]
      .some(lineage => !lineageFingerprints.has(lineage))
    const cwdChanged = previous.cwdFingerprint !== null &&
      cwdFingerprint !== null && previous.cwdFingerprint !== cwdFingerprint
    const threadChanged = previous.threadFingerprint !== null &&
      threadFingerprint !== null && previous.threadFingerprint !== threadFingerprint
    const generationChanged = previous.generationId !== null &&
      observation.generationId !== null &&
      previous.generationId !== observation.generationId
    if (lostEvidence || lostLineageEvidence || cwdChanged || threadChanged ||
      generationChanged) {
      // WHY rollout prefixes are append-only evidence. Losing a copied ID while
      // keeping the same inode/path means truncation or replacement; retaining
      // the old HMAC would allow a later resume owner to lease from history no
      // longer present in the physical file.
      previous.quarantined = true
      this.recompute()
      return
    }

    previous.cwdFingerprint ??= cwdFingerprint
    previous.threadFingerprint ??= threadFingerprint
    previous.providerSessionFingerprint ??= providerSessionFingerprint
    previous.generationId ??= observation.generationId
    previous.birthtimeMs ??= observation.birthtimeMs
    for (const message of messages) {
      if (!previous.messageFirstObservedAt.has(message)) {
        previous.messageFirstObservedAt.set(message, observation.sequence)
      }
    }
    for (const lineageFingerprint of lineageFingerprints) {
      previous.lineageFingerprints.add(lineageFingerprint)
    }
    this.recompute()
  }

  reservePath(options: {
    ownerId: string
    filePath: string
    kind: 'exact-id' | 'resume-lineage'
    proofIdentity?: string
  }): boolean {
    const pathFingerprint = this.fingerprint(
      'path',
      this.options.normalizePath(options.filePath),
    )
    const proofFingerprint = options.proofIdentity
      ? this.fingerprint('proof', options.proofIdentity)
      : null
    const existing = this.pathLeases.get(pathFingerprint)
    if (existing?.status === 'active') {
      return existing.ownerId === options.ownerId &&
        existing.kind === options.kind &&
        existing.proofFingerprint === proofFingerprint
    }
    if (existing?.status === 'tombstoned-uncertain') return false

    // WHY only exact identity can reopen a cleanly retired path: fresh prompt
    // evidence must never recycle an old transcript, but requested ID ==
    // filename UUID == session_meta.id is strong enough for ordinary close and
    // later resume. This preserves at-most-one ACTIVE tail without breaking
    // process-lifetime reopen.
    if (existing?.status === 'retired-clean' && options.kind !== 'exact-id') {
      return false
    }
    this.pathLeases.set(pathFingerprint, {
      ownerId: options.ownerId,
      kind: options.kind,
      proofFingerprint,
      status: 'active',
    })
    const candidate = this.candidates.get(pathFingerprint)
    if (candidate) candidate.leased = true
    this.recompute()
    return true
  }

  retireOwnerLeases(ownerId: string, clean: boolean): void {
    for (const lease of this.pathLeases.values()) {
      if (lease.ownerId !== ownerId || lease.status !== 'active') continue
      lease.status = clean ? 'retired-clean' : 'tombstoned-uncertain'
      // WHY a retired lease needs the outcome but not the session identity.
      // Clearing the owner breaks the stopped-session object graph while the
      // path/proof HMACs continue to enforce fail-closed reuse policy.
      lease.ownerId = null
    }
  }

  retirePathLease(ownerId: string, filePath: string, clean: boolean): void {
    const pathFingerprint = this.fingerprint(
      'path',
      this.options.normalizePath(filePath),
    )
    const lease = this.pathLeases.get(pathFingerprint)
    if (lease?.ownerId !== ownerId || lease.status !== 'active') return
    lease.status = clean ? 'retired-clean' : 'tombstoned-uncertain'
    lease.ownerId = null
  }

  compactInactiveState(
    nowMs = Date.now(),
    retainUnresolvedTransport = true,
  ): void {
    // WHY compaction happens only after the root watcher and admitted reads have
    // drained: until then, an inactive prompt HMAC can still prove that a late
    // event belongs to the stopped PTY and must block a sibling. Draining is not
    // enough to delete that proof, however: Codex can flush a brand-new file
    // only after its PTY has closed. Keep the content-safe tombstone through the
    // provider's bounded file-arrival grace, then remove it on the timer-driven
    // pass. That makes teardown order irrelevant without retaining raw prompts.
    this.expireInactiveParticipants(nowMs)
    for (const candidate of this.candidates.values()) {
      const terminal = this.candidateIsTerminal(candidate)
      const keepForRescan = retainUnresolvedTransport &&
        !terminal && this.activeParticipantCanStillUse(candidate)
      // WHY unresolved and terminal candidates have opposite transport needs.
      // A live participant may acquire new prompt/lineage evidence from a later
      // append even when chokidar omitted that append, so its pathname is the
      // poller's bounded recovery capability. A blocked/quarantined/leased
      // candidate can never become a different ownership decision; retaining
      // its UUID-bearing path buys no correctness and violates the privacy
      // boundary. Final watcher shutdown passes false because no rescan remains.
      if (!keepForRescan) candidate.filePath = null
      if (terminal) {
        candidate.cwdFingerprint = null
        candidate.threadFingerprint = null
        candidate.providerSessionFingerprint = null
        candidate.messageFirstObservedAt.clear()
        candidate.lineageFingerprints.clear()
      }
    }
  }

  /**
   * Whether the watcher must keep this pathname in its bounded rescan set.
   *
   * WHY the registry asks policy instead of duplicating it: only this graph can
   * distinguish a candidate that may gain evidence for a live participant from
   * one whose blocked/quarantined/leased state is terminal. Returning one bit
   * exposes no path, provider id, prompt, or equality fingerprint.
   */
  requiresCandidateRescan(filePath: string): boolean {
    const fingerprint = this.fingerprint(
      'path',
      this.options.normalizePath(filePath),
    )
    if (this.pathLeases.has(fingerprint)) return false
    const candidate = this.candidates.get(fingerprint)
    if (!candidate) {
      // WHY pending immutable reads are registry transport state, not ownership
      // state, and maintenance explicitly protects them before asking here.
      // Once no read is pending, an invalid/incomplete path is useful only when
      // a live unleased claimant could consume evidence from a later append.
      // Returning true without that claimant would retain arbitrary raw paths
      // forever merely because an unrelated acquisition keeps the watcher live.
      return [...this.participants.values()].some(participant =>
        participant.active && !participant.leasedCandidateFingerprint,
      ) || [...this.resumeParticipants.values()].some(participant =>
        participant.active && !participant.leasedCandidateFingerprint &&
          participant.requiredOverlapLimit > 0 &&
          participant.lineageFingerprints.size > 0,
      )
    }
    return !this.candidateIsTerminal(candidate) &&
      this.activeParticipantCanStillUse(candidate)
  }

  /**
   * Erase the raw path corresponding to a transport entry policy rejected.
   *
   * WHY the registry cannot safely approximate this by running whole-graph
   * compaction: maintenance examines one unchanged fingerprint at a time, and
   * unrelated candidates may still need rescan. The path HMAC lookup keeps the
   * raw pathname at the watcher boundary while this method removes precisely
   * its duplicate from coordinator state.
   */
  compactCandidateTransportPath(filePath: string): void {
    // WHY this method is callable across the registry/coordinator module
    // boundary, so it must carry its own policy guard. Relying on the caller's
    // preceding check would make a direct or stale call capable of erasing the
    // only path for a genuinely unresolved live rescan.
    if (this.requiresCandidateRescan(filePath)) return
    const fingerprint = this.fingerprint(
      'path',
      this.options.normalizePath(filePath),
    )
    const candidate = this.candidates.get(fingerprint)
    if (!candidate) return
    candidate.filePath = null
    if (this.candidateIsTerminal(candidate)) {
      candidate.cwdFingerprint = null
      candidate.threadFingerprint = null
      candidate.providerSessionFingerprint = null
      candidate.messageFirstObservedAt.clear()
      candidate.lineageFingerprints.clear()
    }
  }

  /**
   * Tell transport whether a delayed event refers to an irreversible candidate.
   *
   * WHY this is separate from `requiresCandidateRescan`: a newly observed path
   * can arrive just before its participant registers, so absence of an active
   * claimant is not enough to discard the first read. Terminal ownership state
   * is different—it cannot be reversed by callback order and may be evicted
   * immediately after any delayed callback finishes.
   */
  isCandidateTransportTerminal(filePath: string): boolean {
    const fingerprint = this.fingerprint(
      'path',
      this.options.normalizePath(filePath),
    )
    if (this.pathLeases.has(fingerprint)) return true
    const candidate = this.candidates.get(fingerprint)
    return candidate ? this.candidateIsTerminal(candidate) : false
  }

  expireInactiveParticipants(nowMs = Date.now()): void {
    for (const [participantId, participant] of this.participants) {
      if (participant.active || participant.withdrawnAtMs === null) continue
      if (participant.withdrawnAtMs + PARTICIPANT_FILE_GRACE_MS > nowMs) {
        continue
      }
      this.participants.delete(participantId)
    }
    for (const [participantId, participant] of this.resumeParticipants) {
      if (participant.active || participant.withdrawnAtMs === null) continue
      if (participant.withdrawnAtMs + PARTICIPANT_FILE_GRACE_MS > nowMs) {
        continue
      }
      this.resumeParticipants.delete(participantId)
    }
  }

  millisecondsUntilInactiveExpiry(nowMs = Date.now()): number | null {
    let minimum: number | null = null
    for (const participant of this.participants.values()) {
      if (participant.active || participant.withdrawnAtMs === null) continue
      const remaining = Math.max(
        0,
        participant.withdrawnAtMs + PARTICIPANT_FILE_GRACE_MS - nowMs,
      )
      minimum = minimum === null ? remaining : Math.min(minimum, remaining)
    }
    for (const participant of this.resumeParticipants.values()) {
      if (participant.active || participant.withdrawnAtMs === null) continue
      const remaining = Math.max(
        0,
        participant.withdrawnAtMs + PARTICIPANT_FILE_GRACE_MS - nowMs,
      )
      minimum = minimum === null ? remaining : Math.min(minimum, remaining)
    }
    return minimum
  }

  inspect(): FreshRolloutOwnershipInspection {
    return {
      activeParticipantCount: [...this.participants.values()]
        .filter(participant => participant.active).length +
        [...this.resumeParticipants.values()]
          .filter(participant => participant.active).length,
      observedCandidateCount: this.candidates.size,
      leasedPathCount: this.pathLeases.size,
      historicallyContestedPathCount: [...this.candidates.values()]
        .filter(candidate => candidate.blocked ||
          candidate.historicalContenders.size > 1).length,
      quarantinedPathCount: [...this.candidates.values()]
        .filter(candidate => candidate.quarantined).length,
    }
  }

  inspectRetentionForTesting(): unknown {
    return {
      participants: [...this.participants.values()].map(participant => ({
        // WHY caller-owned ids are raw cross-session identity, just like paths
        // and provider thread ids. The process-keyed HMAC is sufficient to prove
        // retention/compaction equality without shipping a diagnostic identity
        // store through this deep-importable testing projection.
        fingerprint: participant.fingerprint,
        cwdFingerprint: participant.cwdFingerprint,
        promptFingerprints: [...participant.prompts.keys()],
        hasLeaseCallback: participant.onLease !== null,
        hasDecisionCallback: participant.onDecision !== null,
        active: participant.active,
      })),
      resumeParticipants: [...this.resumeParticipants.values()]
        .map(participant => ({
          fingerprint: participant.fingerprint,
          cwdFingerprint: participant.cwdFingerprint,
          lineageFingerprints: [...participant.lineageFingerprints],
          hasLeaseCallback: participant.onLease !== null,
          hasDecisionCallback: participant.onDecision !== null,
          active: participant.active,
        })),
      candidates: [...this.candidates.values()].map(candidate => ({
        fingerprint: candidate.fingerprint,
        hasRawPath: candidate.filePath !== null,
        cwdFingerprint: candidate.cwdFingerprint,
        threadFingerprint: candidate.threadFingerprint,
        providerSessionFingerprint: candidate.providerSessionFingerprint,
        messageFingerprints: [...candidate.messageFirstObservedAt.keys()],
        lineageFingerprints: [...candidate.lineageFingerprints],
        blocked: candidate.blocked,
        quarantined: candidate.quarantined,
      })),
      leases: [...this.pathLeases.entries()].map(([fingerprint, lease]) => ({
        fingerprint,
        kind: lease.kind,
        proofFingerprint: lease.proofFingerprint,
        status: lease.status,
      })),
    }
  }

  private recompute(): void {
    if (this.recomputing) {
      this.recomputeAgain = true
      return
    }
    this.recomputing = true
    try {
      do {
        this.recomputeAgain = false
        this.recomputeOnce()
      } while (this.recomputeAgain)
    } finally {
      this.recomputing = false
    }
  }

  private recomputeOnce(): void {
    const activeResumeEdges = new Map<string, Set<string>>()
    const resumeCandidateEdges = new Map<string, Set<string>>()
    const resumeDecisionCallbacks: Array<{
      participant: ResumeParticipant
      decision: ResumeRolloutParticipantDecision
    }> = []

    // WHY lineage runs before prompt equality: a reconstructed fork carries
    // copied user messages and copied opaque item IDs in the same durable
    // prefix. Prompt equality alone would misclassify that history as a fresh
    // sibling. Copied provider IDs are stronger ownership evidence, so one
    // graph must reserve their candidate before fresh edges are considered.
    for (const participant of this.resumeParticipants.values()) {
      if (participant.leasedCandidateFingerprint) continue
      const requiredOverlap = Math.min(
        participant.requiredOverlapLimit,
        participant.lineageFingerprints.size,
      )
      for (const [candidateFingerprint, candidate] of this.candidates) {
        if (candidate.quarantined || candidate.blocked || candidate.leased ||
          this.pathLeases.has(candidateFingerprint) ||
          candidate.cwdFingerprint !== participant.cwdFingerprint) {
          continue
        }
        if (!this.participantGenerationWindowContains(participant, candidate)) {
          continue
        }
        let overlap = 0
        for (const lineage of candidate.lineageFingerprints) {
          if (participant.lineageFingerprints.has(lineage)) overlap += 1
          if (overlap >= requiredOverlap) break
        }
        if (requiredOverlap <= 0 || overlap < requiredOverlap) {
          if (participant.active && participant.onDecision) {
            const decision: ResumeRolloutParticipantDecision = {
              reason: requiredOverlap <= 0
                ? 'missing-lineage'
                : 'insufficient-lineage-overlap',
              lineageOverlap: overlap,
              requiredOverlap,
              candidateFingerprint,
            }
            const decisionKey = `${decision.reason}:${overlap}:${requiredOverlap}`
            if (participant.publishedDecisionKeys.get(candidateFingerprint) !==
              decisionKey) {
              participant.publishedDecisionKeys.set(
                candidateFingerprint,
                decisionKey,
              )
              resumeDecisionCallbacks.push({ participant, decision })
            }
          }
          continue
        }

        let claimantIds = resumeCandidateEdges.get(candidateFingerprint)
        if (!claimantIds) {
          claimantIds = new Set()
          resumeCandidateEdges.set(candidateFingerprint, claimantIds)
        }
        claimantIds.add(participant.id)
        if (participant.active) {
          let candidateIds = activeResumeEdges.get(participant.id)
          if (!candidateIds) {
            candidateIds = new Set()
            activeResumeEdges.set(participant.id, candidateIds)
          }
          candidateIds.add(candidateFingerprint)
        }
      }
    }

    for (const [candidateFingerprint, claimantIds] of resumeCandidateEdges) {
      const candidate = this.candidates.get(candidateFingerprint)
      if (!candidate) continue
      for (const claimantId of claimantIds) {
        const claimant = this.resumeParticipants.get(claimantId)
        if (claimant) candidate.historicalContenders.add(claimant.fingerprint)
      }
      const includesInactiveOwner = [...claimantIds].some(
        claimantId => !this.resumeParticipants.get(claimantId)?.active,
      )
      if (claimantIds.size > 1 || includesInactiveOwner) candidate.blocked = true
    }

    const resumeCallbacks: Array<{
      participant: ResumeParticipant
      lease: FreshRolloutLease
    }> = []
    for (const [participantId, candidateFingerprints] of activeResumeEdges) {
      if (candidateFingerprints.size !== 1) continue
      const [candidateFingerprint] = candidateFingerprints
      const claimantIds = resumeCandidateEdges.get(candidateFingerprint)
      if (!claimantIds || claimantIds.size !== 1) continue
      const participant = this.resumeParticipants.get(participantId)
      const candidate = this.candidates.get(candidateFingerprint)
      if (!participant?.active || participant.leasedCandidateFingerprint ||
        !candidate || candidate.blocked || candidate.quarantined ||
        candidate.leased || !candidate.filePath ||
        this.pathLeases.has(candidateFingerprint)) {
        continue
      }

      participant.leasedCandidateFingerprint = candidateFingerprint
      candidate.leased = true
      this.pathLeases.set(candidateFingerprint, {
        ownerId: participantId,
        kind: 'resume-lineage',
        proofFingerprint: participant.fingerprint,
        status: 'active',
      })
      resumeCallbacks.push({
        participant,
        lease: {
          participantId,
          filePath: candidate.filePath,
          candidateFingerprint,
          generationId: candidate.generationId,
        },
      })
    }

    const activeParticipantEdges = new Map<string, Set<string>>()
    const candidateEdges = new Map<string, Set<string>>()

    for (const participant of this.participants.values()) {
      if (participant.leasedCandidateFingerprint) continue
      for (const [candidateFingerprint, candidate] of this.candidates) {
        if (candidate.quarantined || candidate.blocked || candidate.leased ||
          this.pathLeases.has(candidateFingerprint) ||
          resumeCandidateEdges.has(candidateFingerprint) ||
          candidate.cwdFingerprint !== participant.cwdFingerprint) {
          continue
        }
        // WHY a live participant removes only the generation-window upper
        // bound. The lower bound applies to everyone: a change event can make
        // an old exact file newly observable, but cannot make that file a
        // generation this newly registered PTY could have authored.
        if (!this.participantGenerationWindowContains(participant, candidate)) {
          continue
        }
        const matched = [...participant.prompts.values()].some(prompt => {
          const messageSequence = candidate.messageFirstObservedAt.get(
            prompt.fingerprint,
          )
          return messageSequence !== undefined && prompt.sequence < messageSequence
        })
        if (!matched) continue

        let claimantIds = candidateEdges.get(candidateFingerprint)
        if (!claimantIds) {
          claimantIds = new Set()
          candidateEdges.set(candidateFingerprint, claimantIds)
        }
        claimantIds.add(participant.id)
        if (participant.active) {
          let candidateIds = activeParticipantEdges.get(participant.id)
          if (!candidateIds) {
            candidateIds = new Set()
            activeParticipantEdges.set(participant.id, candidateIds)
          }
          candidateIds.add(candidateFingerprint)
        }
      }
    }

    for (const [candidateFingerprint, claimantIds] of candidateEdges) {
      const candidate = this.candidates.get(candidateFingerprint)
      if (!candidate) continue
      for (const claimantId of claimantIds) {
        const claimant = this.participants.get(claimantId)
        if (claimant) candidate.historicalContenders.add(claimant.fingerprint)
      }
      const includesInactiveOwner = [...claimantIds].some(
        claimantId => !this.participants.get(claimantId)?.active,
      )
      if (claimantIds.size > 1 || includesInactiveOwner) {
        // WHY this becomes terminal immediately: removing contenders or waiting
        // longer cannot create identity. Blocking also lets compaction erase the
        // raw path and message set while retaining the HMAC tombstone.
        candidate.blocked = true
      }
    }

    const callbacks: Array<{
      participant: Participant
      lease: FreshRolloutLease
    }> = []
    for (const [participantId, candidateFingerprints] of activeParticipantEdges) {
      if (candidateFingerprints.size !== 1) continue
      const [candidateFingerprint] = candidateFingerprints
      const claimantIds = candidateEdges.get(candidateFingerprint)
      if (!claimantIds || claimantIds.size !== 1) continue
      const participant = this.participants.get(participantId)
      const candidate = this.candidates.get(candidateFingerprint)
      if (!participant?.active || participant.leasedCandidateFingerprint ||
        !candidate || candidate.blocked || candidate.quarantined ||
        candidate.leased || !candidate.filePath ||
        this.pathLeases.has(candidateFingerprint)) {
        continue
      }

      participant.leasedCandidateFingerprint = candidateFingerprint
      candidate.leased = true
      this.pathLeases.set(candidateFingerprint, {
        ownerId: participantId,
        kind: 'fresh',
        proofFingerprint: null,
        status: 'active',
      })
      callbacks.push({
        participant,
        lease: {
          participantId,
          filePath: candidate.filePath,
          candidateFingerprint,
          generationId: candidate.generationId,
        },
      })
    }

    this.publishDecisions(activeParticipantEdges, candidateEdges)

    for (const { participant, decision } of resumeDecisionCallbacks) {
      try {
        participant.onDecision?.(decision)
      } catch {
        // Resume diagnostics are observational and cannot mutate ownership.
      }
    }

    for (const { participant, lease } of resumeCallbacks) {
      try {
        participant.onLease?.(lease)
      } catch {
        participant.active = false
        participant.withdrawnAtMs = Date.now()
        participant.onLease = null
        participant.onDecision = null
        this.retireOwnerLeases(participant.id, false)
      }
    }

    for (const { participant, lease } of callbacks) {
      try {
        participant.onLease?.(lease)
      } catch {
        participant.active = false
        participant.withdrawnAtMs = Date.now()
        participant.onLease = null
        participant.onDecision = null
        this.retireOwnerLeases(participant.id, false)
      }
    }

    for (const candidate of this.candidates.values()) {
      if (!candidate.blocked && !candidate.quarantined && !candidate.leased) {
        continue
      }
      candidate.filePath = null
      candidate.cwdFingerprint = null
      candidate.threadFingerprint = null
      candidate.providerSessionFingerprint = null
      candidate.messageFirstObservedAt.clear()
      candidate.lineageFingerprints.clear()
    }
  }

  private publishDecisions(
    participantEdges: Map<string, Set<string>>,
    candidateEdges: Map<string, Set<string>>,
  ): void {
    const allCandidateFingerprints = [...this.candidates.keys()].sort()
    // This is diagnostic projection only: policy above continues to compare
    // the coordinator's process-keyed HMACs. The stable provider-session
    // digest exists solely so a pre-lease session_meta can be joined with the
    // proxy window observation in incidents where no tail was ever attached.
    const candidateProviderSessionFingerprints = allCandidateFingerprints
      .flatMap(candidateFingerprint => {
        const providerSessionMetaFingerprint = this.candidates.get(
          candidateFingerprint,
        )?.providerSessionFingerprint
        return providerSessionMetaFingerprint
          ? [{ candidateFingerprint, providerSessionMetaFingerprint }]
          : []
      })
    for (const participant of this.participants.values()) {
      if (!participant.active || !participant.onDecision) continue
      const activeCandidateFingerprints = participantEdges.get(participant.id) ??
        new Set<string>()
      const candidateFingerprints = new Set(activeCandidateFingerprints)

      // WHY terminally blocked candidates are absent from the current graph:
      // their raw equality evidence has already been scrubbed. The opaque
      // historical edge is deliberately retained so the last observable state
      // remains "this participant contended for candidate HMAC X" instead of
      // degrading to an unexplained hold on the next recomputation.
      for (const candidate of this.candidates.values()) {
        if (candidate.historicalContenders.has(participant.fingerprint)) {
          candidateFingerprints.add(candidate.fingerprint)
        }
      }
      const competitors = new Set<string>()
      let historicallyContestedCandidateCount = 0
      for (const candidateFingerprint of candidateFingerprints) {
        for (const contender of candidateEdges.get(candidateFingerprint) ?? []) {
          if (contender !== participant.id) competitors.add(contender)
        }
        const candidate = this.candidates.get(candidateFingerprint)
        if (candidate?.blocked ||
          (candidate?.historicalContenders.size ?? 0) > 1) {
          historicallyContestedCandidateCount += 1
        }
      }
      const sameCwdCandidateCount = [...this.candidates.values()]
        .filter(candidate =>
          candidate.cwdFingerprint === participant.cwdFingerprint).length
      const contended = competitors.size > 0 ||
        historicallyContestedCandidateCount > 0 ||
        candidateFingerprints.size > 1
      const decision: FreshRolloutParticipantDecision =
        participant.leasedCandidateFingerprint
          ? {
              decision: 'accept',
              reason: 'path-leased',
              localPromptCount: participant.prompts.size,
              candidateCount: this.candidates.size,
              sameCwdCandidateCount,
              matchingCandidateCount: candidateFingerprints.size,
              competingParticipantCount: competitors.size,
              historicallyContestedCandidateCount,
              candidateFingerprints: allCandidateFingerprints,
              matchingCandidateFingerprints: [...candidateFingerprints].sort(),
              candidateProviderSessionFingerprints,
              leasedCandidateFingerprint: participant.leasedCandidateFingerprint,
              tailAuthorized: true,
            }
          : {
              decision: contended ? 'ambiguous' : 'hold',
              reason: participant.prompts.size === 0
                ? 'awaiting-local-prompt'
                : contended
                  ? 'ownership-contended'
                  : 'awaiting-candidate-evidence',
              localPromptCount: participant.prompts.size,
              candidateCount: this.candidates.size,
              sameCwdCandidateCount,
              matchingCandidateCount: candidateFingerprints.size,
              competingParticipantCount: competitors.size,
              historicallyContestedCandidateCount,
              candidateFingerprints: allCandidateFingerprints,
              matchingCandidateFingerprints: [...candidateFingerprints].sort(),
              candidateProviderSessionFingerprints,
              leasedCandidateFingerprint: null,
              tailAuthorized: false,
            }
      try {
        participant.onDecision(decision)
      } catch {
        // Diagnostics are observational and cannot mutate ownership.
      }
    }
  }

  private participantGenerationWindowContains(
    participant: Participant | ResumeParticipant,
    candidate: CandidateState,
  ): boolean {
    if ('registeredSequence' in participant &&
      candidate.firstObservedSequence <= participant.registeredSequence) {
      // WHY the watcher may finish parsing after registration even though it
      // reserved this observation before registration. Sequence is assigned at
      // immutable snapshot admission, so it preserves the actual causal order
      // that async read completion and unreliable filesystem birth time cannot.
      return false
    }
    const generationAtMs = candidate.birthtimeMs ??
      candidate.generationObservedAtMs
    if (generationAtMs <
      participant.registeredAtMs - PARTICIPANT_FILE_GRACE_MS) {
      return false
    }
    if (participant.active) return true
    return participant.withdrawnAtMs !== null && generationAtMs <=
      participant.withdrawnAtMs + PARTICIPANT_FILE_GRACE_MS
  }

  private candidateIsTerminal(candidate: CandidateState): boolean {
    return candidate.blocked || candidate.quarantined || candidate.leased ||
      this.pathLeases.has(candidate.fingerprint)
  }

  private activeParticipantCanStillUse(candidate: CandidateState): boolean {
    const cwdMayMatch = (participantCwdFingerprint: string): boolean =>
      candidate.cwdFingerprint === null ||
      candidate.cwdFingerprint === participantCwdFingerprint
    const freshCanUse = [...this.participants.values()].some(participant =>
      participant.active && !participant.leasedCandidateFingerprint &&
        cwdMayMatch(participant.cwdFingerprint) &&
        this.participantGenerationWindowContains(participant, candidate),
    )
    if (freshCanUse) return true
    return [...this.resumeParticipants.values()].some(participant =>
      participant.active && !participant.leasedCandidateFingerprint &&
        participant.requiredOverlapLimit > 0 &&
        participant.lineageFingerprints.size > 0 &&
        cwdMayMatch(participant.cwdFingerprint) &&
        this.participantGenerationWindowContains(participant, candidate),
    )
  }

  private fingerprint(domain: string, value: string): string {
    const hmacKey = coordinatorHmacKeys.get(this)
    // WHY absence means an object bypassed the real constructor. Silently
    // minting a replacement key here would split equality identity midway
    // through ownership arbitration, so malformed/forged receivers fail
    // closed instead of producing incomparable fingerprints.
    if (!hmacKey) {
      throw new Error('Fresh rollout coordinator HMAC custody is unavailable')
    }
    return createHmac('sha256', hmacKey)
      .update(domain)
      .update('\0')
      .update(value)
      .digest('hex')
  }
}
