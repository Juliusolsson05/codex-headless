import { createHash } from 'node:crypto'

const PROVIDER_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Privacy-transform a Codex thread/session UUID while preserving equality.
 *
 * The proxy sees the UUID inside x-codex-window-id before a rollout exists;
 * the ownership coordinator later sees the same UUID inside session_meta.
 * A stable domain-separated digest is the smallest evidence that can join
 * those sources without retaining or exporting the upstream identifier.
 */
export function fingerprintProviderSession(value: unknown): string | null {
  if (typeof value !== 'string' || !PROVIDER_SESSION_UUID.test(value)) return null
  return createHash('sha256')
    .update('agent-code:codex-provider-session:v1\0')
    .update(value.toLowerCase())
    .digest('hex')
}
