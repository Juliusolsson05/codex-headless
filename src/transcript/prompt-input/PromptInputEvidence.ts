import { createHmac, randomBytes } from 'node:crypto'

import type { StableTerminalFrame } from '../../terminal/HeadlessTerminal.js'
import {
  classifyCodex01491ComposerSurface,
  type Codex01491ComposerSurface,
} from './Codex01491ComposerSurface.js'
import {
  isIssuedCodexPromptInputProfile,
  type CodexPromptInputProfile,
} from './CodexPromptInputProfile.js'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export type PromptInputObservation = {
  frame: StableTerminalFrame | null
}

/**
 * Converts a provider-rendered composer boundary into rollout-ownership proof.
 *
 * This class intentionally does not emulate Codex's text editor. Unicode
 * segmentation, word motion, history preview, completions, and configurable
 * controls all live upstream. Reimplementing them from raw input bytes created
 * plausible-but-wrong prompts, which are dangerous because a wrong prompt can
 * authorize a sibling's same-CWD rollout. The rendered bottom composer is the
 * source of truth; raw bytes are used only for a deterministic atomic send into
 * a provider-proven empty primary composer.
 */
export class PromptInputEvidence {
  private readonly profile: CodexPromptInputProfile | null
  private readonly revisionKey = randomBytes(32)
  private latestFrameGeneration = 0
  private refreshAfterGeneration = -1
  private refreshAfterComposerRevision: string | null = null
  private profileInvalidated = false

  constructor(profile: CodexPromptInputProfile | null | undefined) {
    this.profile = isIssuedCodexPromptInputProfile(profile) ? profile : null
  }

  consume(data: string, observation: PromptInputObservation): string[] {
    if (!this.profile || this.profileInvalidated) return []

    const frame = observation.frame
    if (frame) this.latestFrameGeneration = Math.max(
      this.latestFrameGeneration,
      frame.generation,
    )
    const surface = classifyCodex01491ComposerSurface(frame)
    const hasEnter = data.includes('\r')
    const hasTab = data.includes('\t')

    if (hasTab) {
      if (data !== '\t') {
        // WHY the frame is a pre-write snapshot. If this chunk contains edits
        // before Tab, the rendered draft is already stale by the instant Tab
        // routes, even though both bytes share one consumer write call.
        this.notePotentialComposerMutation(frame, surface)
        return []
      }
      if (surface.kind !== 'primary-composer' || !surface.queueWithTab) {
        // WHY completion panes consume Tab before the normal composer. A draft
        // or transcript can literally contain "tab to queue"; only the final
        // anchored footer in the classified primary pane proves queue routing.
        this.notePotentialComposerMutation(frame, surface)
        return []
      }
      if (!this.frameIsFresh(frame, surface)) return []
      const prompt = nonEmptyPrompt(surface.draftText)
      if (!prompt) return []
      this.resetAfterSubmission(frame)
      return [prompt]
    }

    if (hasEnter) {
      if (surface.kind !== 'primary-composer' ||
        !this.frameIsFresh(frame, surface)) {
        // WHY Enter confirms approvals, accepts history previews, and inserts
        // popup selections. None of those actions submit the underlying draft.
        return []
      }

      const renderedPrompt = nonEmptyPrompt(surface.draftText)
      if (renderedPrompt && data === '\r') {
        if (invalidatesLiveInputProfile(renderedPrompt)) {
          this.profileInvalidated = true
          return []
        }
        this.resetAfterSubmission(frame)
        return [renderedPrompt]
      }

      if (renderedPrompt) {
        // WHY `suffix\r` against an already-rendered draft submits the draft
        // plus suffix, not the pre-write draft. Only a standalone Enter can
        // promote a non-empty rendered value without emulating those edits.
        return []
      }

      // Programmatic sendPrompt() writes literal input and Enter atomically, so
      // the pre-write frame correctly shows an empty composer. This is the only
      // raw-byte reconstruction retained: it contains no edits whose semantics
      // could differ from the provider profile.
      const atomicPrompt = extractAtomicSubmission(data)
      if (atomicPrompt) {
        if (invalidatesLiveInputProfile(atomicPrompt)) {
          this.profileInvalidated = true
          return []
        }
        this.resetAfterSubmission(frame)
        return [atomicPrompt]
      }
      return []
    }

    if (surface.kind === 'non-composer-modal' ||
      surface.kind === 'history-search' ||
      surface.kind === 'completion-popup') {
      // WHY modal bytes belong to the active control, not the hidden composer.
      // In particular, trust writes `1`, while Ctrl+C in reverse history search
      // restores (rather than clears) the underlying draft. The next primary
      // frame will reveal the provider's actual composer value.
      return []
    }

    if (canMutateComposer(data)) {
      this.notePotentialComposerMutation(frame, surface)
    }
    return []
  }

