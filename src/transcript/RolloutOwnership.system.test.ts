import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)

async function runLegacyOwnershipCheck(script: string): Promise<string> {
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', script], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
  })
  return stdout
}

describe('rollout ownership decisions', () => {
  it('accepts only a fresh rollout that belongs to the submitted prompt', async () => {
    // WHY this is a subprocess instead of a module import: the accepted
    // deterministic checks predate Vitest and execute at module scope.
    // Isolating process.exit keeps one failure scoped to this named behavior
    // while ensuring the normal test command finally owns the check.
    await expect(
      runLegacyOwnershipCheck('scripts/test-fresh-rollout-claim.ts'),
    ).resolves.toContain('test-fresh-rollout-claim passed')
  })

  it('accepts a resumed rollout only when its lineage proves ownership', async () => {
    await expect(
      runLegacyOwnershipCheck('scripts/test-resume-fork-candidate.ts'),
    ).resolves.toContain('test-resume-fork-candidate passed')
  })
})
