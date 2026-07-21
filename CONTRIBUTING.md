# Contributing to codex-headless

Thanks for considering a contribution. This is a small, fast-moving
package — the bar is "does it make the control layer better," not
process for its own sake.

## Prerequisites

- **Node.js 20+**
- The **`codex` CLI** installed and on your `PATH` — the package drives
  the real binary, so you need it to do anything useful.

The optional Responses proxy is a plain local HTTP server — it has no
external dependency (unlike the mitmproxy used by the sibling
`claude-code-headless` package). Codex natively supports a custom
`openai_base_url`, which is all the proxy relies on.

## Setup

```bash
git clone https://github.com/Juliusolsson05/codex-headless.git
cd codex-headless
npm install
npm run build
```

`npm run build` runs `tsc`. `npm run check` is the full gate CI runs:
test contract, typecheck, tests, and a packaged-artifact check.

## Branch workflow

- Branch off `main`. Name branches by intent: `fix/...`, `feat/...`,
  `chore/...`, `docs/...`.
- Keep a branch to one concern. Coupled changes belong in one branch;
  unrelated changes do not.
- Open a PR against `main`. Don't merge your own PR without review.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`. Types in use: `feat`, `fix`, `chore`, `docs`,
`refactor`. Keep the summary imperative and short; put the *why* in the
body.

## Code conventions

- **TypeScript, strict, ESM.** Relative imports use explicit `.js`
  extensions.
- **Thick "why" comments.** Explain *why* the code is shaped the way it
  is — the constraint that forced it, the alternative that failed, the
  invariant that must hold. Don't explain *what* the code does; reading
  it does that.
- **Parsers stay pure.** Files under `src/parsers/` are pure functions on
  plain data — no I/O, no Node APIs, no DOM.
- **The consumer owns the PTY.** The library never spawns or kills
  processes. Keep it that way.
- **Mirror `claude-code-headless` where the providers genuinely agree.**
  Divergence should be driven by real Codex behaviour (the rollout
  stream, the conditions system, the plain-HTTP proxy), not by drift.

## Testing

`npm run check` is the gate — it runs the test contract, `tsc --noEmit`,
the vitest suites, and a packaged-artifact check. Individual projects:
`npm run test:core`, `npm run test:system`, `npm run test:live`.

(An older record/replay harness lived in `src/testing/`; it was removed
as never fully thought through and is preserved on the
`archive/testing-harness` branch. Don't resurrect it without reading why
it went.)

For wire-shape work, capture against a real `codex` session using Agent
Code's recorder — `src/main/recording/` plus
`scripts/extract-rendering-recordings.mjs` in the agent-code repo — and
describe in the PR exactly what you exercised. This package used to ship
its own Electron debugger app for that; it was removed once the app's
recorder became the capture path for every provider, and pulling a
~100 MB Electron binary into three CI install jobs to serve one local
tool stopped being worth it. Reach for the app's recorder, not a second
capture stack here.

## Reporting bugs

Open an issue with: what happened, exact reproduction steps, the commit
SHA you saw it on, and verbatim error output. Over-share — every omitted
detail is a round trip.

Security issues do **not** go in public issues — see
[`SECURITY.md`](SECURITY.md).
