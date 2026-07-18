import { rm } from 'node:fs/promises'

// WHY every build starts from an empty artifact directory: TypeScript never
// removes outputs for renamed or reclassified tests. Without this boundary a
// local npm pack can ship stale test files even though a clean CI checkout is
// correct, which makes package verification depend on workstation history.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })

