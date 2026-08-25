const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const CSI = /^\x1b\[([0-9;?]*)([@-~])/

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

  consume(data: string): string[] {
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
        case '\r':
        case '\n': {
          const prompt = this.finishSubmission()
          if (prompt !== null) submitted.push(prompt)
          break
        }
        case '\x03': // Ctrl+C cancels the composer.
          this.resetComposer()
          break
        case '\x01': // Ctrl+A
          this.cursor = 0
          break
        case '\x05': // Ctrl+E
          this.cursor = this.text.length
          break
        case '\x08':
        case '\x7f':
          this.backspace()
          break
        case '\x04': // Ctrl+D
          this.deleteForward()
          break
        case '\x0b': // Ctrl+K
          this.text = this.text.slice(0, this.cursor)
          break
        case '\x15': // Ctrl+U
          this.text = this.text.slice(this.cursor)
          this.cursor = 0
          // Clearing from an end-positioned history entry restores known local
          // state. This is the ordinary recovery after Up was pressed by mistake.
          if (!this.text) this.valid = true
          break
        case '\x17': // Ctrl+W
          this.deletePreviousWord()
          break
        case '\t':
          // Completion changes text without sending those replacement bytes
          // through this boundary. The eventual Enter therefore must fail closed.
          this.valid = false
          break
        default:
          if (codePoint < 0x20) this.valid = false
          else this.insert(character)
      }
    }

    return submitted
  }

  private applyCsi(parameters: string, final: string): void {
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
      this.cursor = 0
      return
    }
    if (final === 'F' || (final === '~' && parameters === '4')) {
      this.cursor = this.text.length
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
    const retained = before.replace(/\s*\S+\s*$/, '')
    this.text = retained + this.text.slice(this.cursor)
    this.cursor = retained.length
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

function longestMarkerPrefixSuffix(value: string, marker: string): string {
  const max = Math.min(value.length, marker.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return value.slice(-length)
  }
  return ''
}
