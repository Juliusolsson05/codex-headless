export type ResumeForkDecision =
  | { type: 'accept'; lineageOverlap: number; requiredOverlap: number }
  | {
      type: 'reject'
      reason: 'cwd-mismatch' | 'missing-lineage' | 'insufficient-lineage-overlap'
      lineageOverlap: number
      requiredOverlap: number
      message?: string
    }

export type ResumeForkCandidateOptions = {
  ownCwd: string
  candidateText: string
  initialPath: string
  candidatePath: string
  lineageIds: ReadonlySet<string>
  requiredOverlapLimit: number
  normalizeCwd: (cwd: string) => string
}

// Collect the opaque per-item identifiers (`payload.id`, `payload.call_id`,
// `payload.turn_id`) from a rollout JSONL text blob into `into`.
//
// These ids are Codex-generated value strings (`msg_...`, `fc_...`,
// `rs_...`, `call_...`, turn uuids). A reconstructed / forked rollout
// copies this session's prior history into the new file, so its early entries
// carry the SAME ids; an unrelated Codex agent has entirely different ids.
// Matching by id VALUE (not raw line bytes) is robust to whitespace / key-order
// changes a re-serialised copy might introduce. `session_meta` is skipped
// because it is unique per file and never copied. `cap` bounds memory on long
// transcripts.
export function collectRolloutLineageIds(
  text: string,
  into: Set<string>,
  cap: number,
): void {
  for (const rawLine of text.split('\n')) {
    if (into.size >= cap) break
    const line = rawLine.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = parsed as { type?: unknown; payload?: unknown }
    if (record.type === 'session_meta') continue
    const payload = record.payload
    if (!payload || typeof payload !== 'object') continue
    for (const key of ['id', 'call_id', 'turn_id'] as const) {
      const value = (payload as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.length > 0) into.add(value)
    }
  }
}

export function decideResumeForkCandidate(
  options: ResumeForkCandidateOptions,
): ResumeForkDecision {
  const ownCwd = options.normalizeCwd(options.ownCwd)
  let cwdMatch = false
  for (const rawLine of options.candidateText.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = parsed as {
      type?: unknown
      payload?: { cwd?: unknown }
    }
    const candidateCwd = record.payload?.cwd
    if (
      (record.type === 'session_meta' || record.type === 'turn_context') &&
      typeof candidateCwd === 'string' &&
      options.normalizeCwd(candidateCwd) === ownCwd
    ) {
      cwdMatch = true
      break
    }
  }
  if (!cwdMatch) {
    return {
      type: 'reject',
      reason: 'cwd-mismatch',
      lineageOverlap: 0,
      requiredOverlap: 0,
    }
  }

  // Same-cwd is only a weak filter. Agent Code can run a parent pane and child
  // orchestration agents in the same project, so accepting on cwd alone would
  // splice a sibling transcript into the resumed pane. No lineage means "stay
  // put and explain why" rather than "transcript is broken".
  if (options.lineageIds.size === 0) {
    return {
      type: 'reject',
      reason: 'missing-lineage',
      lineageOverlap: 0,
      requiredOverlap: 0,
      message:
        `Codex resume: cannot verify lineage for same-cwd rollout ${options.candidatePath} - ` +
        `resumed file ${options.initialPath} carried no fingerprintable history; ` +
        `not switching (a blind cwd-only switch could adopt a sibling agent).`,
    }
  }

  const candidateIds = new Set<string>()
  collectRolloutLineageIds(options.candidateText, candidateIds, 8000)
  let lineageOverlap = 0
  for (const id of candidateIds) {
    if (options.lineageIds.has(id)) lineageOverlap += 1
  }

  const requiredOverlap = Math.min(
    options.requiredOverlapLimit,
    options.lineageIds.size,
  )

  if (lineageOverlap >= requiredOverlap) {
    return { type: 'accept', lineageOverlap, requiredOverlap }
  }

  return {
    type: 'reject',
    reason: 'insufficient-lineage-overlap',
    lineageOverlap,
    requiredOverlap,
    message:
      `Codex resume: ignoring same-cwd rollout ${options.candidatePath} - only ` +
      `${lineageOverlap}/${requiredOverlap} item ids shared with resumed file ` +
      `${options.initialPath}; treating it as an unrelated session.`,
  }
}
