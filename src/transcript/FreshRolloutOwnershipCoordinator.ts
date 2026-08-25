import { createHmac, randomBytes } from 'node:crypto'

import {
  normalizePromptForOwnership,
  type FreshRolloutCandidate,
} from './FreshRolloutClaim.js'

export type FreshRolloutLease = {
  participantId: string
  filePath: string
  candidateFingerprint: string
}

export type FreshRolloutParticipantHandle = {
  registerPrompt(text: string): void
  unregister(): void
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

type CandidateState = {
  fingerprint: string
  filePath: string | null
  cwdFingerprint: string | null
  threadFingerprint: string | null
  messageFirstObservedAt: Map<string, number>
  historicalContenders: Set<string>
  quarantined: boolean
  blocked: boolean
  leased: boolean
  generationObservedAtMs: number
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

export class FreshRolloutOwnershipCoordinator {
  private sequence = 0
  private readonly hmacKey = randomBytes(32)
  private readonly participants = new Map<string, Participant>()
  private readonly candidates = new Map<string, CandidateState>()
  private readonly pathLeases = new Map<string, PathLease>()
  private readonly candidateRevisions = new Map<string, number>()
  private recomputing = false
  private recomputeAgain = false

  constructor(private readonly options: {
    normalizeCwd: (cwd: string) => string
    normalizePath: (filePath: string) => string
  }) {}

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

        // WHY prompt HMACs remain only until the root's admitted reads drain: a
        // rollout event generated while this PTY was alive can arrive after
        // stop. The tombstone must still contend with an identical live sibling,
        // but callbacks and raw text are cleared immediately.
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
    const revision = (this.candidateRevisions.get(candidateFingerprint) ?? 0) + 1
    this.candidateRevisions.set(candidateFingerprint, revision)
    const sequence = ++this.sequence
    return {
      filePath: normalizedPath,
      candidateFingerprint,
      sequence,
      revision,
      generationObservedAtMs: Date.now(),
      byteLength: snapshot.byteLength ?? null,
      generationId: snapshot.generationId ?? null,
      birthtimeMs: snapshot.birthtimeMs ?? null,
    }
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
    if (candidateFingerprint !== observation.candidateFingerprint ||
      this.candidateRevisions.get(candidateFingerprint) !== observation.revision) {
      // WHY reads complete out of order under rapid append events. Applying an
      // older prefix after a newer one can manufacture truncation or erase a
      // contender, so only the newest reserved revision commits.
      return
    }

    const cwdFingerprint = candidate.cwd
      ? this.fingerprint('cwd', this.options.normalizeCwd(candidate.cwd))
      : null
    const threadFingerprint = candidate.threadId
      ? this.fingerprint('thread', candidate.threadId)
      : null
    const messages = new Set(
      candidate.userMessages
        .map(message => message.normalized)
        .filter(Boolean)
        .map(normalized => this.fingerprint('prompt', normalized)),
    )
    const previous = this.candidates.get(candidateFingerprint)

    if (!previous) {
      this.candidates.set(candidateFingerprint, {
        fingerprint: candidateFingerprint,
        filePath: normalizedPath,
        cwdFingerprint,
        threadFingerprint,
        messageFirstObservedAt: new Map(
          [...messages].map(message => [message, observation.sequence]),
        ),
        historicalContenders: new Set(),
        quarantined: options.readCapExceeded === true,
        blocked: false,
        leased: false,
        generationObservedAtMs: observation.generationObservedAtMs,
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
    const cwdChanged = previous.cwdFingerprint !== null &&
      cwdFingerprint !== null && previous.cwdFingerprint !== cwdFingerprint
    const threadChanged = previous.threadFingerprint !== null &&
      threadFingerprint !== null && previous.threadFingerprint !== threadFingerprint
    const generationChanged = previous.generationId !== null &&
      observation.generationId !== null &&
      previous.generationId !== observation.generationId
    if (lostEvidence || cwdChanged || threadChanged || generationChanged) {
      previous.quarantined = true
      this.recompute()
      return
    }

    previous.cwdFingerprint ??= cwdFingerprint
    previous.threadFingerprint ??= threadFingerprint
    previous.generationId ??= observation.generationId
    previous.birthtimeMs ??= observation.birthtimeMs
    for (const message of messages) {
      if (!previous.messageFirstObservedAt.has(message)) {
        previous.messageFirstObservedAt.set(message, observation.sequence)
      }
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

  compactInactiveState(): void {
    // WHY compaction happens only after the root watcher and admitted reads have
    // drained: until then, an inactive prompt HMAC can still prove that a late
    // event belongs to the stopped PTY and must block a sibling. Once drained,
    // causal prefix snapshots make those participants unnecessary.
    for (const [participantId, participant] of this.participants) {
      if (!participant.active) this.participants.delete(participantId)
    }
    for (const candidate of this.candidates.values()) {
      candidate.filePath = null
      if (candidate.quarantined || candidate.blocked || candidate.leased) {
        candidate.cwdFingerprint = null
        candidate.threadFingerprint = null
        candidate.messageFirstObservedAt.clear()
      }
    }
  }

  inspect(): FreshRolloutOwnershipInspection {
    return {
      activeParticipantCount: [...this.participants.values()]
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
        id: participant.id,
        cwdFingerprint: participant.cwdFingerprint,
        promptFingerprints: [...participant.prompts.keys()],
        hasLeaseCallback: participant.onLease !== null,
        hasDecisionCallback: participant.onDecision !== null,
        active: participant.active,
      })),
      candidates: [...this.candidates.values()].map(candidate => ({
        fingerprint: candidate.fingerprint,
        hasRawPath: candidate.filePath !== null,
        cwdFingerprint: candidate.cwdFingerprint,
        threadFingerprint: candidate.threadFingerprint,
        messageFingerprints: [...candidate.messageFirstObservedAt.keys()],
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
    const activeParticipantEdges = new Map<string, Set<string>>()
    const candidateEdges = new Map<string, Set<string>>()

    for (const participant of this.participants.values()) {
      if (participant.leasedCandidateFingerprint) continue
      for (const [candidateFingerprint, candidate] of this.candidates) {
        if (candidate.quarantined || candidate.blocked || candidate.leased ||
          this.pathLeases.has(candidateFingerprint) ||
          candidate.cwdFingerprint !== participant.cwdFingerprint) {
          continue
        }
        if (!participant.active && !this.inactiveParticipantCouldOwn(
          participant,
          candidate,
        )) {
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
        },
      })
    }

    this.publishDecisions(activeParticipantEdges, candidateEdges)

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
      candidate.messageFirstObservedAt.clear()
    }
  }

  private publishDecisions(
    participantEdges: Map<string, Set<string>>,
    candidateEdges: Map<string, Set<string>>,
  ): void {
    const allCandidateFingerprints = [...this.candidates.keys()].sort()
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

  private inactiveParticipantCouldOwn(
    participant: Participant,
    candidate: CandidateState,
  ): boolean {
    if (participant.withdrawnAtMs === null) return false
    const generationAtMs = candidate.birthtimeMs ??
      candidate.generationObservedAtMs
    return generationAtMs <=
        participant.withdrawnAtMs + PARTICIPANT_FILE_GRACE_MS &&
      generationAtMs >= participant.registeredAtMs - PARTICIPANT_FILE_GRACE_MS
  }

  private fingerprint(domain: string, value: string): string {
    return createHmac('sha256', this.hmacKey)
      .update(domain)
      .update('\0')
      .update(value)
      .digest('hex')
  }
}
