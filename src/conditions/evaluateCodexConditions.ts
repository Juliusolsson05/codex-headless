import { makeEvaluator } from './core/evaluator.js'
import { CODEX_MODULES } from './modules.js'
import type { CodexConditionInputs, CodexConditionSnapshot } from './types.js'

// CodexConditionInputs moved to types.ts to break the module<->evaluator import
// cycle (the modules need the input type; evaluateCodexConditions imports the
// modules). Re-exported here so the historical import path
// `from './evaluateCodexConditions.js'` keeps resolving unchanged.
export type { CodexConditionInputs } from './types.js'

// evaluateCodexConditions — PURE snapshot builder, re-implemented on the generic
// evaluator while preserving the EXACT old behavior and shape.
//
// WHY a fresh evaluator per call. The old `evaluateCodexConditions` was a pure
// function with NO dedupe state — the dedupe latch lived separately inside
// `CodexHeadless.publishConditionSnapshot`. We preserve that split: this function
// only assembles a snapshot, so it spins up a throwaway evaluator and calls
// `evaluate`. The stateful `changed()` latch is used by CodexHeadless, which owns
// its own long-lived evaluator (see publishConditionSnapshot). The clock is
// `Date.now()` exactly as before.
//
// The cast on the returned snapshot: the generic evaluator yields a
// `ConditionSnapshot<'codex'>` whose `conditions` is the erased
// `Record<string, ConditionRecord>`. The Codex-typed `CodexConditionSnapshot`
// narrows that map to the per-kind union. The runtime VALUE is byte-identical;
// only the static type is narrowed, so the cast is sound and keeps the public
// return type stable for existing callers.
export function evaluateCodexConditions(
  inputs: CodexConditionInputs,
): CodexConditionSnapshot {
  const evaluator = makeEvaluator('codex', CODEX_MODULES, () => Date.now())
  return evaluator.evaluate(inputs) as CodexConditionSnapshot
}

// codexConditionSnapshotKey — UNCHANGED dedupe key. Kept exported because other
// importers (and the byte-for-byte golden) rely on it. It is identical to the
// generic evaluator's `keyOf` (JSON.stringify of the conditions map, excluding
// ts); we keep the standalone function so callers that only have a snapshot (no
// evaluator instance) can still compute the key.
export function codexConditionSnapshotKey(
  snapshot: CodexConditionSnapshot,
): string {
  return JSON.stringify(snapshot.conditions)
}
