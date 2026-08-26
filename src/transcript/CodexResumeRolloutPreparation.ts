declare const resumeRolloutPreparationBrand: unique symbol

/**
 * Public rollback authority returned by `prepareCodexResumeRollout`.
 *
 * WHY this file contains only the public type and compatibility re-export:
 * emitted deep modules are importable in the packaged runtime. The ownership
 * controller, WeakMap, and sole consumer therefore live together inside the
 * CodexHeadless module closure; putting an unwrapper here would recreate the
 * tenth-gate privacy and lease-mutation failure.
 */
export interface CodexResumeRolloutPreparation {
  readonly [resumeRolloutPreparationBrand]: never
  dispose(clean?: boolean): Promise<void>
}

// Preserve the historical deep import of the public factory without exporting
// any path from a public handle back to its runtime-private controller.
export { prepareCodexResumeRollout } from '../CodexHeadless.js'
