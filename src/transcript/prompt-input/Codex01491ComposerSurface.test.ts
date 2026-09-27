import { describe, expect, it } from 'vitest'

import type { StableTerminalFrame } from '../../terminal/HeadlessTerminal.js'
import { classifyCodex01491ComposerSurface } from './Codex01491ComposerSurface.js'

// Review c of #67: the 0.156+ trust-hint anchor in this surface survived the
// whole suite when broken. With it broken, the new trust dialog reads as
// something other than a modal to the prompt-input surface, so these pin it,
// with the hint as Codex paints it (last row) and wrapped once (the Windows
// variant below 46 columns). Rows are the 80-column 0.157.1 dialog from
// testing/fixtures/trust-dialog-0157, below its hard-wrapped path.
function frame(rows: string[]): StableTerminalFrame {
  return {
    generation: 1,
    layoutEpoch: 0,
    providerLayoutEpoch: 0,
    cols: 80,
    cursor: { x: 0, y: 0 },
    rows: rows.map(text => ({ text, cells: [...text], isWrapped: false })),
  }
}

const DIALOG = [
  '  Folder access',
  '  /private/tmp/claude-501/-Users-fixture-user-Desktop-Development-agent-code/d',
  '  0000000-0000-0000-0000-000000000000/scratchpad/rec/untrusted-ABCD',
  '',
  '  Trust this folder? Codex can read, edit, and run files here, subject to your',
  '  permission settings. Folder settings can run code automatically, even',
  '  without a model request. Continue only if you trust these files. Your trust',
  '  decision will be saved.',
  '',
  '› 1. Trust and continue',
  '  2. Back to Agent Command Center',
  '',
]

describe('classifyCodex01491ComposerSurface on the 0.156+ trust dialog', () => {
  it('treats the dialog as a modal, not a composer', () => {
    expect(classifyCodex01491ComposerSurface(frame([...DIALOG, '  enter continue · esc back'])))
      .toEqual({ kind: 'non-composer-modal' })
  })

  it('treats the dialog as a modal when the Windows hint wraps', () => {
    expect(classifyCodex01491ComposerSurface(frame([
      ...DIALOG,
      '  enter continue and create sandbox ·',
      '  esc back',
    ]))).toEqual({ kind: 'non-composer-modal' })
  })
})
