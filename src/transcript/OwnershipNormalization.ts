import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Canonicalize paths used as rollout-ownership identity inputs.
 *
 * WHY preparation and live tailing share this helper: a prepared resume joins
 * the process-wide coordinator before Codex is spawned, while CodexHeadless
 * later consumes the same coordinator after spawn. If either side canonicalizes
 * `/var` versus `/private/var`, case, or `..` differently, the preparation
 * appears to protect one root/CWD while the live consumer silently joins a
 * second identity graph.
 */
export function normalizeRolloutOwnershipPath(value: string): string {
  try {
    return realpathSync.native(value)
  } catch {
    return resolve(value)
  }
}
