import { describe, expect, it } from 'vitest'

import type { StableTerminalFrame } from '../../terminal/HeadlessTerminal.js'
import { classifyCodex01491ComposerSurface } from './Codex01491ComposerSurface.js'

// Review b of codex-headless#69. These are the rows of upstream's own insta
// snapshot `chat_composer__status_surface__tests__slash_popup_footer_wide`
// (rust-v0.157.1), verbatim apart from trailing padding: a command popup
// painted ABOVE the composer, with no hint row, over a status line that has
// the accepted footer shape. Enter here dispatches the selected `/memories`
// (slash_input.rs), so the `/m` draft must never read as a composer about to
// submit it. The recorded 0.157.1 equivalents (slash and file popups) are in
// SubmittedPromptInput.recorded.test.ts.
function frame(rows: string[]): StableTerminalFrame {
  return {
    generation: 1,
    layoutEpoch: 0,
    providerLayoutEpoch: 0,
    cols: 80,
    cursor: { x: 4, y: 5 },
    rows: rows.map(text => ({ text, cells: [...text], isWrapped: false })),
  }
}

describe('Codex 0.157 popups above the composer', () => {
  it('classifies the upstream slash popup snapshot as a popup, not a composer', () => {
    expect(classifyCodex01491ComposerSurface(frame([
      '  /model     choose what model and reasoning effort to use',
      '› /memories  configure memory use and generation',
      '  /mention   mention a file',
      '  /mcp       list configured MCP tools; use /mcp verbose for details',
      '',
      '› /m',
      '',
      '  model · high · fast',
    ]))).toEqual({ kind: 'completion-popup' })
  })

  it('still reads an ordinary draft over the same status line as a composer', () => {
    expect(classifyCodex01491ComposerSurface(frame([
      '› explain the memory settings',
      '',
      '  model · high · fast',
    ]))).toMatchObject({ kind: 'primary-composer', draftText: 'explain the memory settings' })
  })

  it.each(['@', 'look at @', '$', 'use $', '/'])('declines a draft that ends in a bare popup sigil: %j', draft => {
    // The popup opens on the sigil alone, before any character follows it.
    expect(classifyCodex01491ComposerSurface(frame([`› ${draft}`, '', '  model · high · fast'])))
      .toEqual({ kind: 'completion-popup' })
  })
  // Review c of #69 (F2): the hint-row layer was only ever exercised with a
  // draft the draft rule catches too, so deleting it kept every test green.
  // Here the draft (`/` has been accepted into a plain word) matches no
  // sigil, and only the painted "enter insert · esc close" row proves the
  // popup still owns Enter.
  it('declines a composer under a painted completion hint even when the draft has no sigil', () => {
    expect(classifyCodex01491ComposerSurface(frame([
      '  README.md',
      '  enter insert · esc close',
      '',
      '› look at the readme',
      '',
      '  model · high · fast',
    ]))).toEqual({ kind: 'completion-popup' })
  })

  // Review c of #69 (F3): the fullscreen pair accepts only the two exact
  // instructional rows under the status line. Any other second row is an
  // unrecorded bottom pane and must not read as a composer.
  it('does not accept an unrecorded second footer row under the status line', () => {
    expect(classifyCodex01491ComposerSurface(frame([
      '› explain the memory settings',
      '',
      '  model · high · fast',
      '  press enter to approve',
    ]))).toEqual({ kind: 'unknown' })
  })
})
