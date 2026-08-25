import {
  normalizePromptForOwnership,
  type FreshRolloutCandidate,
  type SubmittedPrompt,
} from './FreshRolloutClaim.js'

export type FreshRolloutLease = {
  participantId: string
  filePath: string
  candidate: FreshRolloutCandidate
  prompt: SubmittedPrompt
}

export type FreshRolloutParticipantHandle = {
  registerPrompt(text: string): void
  unregister(): void
}

export type FreshRolloutCandidateObservation = {
  filePath: string
  sequence: number
  revision: number
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
  tailAuthorized: boolean
}

type Participant = {
  id: string
  cwd: string
  prompts: Map<string, SubmittedPrompt & { sequence: number }>
  onLease: (lease: FreshRolloutLease) => void
  onDecision: ((decision: FreshRolloutParticipantDecision) => void) | null
  active: boolean
  leasedPath: string | null
}

type CandidateState = {
  candidate: FreshRolloutCandidate
  messageFirstObservedAt: Map<string, number>
  historicalContenders: Set<string>
  quarantined: boolean
  leasedTo: string | null
}

type PathLease = {
  ownerId: string
  kind: 'fresh' | 'exact-id' | 'resume-lineage'
  proofIdentity: string | null
}

export class FreshRolloutOwnershipCoordinator {
  private sequence = 0
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
      cwd: this.options.normalizeCwd(options.cwd),
      prompts: new Map(),
      onLease: options.onLease,
      onDecision: options.onDecision ?? null,
      active: true,
      leasedPath: null,
    }
    this.participants.set(participant.id, participant)

    return {
      registerPrompt: text => {
        if (!participant.active || participant.leasedPath) return
        const normalized = normalizePromptForOwnership(text)
        if (!normalized || participant.prompts.has(normalized)) return

        // WHY the sequence is committed synchronously in this method: the
        // caller invokes registerPrompt before forwarding the same bytes to the
        // PTY. A durable message first observed before this sequence therefore
        // cannot have been authored by this prompt. That causal boundary lets a
        // unique owner attach immediately without gambling on a quiet-period
        // timer, while preventing late identical text from claiming history.
        participant.prompts.set(normalized, {
          text,
          normalized,
          ts: Date.now(),
          sequence: ++this.sequence,
        })
        this.recompute()
      },
      unregister: () => {
        if (!participant.active) return
        participant.active = false

        // WHY we retain the participant record and every candidate's historical
        // contender set: deleting ambiguity when a sibling exits would convert
        // lifecycle timing into ownership. Process-lifetime tombstones are
        // intentionally cheap; one record per started PTY/path is preferable to
        // ever emitting a sibling transcript under the wrong provider id.
        this.recompute()
      },
    }
  }

  beginCandidateObservation(filePath: string): FreshRolloutCandidateObservation {
    const normalizedPath = this.options.normalizePath(filePath)
    const revision = (this.candidateRevisions.get(normalizedPath) ?? 0) + 1
    this.candidateRevisions.set(normalizedPath, revision)
    return {
      filePath: normalizedPath,
      sequence: ++this.sequence,
      revision,
    }
  }

  observeCandidate(candidate: FreshRolloutCandidate): void {
    this.commitCandidateObservation(
      this.beginCandidateObservation(candidate.filePath),
      candidate,
    )
  }

  reservePath(options: {
    ownerId: string
    filePath: string
    kind: 'exact-id' | 'resume-lineage'
    proofIdentity?: string
  }): boolean {
    const filePath = this.options.normalizePath(options.filePath)
    const existing = this.pathLeases.get(filePath)
    if (existing) {
      // WHY a duplicate call by the same attachment route is idempotent but a
      // second owner is not: startup cleanup can retry safely, while sibling
      // sessions must never share one physical transcript tail.
      return existing.ownerId === options.ownerId &&
        existing.kind === options.kind &&
        existing.proofIdentity === (options.proofIdentity ?? null)
    }
    this.pathLeases.set(filePath, {
      ownerId: options.ownerId,
      kind: options.kind,
      proofIdentity: options.proofIdentity ?? null,
    })
    const candidate = this.candidates.get(filePath)
    if (candidate) candidate.leasedTo = options.ownerId
    this.recompute()
    return true
  }

  commitCandidateObservation(
    observation: FreshRolloutCandidateObservation,
    candidate: FreshRolloutCandidate,
    options: { readCapExceeded?: boolean } = {},
  ): void {
    const filePath = this.options.normalizePath(candidate.filePath)
    if (filePath !== observation.filePath ||
      this.candidateRevisions.get(filePath) !== observation.revision) {
      // WHY reads complete out of order under rapid append events. Applying an
      // older prefix after a newer one would look like truncation and could
      // corrupt causal ordering, so only the newest reserved revision commits.
      return
    }
    const observedAt = observation.sequence
    const previous = this.candidates.get(filePath)

    if (!previous) {
      this.candidates.set(filePath, {
        candidate: { ...candidate, filePath },
        messageFirstObservedAt: new Map(
          candidate.userMessages
            .filter(message => message.normalized.length > 0)
            .map(message => [message.normalized, observedAt]),
        ),
        historicalContenders: new Set(),
        // WHY a matching prompt inside a truncated prefix is still not enough:
        // evidence beyond the cap could reveal a second ownership class or a
        // replaced identity. The measured cap remains an explicit unknown, so
        // exhaustion fails closed instead of turning resource limits into an
        // attachment rule.
        quarantined: options.readCapExceeded === true,
        leasedTo: null,
      })
      this.recompute()
      return
    }

    if (previous.quarantined || previous.leasedTo) return
    if (options.readCapExceeded) {
      previous.quarantined = true
      this.recompute()
      return
    }

    // WHY candidate revisions are append-only: every read starts at byte zero.
    // Losing an already observed message or changing stable identity means the
    // path was truncated/replaced or read through an unsupported mutation. It
    // is safer to quarantine that path than to let a rewritten file erase
    // contention and become uniquely attachable.
    const nextMessages = new Set(
      candidate.userMessages
        .map(message => message.normalized)
        .filter(normalized => normalized.length > 0),
    )
    const lostEvidence = [...previous.messageFirstObservedAt.keys()]
      .some(normalized => !nextMessages.has(normalized))
    const cwdChanged = previous.candidate.cwd !== null &&
      candidate.cwd !== null &&
      this.options.normalizeCwd(previous.candidate.cwd) !==
        this.options.normalizeCwd(candidate.cwd)
    const threadChanged = previous.candidate.threadId !== null &&
      candidate.threadId !== null &&
      previous.candidate.threadId !== candidate.threadId
    if (lostEvidence || cwdChanged || threadChanged) {
      previous.quarantined = true
      this.recompute()
      return
    }

    for (const normalized of nextMessages) {
      if (!previous.messageFirstObservedAt.has(normalized)) {
        previous.messageFirstObservedAt.set(normalized, observedAt)
      }
    }
    previous.candidate = { ...candidate, filePath }
    this.recompute()
  }

  inspect(): FreshRolloutOwnershipInspection {
    let activeParticipantCount = 0
    for (const participant of this.participants.values()) {
      if (participant.active) activeParticipantCount += 1
    }
    let historicallyContestedPathCount = 0
    let quarantinedPathCount = 0
    for (const candidate of this.candidates.values()) {
      if (candidate.historicalContenders.size > 1) {
        historicallyContestedPathCount += 1
      }
      if (candidate.quarantined) quarantinedPathCount += 1
    }
    return {
      activeParticipantCount,
      observedCandidateCount: this.candidates.size,
      leasedPathCount: this.pathLeases.size,
      historicallyContestedPathCount,
      quarantinedPathCount,
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
    const participantEdges = new Map<string, Set<string>>()
    const candidateEdges = new Map<string, Set<string>>()
    const matchedPrompts = new Map<string, SubmittedPrompt>()

    for (const participant of this.participants.values()) {
      if (!participant.active || participant.leasedPath) continue
      for (const [filePath, state] of this.candidates) {
        if (state.quarantined || state.leasedTo || this.pathLeases.has(filePath)) {
          continue
        }
        if (!state.candidate.cwd ||
          this.options.normalizeCwd(state.candidate.cwd) !== participant.cwd) {
          continue
        }

        const matchedPrompt = [...participant.prompts.values()].find(prompt => {
          const messageSequence = state.messageFirstObservedAt.get(prompt.normalized)
          return messageSequence !== undefined && prompt.sequence < messageSequence
        })
        if (!matchedPrompt) continue

        let paths = participantEdges.get(participant.id)
        if (!paths) {
          paths = new Set()
          participantEdges.set(participant.id, paths)
        }
        paths.add(filePath)
        let claimantIds = candidateEdges.get(filePath)
        if (!claimantIds) {
          claimantIds = new Set()
          candidateEdges.set(filePath, claimantIds)
        }
        claimantIds.add(participant.id)
        matchedPrompts.set(`${participant.id}\0${filePath}`, matchedPrompt)
      }
    }

    // WHY contention is recorded before selecting mutual singletons: if two
    // claimants were simultaneously valid for one path, neither later exit nor
    // callback order may cleanse that fact. This is the state the old pure
    // per-instance claimant could never observe.
    for (const [filePath, claimantIds] of candidateEdges) {
      if (claimantIds.size <= 1) continue
      const candidate = this.candidates.get(filePath)
      if (!candidate) continue
      for (const claimantId of claimantIds) {
        candidate.historicalContenders.add(claimantId)
      }
    }

    const callbacks: Array<{
      participant: Participant
      lease: FreshRolloutLease
    }> = []
    for (const [participantId, paths] of participantEdges) {
      if (paths.size !== 1) continue
      const [filePath] = paths
      const claimantIds = candidateEdges.get(filePath)
      if (!claimantIds || claimantIds.size !== 1) continue
      const participant = this.participants.get(participantId)
      const state = this.candidates.get(filePath)
      const prompt = matchedPrompts.get(`${participantId}\0${filePath}`)
      if (!participant || !participant.active || participant.leasedPath ||
        !state || state.quarantined || state.leasedTo || !prompt) {
        continue
      }
      if (state.historicalContenders.size > 1 || this.pathLeases.has(filePath)) {
        continue
      }

      // WHY the lease is installed before user code runs: onLease immediately
      // starts the physical tail. Reentrant callbacks and sibling watcher work
      // must therefore see the path as unavailable before any I/O can occur.
      participant.leasedPath = filePath
      state.leasedTo = participantId
      this.pathLeases.set(filePath, {
        ownerId: participantId,
        kind: 'fresh',
        proofIdentity: null,
      })
      callbacks.push({
        participant,
        lease: {
          participantId,
          filePath,
          candidate: state.candidate,
          prompt,
        },
      })
    }

    for (const participant of this.participants.values()) {
      if (!participant.active || !participant.onDecision) continue
      const paths = participantEdges.get(participant.id) ?? new Set<string>()
      const competitors = new Set<string>()
      let historicallyContestedCandidateCount = 0
      for (const filePath of paths) {
        for (const contender of candidateEdges.get(filePath) ?? []) {
          if (contender !== participant.id) competitors.add(contender)
        }
        if ((this.candidates.get(filePath)?.historicalContenders.size ?? 0) > 1) {
          historicallyContestedCandidateCount += 1
        }
      }
      let sameCwdCandidateCount = 0
      for (const candidate of this.candidates.values()) {
        if (candidate.candidate.cwd &&
          this.options.normalizeCwd(candidate.candidate.cwd) === participant.cwd) {
          sameCwdCandidateCount += 1
        }
      }
      const contended = competitors.size > 0 ||
        historicallyContestedCandidateCount > 0 || paths.size > 1
      const decision: FreshRolloutParticipantDecision = participant.leasedPath
        ? {
            decision: 'accept',
            reason: 'path-leased',
            localPromptCount: participant.prompts.size,
            candidateCount: this.candidates.size,
            sameCwdCandidateCount,
            matchingCandidateCount: paths.size,
            competingParticipantCount: competitors.size,
            historicallyContestedCandidateCount,
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
            matchingCandidateCount: paths.size,
            competingParticipantCount: competitors.size,
            historicallyContestedCandidateCount,
            tailAuthorized: false,
          }
      try {
        participant.onDecision(decision)
      } catch {
        // Diagnostics are deliberately observational. A recorder or listener
        // failure must never mutate ownership or suppress a valid lease.
      }
    }

    for (const { participant, lease } of callbacks) {
      try {
        participant.onLease(lease)
      } catch {
        // WHY callback failure does not release the lease: once tail authority
        // crossed the coordinator boundary, another owner cannot know whether
        // the first tail opened partially. Tombstoning preserves at-most-once
        // attachment even when consumer startup fails halfway through.
        participant.active = false
      }
    }
  }
}
