import type { StableTerminalFrame } from '../terminal/HeadlessTerminal.js'
import {
  createCodex01491PromptInputProfile,
  isIssuedCodexPromptInputProfile,
  type CodexPromptInputProfile,
} from './prompt-input/CodexPromptInputProfile.js'
import { PromptInputEvidence } from './prompt-input/PromptInputEvidence.js'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const CSI = /^\x1b\[([0-9;?]*)([@-~])/
const WORD_SEPARATORS = new Set(
  [...'`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?'],
)

export type SubmittedPromptInputContext = {
  /**
   * Whether this exact Tab key is known to reach Codex's submission handler.
   *
   * WHY the caller supplies this per write: rust-v0.149.1 submits/queues plain
   * Tab only after slash/file/mention popups have had the first chance to
   * consume it. The bytes are identical in both cases, so the assembler cannot
   * infer ownership from `\t` alone.
   */
  tabBehavior?: 'submit' | 'complete-or-unknown'
  /** Provider-rendered current viewport retained by recorded-contract callers. */
  screenBeforeWrite?: string
  /**
   * Compatibility input profile. Live CodexHeadless callers use the opaque
   * package-issued profile directly; this structural shape exists so the
   * committed Stage 26 fixture can remain an independent pre-repair contract.
   */
  inputProfile?: unknown
}

export function inferCodexTabBehavior(
  screenBeforeWrite: string,
): NonNullable<SubmittedPromptInputContext['tabBehavior']> {
  // WHY the footer is provider-rendered keymap evidence. rust-v0.149.1 removes
  // this hint when Tab is remapped, while popup candidates are conservatively
  // rejected again from the local draft inside SubmittedPromptInput.
  return screenBeforeWrite.toLowerCase().includes('tab to queue')
    ? 'submit'
    : 'complete-or-unknown'
}

/**
 * Reconstruct submitted composer text from the exact chunks written to a PTY.
 *
 * WHY this state belongs beside transcript ownership rather than in xterm or
 * Agent Code: fresh rollout identity needs the prompt bytes immediately before
 * the same PTY write that submits them. Renderer state is neither shared with
 * automation callers nor causally ordered with this write boundary. This small
 * parser deliberately models only input edits whose result is deterministic;
 * history completion, autocomplete, and unknown controls invalidate the current
 * submission so ownership fails closed instead of guessing composer contents.
 */
export class SubmittedPromptInput {
  private text = ''
  private cursor = 0
  private valid = true
  private pending = ''
  private inBracketedPaste = false
  private strictEvidence: PromptInputEvidence | null = null
  private strictProfileKey: string | null = null
  private strictFrameGeneration = 0

  consume(data: string, context: SubmittedPromptInputContext = {}): string[] {
    if (context.inputProfile !== undefined) {
      return this.consumeRecordedContract(data, context)
    }

    this.pending += data
    const submitted: string[] = []

    while (this.pending) {
      if (this.inBracketedPaste) {
        const end = this.pending.indexOf(PASTE_END)
        if (end >= 0) {
          this.insert(this.pending.slice(0, end))
          this.pending = this.pending.slice(end + PASTE_END.length)
          this.inBracketedPaste = false
          continue
        }

        // WHY a marker may be split across arbitrary xterm onData chunks. Keep
        // only the longest possible marker prefix pending; everything before it
        // is literal pasted content and can be committed to the local buffer.
        const retained = longestMarkerPrefixSuffix(this.pending, PASTE_END)
        const literalLength = this.pending.length - retained.length
        this.insert(this.pending.slice(0, literalLength))
        this.pending = retained
        break
      }

      if (this.pending.startsWith('\x1b')) {
        if (this.pending.startsWith(PASTE_START)) {
          this.pending = this.pending.slice(PASTE_START.length)
          this.inBracketedPaste = true
          continue
        }
        if (PASTE_START.startsWith(this.pending)) break

        const sequence = CSI.exec(this.pending)
        if (!sequence) {
          // An incomplete CSI must survive until the next chunk. A non-CSI
          // escape changes composer state in a provider-specific way (Alt keys,
          // history, etc.), so consume it and invalidate this submission.
          if (this.pending === '\x1b' || this.pending === '\x1b[' ||
            /^\x1b\[[0-9;?]*$/.test(this.pending)) break
          this.valid = false
          this.pending = this.pending.slice(Math.min(2, this.pending.length))
          continue
        }
        this.pending = this.pending.slice(sequence[0].length)
        this.applyCsi(sequence[1] ?? '', sequence[2] ?? '')
        continue
      }

      const codePoint = this.pending.codePointAt(0)
      if (codePoint === undefined) break
      const character = String.fromCodePoint(codePoint)
      this.pending = this.pending.slice(character.length)

      switch (character) {
        case '\r': {
          const prompt = this.finishSubmission()
          if (prompt !== null) submitted.push(prompt)
          break
        }
        case '\n':
          // WHY Ctrl+J is a newline in Codex's exact default editor. Bracketed
          // paste already arrives through insert(), while treating this raw byte
          // as submit invents a prompt the provider has not dispatched.
          this.insert('\n')
          break
        case '\x03': // Ctrl+C cancels the composer.
          this.resetComposer()
          break
        case '\x01': // Ctrl+A
          this.cursor = this.beginningOfCurrentLine()
          break
        case '\x05': // Ctrl+E
          this.cursor = this.endOfCurrentLine()
          break
        case '\x08':
        case '\x7f':
          this.backspace()
          break
        case '\x04': // Ctrl+D
          this.deleteForward()
          break
        case '\x0b': // Ctrl+K
          this.killToEndOfLine()
          break
        case '\x15': // Ctrl+U
          this.killToBeginningOfLine()
          break
        case '\x17': // Ctrl+W
          this.deletePreviousWord()
          break
        case '\t':
          if (context.tabBehavior === 'submit' && this.tabCanOnlySubmit()) {
            const prompt = this.finishSubmission()
            if (prompt !== null) submitted.push(prompt)
          } else {
            // Completion changes text without sending those replacement bytes
            // through this boundary. The eventual Enter therefore fails closed.
            this.valid = false
          }
          break
        default:
          if (codePoint < 0x20) this.valid = false
          else this.insert(character)
      }
    }

    return submitted
  }

  private consumeRecordedContract(
    data: string,
    context: SubmittedPromptInputContext,
  ): string[] {
    const profileKey = compatibilityProfileKey(context.inputProfile)
    if (profileKey !== this.strictProfileKey) {
      this.strictProfileKey = profileKey
      this.strictEvidence = new PromptInputEvidence(
        compatibilityProfile(context.inputProfile),
      )
      this.strictFrameGeneration = 0
    }

    let frame: StableTerminalFrame | null = null
    if (typeof context.screenBeforeWrite === 'string') {
      this.strictFrameGeneration++
      const rowTexts = context.screenBeforeWrite.split('\n')
      const cols = Math.max(140, ...rowTexts.map(row => [...row].length))
      frame = {
        generation: this.strictFrameGeneration,
        cols,
        rows: rowTexts.map(text => ({
          text,
          cells: [...text],
          isWrapped: false,
        })),
        cursor: { x: 0, y: 0 },
      }
    }

    return this.strictEvidence?.consume(data, { frame }) ?? []
  }

  private applyCsi(parameters: string, final: string): void {
    if (parameters.includes(';') || parameters.includes('?')) {
      // WHY `parseInt("1;5") === 1` is precisely the unsafe behavior recorded
      // by the seventh gate: Ctrl+Left moves by word in Codex but was modeled as
      // one scalar. Private and modified sequences remain invalid until their
      // exact provider result is represented here.
      this.valid = false
      return
    }
    const count = Math.max(1, Number.parseInt(parameters, 10) || 1)
    if (final === 'D') {
      for (let i = 0; i < count; i += 1) this.moveLeft()
      return
    }
    if (final === 'C') {
      for (let i = 0; i < count; i += 1) this.moveRight()
      return
    }
    if (final === 'H' || (final === '~' && parameters === '1')) {
      this.cursor = this.beginningOfCurrentLine()
      return
    }
    if (final === 'F' || (final === '~' && parameters === '4')) {
      this.cursor = this.endOfCurrentLine()
      return
    }
    if (final === '~' && parameters === '3') {
      this.deleteForward()
      return
    }

    // Up/Down history, modified movement, and provider-specific CSI sequences
    // can replace the composer without echoing replacement text through write().
    this.valid = false
  }

  private insert(value: string): void {
    if (!value) return
    this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor)
    this.cursor += value.length
  }

  private moveLeft(): void {
    if (this.cursor <= 0) return
    const before = this.text.slice(0, this.cursor)
    const previous = [...before].at(-1)
    this.cursor -= previous?.length ?? 0
  }

  private moveRight(): void {
    if (this.cursor >= this.text.length) return
    const next = [...this.text.slice(this.cursor)][0]
    this.cursor += next?.length ?? 0
  }

  private backspace(): void {
    if (this.cursor <= 0) return
    const before = this.text.slice(0, this.cursor)
    const previous = [...before].at(-1)
    if (!previous) return
    const start = this.cursor - previous.length
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
    this.cursor = start
  }

  private deleteForward(): void {
    if (this.cursor >= this.text.length) return
    const next = [...this.text.slice(this.cursor)][0]
    if (!next) return
    this.text = this.text.slice(0, this.cursor) +
      this.text.slice(this.cursor + next.length)
  }

  private deletePreviousWord(): void {
    const before = this.text.slice(0, this.cursor)
    let start = before.length
    while (start > 0) {
      const previous = [...before.slice(0, start)].at(-1)
      if (!previous || !/\s/u.test(previous)) break
      start -= previous.length
    }
    const previous = [...before.slice(0, start)].at(-1)
    if (previous && WORD_SEPARATORS.has(previous)) {
      while (start > 0) {
        const candidate = [...before.slice(0, start)].at(-1)
        if (!candidate || !WORD_SEPARATORS.has(candidate)) break
        start -= candidate.length
      }
    } else {
      while (start > 0) {
        const candidate = [...before.slice(0, start)].at(-1)
        if (!candidate || /\s/u.test(candidate) || WORD_SEPARATORS.has(candidate)) break
        start -= candidate.length
      }
    }
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
    this.cursor = start
  }

  private beginningOfCurrentLine(): number {
    return this.text.lastIndexOf('\n', Math.max(0, this.cursor - 1)) + 1
  }

  private endOfCurrentLine(): number {
    const newline = this.text.indexOf('\n', this.cursor)
    return newline === -1 ? this.text.length : newline
  }

  private killToBeginningOfLine(): void {
    const beginning = this.beginningOfCurrentLine()
    const start = this.cursor === beginning && beginning > 0
      ? beginning - 1
      : beginning
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
    this.cursor = start
    // WHY no edit can recover `valid`: history/completion may have installed
    // unknown text on another line, and Ctrl+U is line-scoped in Codex. Only a
    // provider-proven full reset (Ctrl+C or completed submission) starts a new
    // trustworthy composer lifetime.
  }

  private killToEndOfLine(): void {
    const end = this.endOfCurrentLine()
    const deleteEnd = this.cursor === end && end < this.text.length
      ? end + 1
      : end
    this.text = this.text.slice(0, this.cursor) + this.text.slice(deleteEnd)
  }

  private tabCanOnlySubmit(): boolean {
    const trimmed = this.text.trimStart()
    if (trimmed.startsWith('!') || trimmed.startsWith('/')) return false
    // WHY @ file/mention completion gets the first chance at Tab. We do not
    // attempt to reproduce Codex's token grammar here: refusing all @ drafts is
    // conservative and prevents a completion from becoming false ownership.
    return !/(^|\s)@\S*$/u.test(this.text.slice(0, this.cursor))
  }

  private finishSubmission(): string | null {
    const prompt = this.valid && this.text.trim() ? this.text : null
    this.resetComposer()
    return prompt
  }

  private resetComposer(): void {
    this.text = ''
    this.cursor = 0
    this.valid = true
  }
}

function compatibilityProfile(value: unknown): CodexPromptInputProfile | null {
  if (isIssuedCodexPromptInputProfile(value)) return value
  if (typeof value !== 'object' || value === null) return null
  const profile = value as {
    cliVersion?: unknown
    upstreamTag?: unknown
    configClass?: unknown
    configOverrides?: unknown
  }
  if (profile.upstreamTag !== 'rust-v0.149.1' ||
    profile.configClass !== 'recorded-default-01491' ||
    !Array.isArray(profile.configOverrides) ||
    profile.configOverrides.length !== 0 ||
    typeof profile.cliVersion !== 'string') {
    return null
  }
  try {
    return createCodex01491PromptInputProfile({
      cliVersion: profile.cliVersion,
    })
  } catch {
    return null
  }
}

function compatibilityProfileKey(value: unknown): string {
  if (isIssuedCodexPromptInputProfile(value)) {
    return `issued:${value.cliVersion}:${value.configOverrides.join('\u0000')}`
  }
  try {
    return `recorded:${JSON.stringify(value)}`
  } catch {
    return 'recorded:unserializable'
  }
}

function longestMarkerPrefixSuffix(value: string, marker: string): string {
  const max = Math.min(value.length, marker.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return value.slice(-length)
  }
  return ''
}
