import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { trustDialogModule } from '../conditions/trustDialog.js'
import { extractCodexStreamingText } from './ScreenParser.js'
import {
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  CODEX_TRUST_DIALOG_DECLINE_KEYS,
  CODEX_TRUST_DIALOG_FOLDER_ACCESS_ACCEPT_KEYS,
  CODEX_TRUST_DIALOG_FOLDER_ACCESS_DECLINE_KEYS,
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

  it('ignores a verbatim legacy dialog quoted above the live composer', () => {
    // Review c of #67: the legacy layout had the same copied-frame phantom the
    // 0.156+ layout was fixed for. Its hint is the last painted row too.
    const quoted = [
      '• Here is the old Codex screen I captured:',
      REAL_DIALOG,
      '',
      '› Ask Codex to do anything',
      '',
      '  gpt-5.4 medium fast · ~/project',
    ].join('\n')
    expect(detectCodexTrustDialog(quoted).visible).toBe(false)
    expect(extractCodexStreamingText(quoted)).toContain('Yes, continue')
  })

  it('requires the legacy options to be adjacent rows directly under the question', () => {
    const scattered = [
      '> You are in /tmp/x',
      '  Do you trust the contents of this directory?',
      '• unrelated assistant paragraph one',
      '› 1. Yes, continue',
      '• unrelated assistant paragraph two',
      '  2. No, quit',
      '  Press enter to continue',
    ].join('\n')
    expect(detectCodexTrustDialog(scattered).visible).toBe(false)
  })

  it('reads the legacy Windows hint wrapped over two rows', () => {
    const wrapped = REAL_DIALOG.replace(
      '  Press enter to continue',
      '  Press enter to continue and create a\n  sandbox...',
    )
    expect(detectCodexTrustDialog(wrapped).visible).toBe(true)
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

// --- 0.156+ `Folder access` layout (#65) ---
//
// Upstream's own insta snapshots at rust-v0.157.1, verbatim (see the fixture's
// `evidence`). They cover the variants one local folder cannot produce. The
// recorded local frame lives in TrustDialogParser.recorded.test.ts.
type UpstreamSnapshot = { name: string; frame: string }
const upstream = (JSON.parse(readFileSync(
  new URL('../../testing/fixtures/trust-dialog-0157/upstream-snapshots-0157.1.json', import.meta.url),
  'utf8',
)) as { snapshots: UpstreamSnapshot[] }).snapshots
const frame = (name: string) => upstream.find(snapshot => snapshot.name === name)!.frame

describe('detectCodexTrustDialog on the 0.156+ Folder access layout', () => {
  it('reads every upstream variant, with labels exactly as painted', () => {
    const expected: Record<string, { workspace: string; trustTarget?: string; labels: [string, string] }> = {
      renders_snapshot_for_git_repo: { workspace: '/workspace/project', labels: ['Trust and continue', 'Quit'] },
      renders_snapshot_for_remote_git_subdirectory: { workspace: '/srv/remote/project/nested', trustTarget: '/srv/remote/project', labels: ['Trust and continue', 'Back to Agent Command Center'] },
      renders_snapshot_for_trust_error: { workspace: '/workspace/project', labels: ['Trust and continue', 'Quit'] },
      renders_restricted_folder: { workspace: '/workspace/project', labels: ['Open restricted', 'Back to Agent Command Center'] },
      existing_untrusted_task: { workspace: '/workspace/project', labels: ['Open existing task', 'Back to Agent Command Center'] },
      // Hard wrap at an arbitrary character: "…/long-nested-folde" + "r".
      folder_picker_restricted_40x24: { workspace: '/workspace/project/long-nested-folder', labels: ['Open restricted', 'Back to Agent Command Center'] },
      // No spacer rows at all: the paragraph opener ends the path block.
      long_checkout_40x13: { workspace: 'workspace/…/repository', labels: ['Trust and continue', 'Quit'] },
      long_repository_root_40x17: { workspace: 'workspace/…/repository/checkout', trustTarget: 'workspace/…/repository', labels: ['Trust and continue', 'Quit'] },
      // Only the repository root fits, so the folder row is elided and the
      // trust target stands in for the workspace.
      only_repository_root_fits_40x16: { workspace: 'workspace/…/repository', trustTarget: 'workspace/…/repository', labels: ['Trust and continue', 'Quit'] },
    }
    expect(upstream.map(snapshot => snapshot.name).sort()).toEqual(Object.keys(expected).sort())
    for (const [name, want] of Object.entries(expected)) {
      const state = detectCodexTrustDialog(frame(name))
      expect({ name, state }).toEqual({
        name,
        state: {
          visible: true,
          workspace: want.workspace,
          ...(want.trustTarget !== undefined ? { trustTarget: want.trustTarget } : {}),
          options: [{ key: '1', label: want.labels[0] }, { key: '2', label: want.labels[1] }],
          layout: 'folder-access',
          acceptKeys: '1\r',
          declineKeys: '2',
        },
      })
    }
  })

  it('ignores prose that quotes every row of the new layout', () => {
    // The same class of phantom as PROSE_FALSE_POSITIVE: an assistant pasting
    // the dialog inside a sentence or a code literal. No anchor is a whole line.
    const prose = [
      '• The new dialog says "Folder access" and offers',
      "  const ROWS = ['1. Trust and continue', '2. Quit']",
      '  with the hint enter continue · esc quit.',
    ].join('\n')
    expect(detectCodexTrustDialog(prose).visible).toBe(false)
  })

  it('ignores a verbatim copy of the dialog inside a transcript', () => {
    // Review of #67 (a and b): a pasted upstream .snap or copied terminal frame
    // satisfied every whole-line anchor and raised an answerable phantom. What
    // a copy cannot fake is position: the live composer is always below it.
    for (const name of ['renders_snapshot_for_remote_git_subdirectory', 'renders_restricted_folder']) {
      const transcript = [
        '• Here is the Codex screen I captured:',
        frame(name),
        '',
        '› Ask Codex to do anything',
        '',
        '  gpt-6-sol high · ~/project',
      ].join('\n')
      expect(detectCodexTrustDialog(transcript).visible).toBe(false)
      // And the quoted frame stays visible as assistant text.
      expect(extractCodexStreamingText(transcript)).toContain('Folder access')
    }
  })

  it('reads the Windows sandbox hint wrapped over two rows at narrow widths', () => {
    // Upstream wraps "enter continue and create sandbox · esc quit" (46 columns
    // with the inset) below 46 columns. Built from the upstream git_repo frame,
    // which carries that hint, re-wrapped the way a 40-column Paragraph does.
    const wrapped = frame('renders_snapshot_for_git_repo').replace(
      /^\s*enter continue and create sandbox · esc quit\s*$/m,
      '  enter continue and create sandbox ·\n  esc quit',
    )
    expect(wrapped).toContain('sandbox ·\n  esc quit')
    expect(detectCodexTrustDialog(wrapped).visible).toBe(true)
  })

  it('rejects an option 1 label upstream cannot paint', () => {
    expect(detectCodexTrustDialog(frame('renders_snapshot_for_git_repo').replace('1. Trust and continue', '1. Delete folder')).visible).toBe(false)
  })

  it('requires the two options to be adjacent rows', () => {
    expect(detectCodexTrustDialog(frame('renders_snapshot_for_git_repo').replace(/(1\. Trust and continue[^\n]*)\n/, '$1\n\n')).visible).toBe(false)
  })

  it('requires the key hint below the options', () => {
    expect(detectCodexTrustDialog(frame('renders_snapshot_for_git_repo').replace(/\n.*enter continue.*$/m, '')).visible).toBe(false)
  })

  it('requires the options below the Folder access anchor', () => {
    const lines = frame('renders_snapshot_for_git_repo').split('\n')
    const anchor = lines.findIndex(line => line.trim() === 'Folder access')
    const moved = [...lines.slice(anchor + 1), lines[anchor]].join('\n')
    expect(detectCodexTrustDialog(moved).visible).toBe(false)
  })

  it('rejects an option label upstream cannot paint', () => {
    expect(detectCodexTrustDialog(frame('renders_snapshot_for_git_repo').replace('2. Quit', '2. Delete folder')).visible).toBe(false)
  })

  it('rejects a hint that contradicts option 2', () => {
    // Upstream derives both from one TrustCancelAction, so "Quit" with
    // "esc back" is not a real render.
    expect(detectCodexTrustDialog(frame('renders_snapshot_for_git_repo').replace('esc quit', 'esc back')).visible).toBe(false)
  })
})

describe('keystrokes and condition actions per layout', () => {
  it('keeps the legacy layout on the legacy keys and labels', () => {
    const state = detectCodexTrustDialog(REAL_DIALOG)
    expect(state.layout).toBe('you-are-in')
    expect([state.acceptKeys, state.declineKeys]).toEqual(['1', '2'])
    expect(trustDialogModule.actions(state)).toEqual([
      { kind: 'pty', id: 'accept', label: 'Trust folder', data: '1' },
      { kind: 'pty', id: 'reject', label: 'Quit', data: '2' },
    ])
  })

  it('accepts the new layout with 1 then Enter, because 1 alone only moves the highlight there', () => {
    // rust-v0.157.1 trust_directory.rs: SELECT_FIRST sets the highlight,
    // CONFIRM (Enter) acts on it. Enter alone could confirm option 2.
    expect(CODEX_TRUST_DIALOG_FOLDER_ACCESS_ACCEPT_KEYS).toBe('1\r')
    expect(CODEX_TRUST_DIALOG_FOLDER_ACCESS_DECLINE_KEYS).toBe('2')
    const state = detectCodexTrustDialog(frame('renders_restricted_folder'))
    expect(trustDialogModule.actions(state)).toEqual([
      { kind: 'pty', id: 'accept', label: 'Open restricted', data: '1\r' },
      { kind: 'pty', id: 'reject', label: 'Back to Agent Command Center', data: '2' },
    ])
  })

  it('labels option 2 Quit when that is what the screen says', () => {
    // Both option-2 texts are live on the same binary; the Back variant alone
    // would not catch a condition that always said "Back" (review of #67 b).
    const state = detectCodexTrustDialog(frame('renders_snapshot_for_git_repo'))
    expect(trustDialogModule.actions(state).map(action => action.label)).toEqual(['Trust and continue', 'Quit'])
  })

  it('keeps blanking the streaming text for the legacy dialog', () => {
    // ScreenParser now delegates to this detector; pin the legacy side too.
    expect(extractCodexStreamingText(REAL_DIALOG)).toBe('')
  })

  it('hands every caller its own action objects', () => {
    const state = detectCodexTrustDialog(frame('renders_snapshot_for_git_repo'))
    const first = trustDialogModule.actions(state)
    first[0]!.label = 'mutated'
    expect(trustDialogModule.actions(state)[0]!.label).toBe('Trust and continue')
  })
})
