# Preserve usage-cap reasons and request identity

Status: implemented and locally verified. Issue: #49; consumer: Juliusolsson05/agent-code#885.

The existing API error distinguishes hard usage caps from temporary throttling,
but drops the workspace reason and local proxy request ID. Preserve both as
optional metadata so consumers can present the correct remedy and deduplicate
redelivery without combining separate failed attempts.

1. Add the pinned upstream reached-type union and optional fields to API errors.
2. Allow only `x-codex-rate-limit-reached-type` in addition to the existing header
   allowlist. Validate exact known values; unknown/absent values remain unknown.
3. Forward the local flow request ID and validated reason through the HTTP
   failure adapter and semantic publisher. Preserve classifications/reset units.
4. Extend source-derived adapter fixtures for the five reasons, unknown values,
   header filtering, and equal-text requests with distinct identities. Do not
   claim these fixtures are recorded production failures.
5. Update the API reference, run `npm run check`, review, and open a complete PR
   with `Fixes #49`. The app pins the tested, published commit. Do not merge.

Source profile: openai/codex 47ca4619be10c20c1cec6ee9944738c5b961fa1d,
codex-rs/{codex-api/src/api_bridge.rs,protocol/src/protocol.rs}. No new transport,
upstream tracking headers, native transcript writes, or automatic recovery.

Verification: 16 focused HTTP-failure tests pass; `npm run check` passes
(test contract, typecheck, 212 tests, build and packed-artifact verification).
Fixtures are source-derived; no live cap was manufactured.