  private notePotentialComposerMutation(
    frame: StableTerminalFrame | null,
    surface: Codex01491ComposerSurface,
  ): void {
    // WHY a pre-write frame necessarily predates this edit. Submission may use
    // only a later provider render whose composer value or logical cursor has
    // changed, never an unrelated status/redraw generation. The keyed digest
    // keeps that equality fact without retaining another copy of prompt text.
    this.refreshAfterGeneration = Math.max(
      this.refreshAfterGeneration,
      frame?.generation ?? this.latestFrameGeneration,
    )
    this.refreshAfterComposerRevision = frame &&
      frameLayoutIsProviderRendered(frame) &&
      surface.kind === 'primary-composer'
      ? this.composerRevision(frame, surface)
      : null
  }

  private frameIsFresh(
    frame: StableTerminalFrame | null,
    surface: Codex01491ComposerSurface,
  ): frame is StableTerminalFrame {
    if (!frame || !frameLayoutIsProviderRendered(frame) ||
      frame.generation <= this.refreshAfterGeneration) {
      return false
    }
    if (this.refreshAfterComposerRevision === null) {
      // WHY old recordings do not contain every pre-edit frame, and live code
      // can sample during an in-flight parse. In that case generation remains
      // the conservative fallback. Whenever a genuine pre-write composer was
      // available, the stronger revision fence below is mandatory.
      return true
    }
    if (surface.kind !== 'primary-composer') {
      return false
    }
    return this.composerRevision(frame, surface) !==
      this.refreshAfterComposerRevision
  }

  private resetAfterSubmission(frame: StableTerminalFrame): void {
    this.latestFrameGeneration = Math.max(this.latestFrameGeneration, frame.generation)
    this.refreshAfterGeneration = frame.generation
    // WHY submission can transition an empty composer back to an identical
    // empty composer. A generation fence is sufficient here; requiring a text
    // revision would permanently disable the next atomic sendPrompt().
    this.refreshAfterComposerRevision = null
  }

  private composerRevision(
    frame: StableTerminalFrame,
    surface: Extract<Codex01491ComposerSurface, { kind: 'primary-composer' }>,
  ): string {
    const composerRow = findComposerRow(frame)
    const relativeCursorY = composerRow < 0
      ? frame.cursor.y
      : frame.cursor.y - composerRow
    return createHmac('sha256', this.revisionKey)
      .update(surface.draftText)
      .update('\0')
      .update(String(frame.cursor.x))
      .update('\0')
      .update(String(relativeCursorY))
      .digest('hex')
  }
}

function frameLayoutIsProviderRendered(frame: StableTerminalFrame): boolean {
  return frame.layoutEpoch === frame.providerLayoutEpoch
}

function findComposerRow(frame: StableTerminalFrame): number {
  const firstCandidate = Math.max(0, frame.rows.length - 15)
  for (let index = frame.rows.length - 1; index >= firstCandidate; index -= 1) {
    if (/^›(?: |$)/u.test(frame.rows[index]?.text ?? '')) return index
  }
  return -1
}

function nonEmptyPrompt(value: string): string | null {
  return value.trim() ? value : null
}

function canMutateComposer(data: string): boolean {
  return data.length > 0
}

function invalidatesLiveInputProfile(prompt: string): boolean {
  const command = prompt.trim()
  return command === '/vim' || command === '/keymap'
}

function extractAtomicSubmission(data: string): string | null {
  if (!data.endsWith('\r') || data.slice(0, -1).includes('\r')) return null
  const body = data.slice(0, -1)

  if (body.startsWith(PASTE_START) && body.endsWith(PASTE_END)) {
    const pasted = body.slice(PASTE_START.length, -PASTE_END.length)
    return nonEmptyPrompt(pasted)
  }

  // WHY plain atomic input is safe only when every preceding byte is literal.
  // Controls, Escape sequences, and bare newlines invoke editor/provider logic;
  // those cases wait for a provider-rendered draft instead.
  if (!body || /[\x00-\x1f\x7f]/u.test(body)) return null
  return nonEmptyPrompt(body)
}
