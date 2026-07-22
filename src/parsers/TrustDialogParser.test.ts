import { describe, expect, it } from 'vitest'

import {
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  CODEX_TRUST_DIALOG_DECLINE_KEYS,
  detectCodexTrustDialog,
} from './TrustDialogParser.js'

// Fixtures are CAPTURED, not invented.
//
// REAL_DIALOG is a verbatim viewport from codex-cli 0.145.0 driven through
// node-pty in a fresh temp directory. PROSE_FALSE_POSITIVE is the shape that
// actually occurred in production: 14 frames across 52 recorded Agent Code
// sessions matched all three of the old parser's markers, and every one was an
// assistant DISCUSSING the trust dialog rather than Codex showing it. Those two
// cases are the whole point of this parser, so they are the whole point of this
// file.

const REAL_DIALOG = [
  '> You are in /private/var/folders/tv/yfsy4sfx1qnbs39hbtzgl0xc0000gn/T/codex-trust-z1cosz',
  '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt',
  '  injection. Trusting the directory allows project-local config, hooks, and exec policies to load.',
  '› 1. Yes, continue',
  '  2. No, quit',
  '  Press enter to continue',
].join('\n')

const PROSE_FALSE_POSITIVE = [
  '⏺ Reading the Codex trust dialog path instead.',
  "  const REQUIRED_MARKERS = ['Do you trust the contents of this directory',",
  "    'Yes, continue', 'No, quit'] as const",
  '  Ran 1 shell command',
  '❯ approval works fine i belive? but trust is the issue for a new folder .',
].join('\n')

describe('detectCodexTrustDialog', () => {
  it('detects the real dialog and reports the directory', () => {
    const state = detectCodexTrustDialog(REAL_DIALOG)
    expect(state.visible).toBe(true)
    expect(state.workspace).toBe(
      '/private/var/folders/tv/yfsy4sfx1qnbs39hbtzgl0xc0000gn/T/codex-trust-z1cosz',
    )
    expect(state.options).toEqual([
      { key: '1', label: 'Yes, continue' },
      { key: '2', label: 'No, quit' },
    ])
  })

  it('detects regardless of which row carries the selection marker', () => {
    const onSecondRow = REAL_DIALOG
      .replace('› 1. Yes, continue', '  1. Yes, continue')
      .replace('  2. No, quit', '› 2. No, quit')
    expect(detectCodexTrustDialog(onSecondRow).visible).toBe(true)
  })

  it('ignores prose that merely quotes every marker', () => {
    // The regression that motivated structural anchoring. A phantom detection
    // is not cosmetic: codex.trust-dialog is a blocking condition, so it paints
    // an unanswerable modal over a session that is asking nothing.
    expect(detectCodexTrustDialog(PROSE_FALSE_POSITIVE).visible).toBe(false)
  })

  it('requires the option rows, not just the question', () => {
    expect(
      detectCodexTrustDialog(
        '> You are in /tmp/x\n  Do you trust the contents of this directory?',
      ).visible,
    ).toBe(false)
  })

  it('requires the anchor, not just the option rows', () => {
    expect(
      detectCodexTrustDialog(
        'Do you trust the contents of this directory?\n  1. Yes, continue\n  2. No, quit',
      ).visible,
    ).toBe(false)
  })

  it('requires the options to sit BELOW the anchor', () => {
    // Order matters: a transcript could quote the rows first and the anchor
    // later. Only a real render puts them in this order.
    const inverted = [
      '  1. Yes, continue',
      '  2. No, quit',
      '> You are in /tmp/x',
      '  Do you trust the contents of this directory?',
    ].join('\n')
    expect(detectCodexTrustDialog(inverted).visible).toBe(false)
  })

  it('returns not-visible for empty input', () => {
    expect(detectCodexTrustDialog('').visible).toBe(false)
  })

  it('pins the keystrokes to the digits, not Enter', () => {
    // '\r' confirms whatever Codex currently HIGHLIGHTS, so a stray arrow key
    // turns "trust" into "quit"; '2\r' leaked its Enter into the next screen.
    // Both digits were verified against a live 0.145.0 dialog.
    expect(CODEX_TRUST_DIALOG_ACCEPT_KEYS).toBe('1')
    expect(CODEX_TRUST_DIALOG_DECLINE_KEYS).toBe('2')
  })
})
