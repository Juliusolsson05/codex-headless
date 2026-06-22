import type { ConditionModule } from './core/contract.js'
import { approvalModule } from './approval.js'
import { trustDialogModule } from './trustDialog.js'
import type { CodexConditionInputs } from './types.js'

// CODEX_MODULES — the ordered registry the generic evaluator loops over.
//
// ORDER IS A WIRE CONTRACT, NOT A STYLE CHOICE.
// The evaluator inserts each live module's record into a plain object in THIS
// array's order, and the dedupe key is `JSON.stringify(conditions)`, which
// serializes object keys in insertion order. The legacy `evaluateCodexConditions`
// inserted trust-dialog BEFORE approval. So trust MUST stay first and approval
// second here: reordering them would change the serialized key for any snapshot
// where both are live, which the dedupe latch would see as a spurious change.
//
// `codex.switch-model-prompt` is intentionally ABSENT: it's a typed condition
// kind with no headless detector today (it was never emitted by
// evaluateCodexConditions — only the type exists for a future builder). Adding a
// detector now would change behavior; the migration is byte-for-byte, so we
// leave it out exactly as the old path left it out.
//
// `readonly` + `as const`: the order is load-bearing, so we freeze it at the type
// level. The `ConditionModule<string, CodexConditionInputs, any>` element type is
// the erased form the evaluator routes over (it reads only `kind` and calls
// `actions`); each module's concrete state type is preserved at its definition
// site, erased only here where heterogeneity is unavoidable.
export const CODEX_MODULES: readonly ConditionModule<
  string,
  CodexConditionInputs,
  any
>[] = [trustDialogModule, approvalModule] as const
