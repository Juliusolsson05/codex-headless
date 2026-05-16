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

`npm run build` runs `tsc`. `npm run debugger` launches a standalone
Electron app for inspecting a live or recorded session.

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

There is currently no committed test suite. A record/replay harness used
to live in `src/testing/`; it was removed because it was never fully
thought through, and is preserved on the `archive/testing-harness`
branch. A considered test setup is planned.

Until then, verify changes by hand against a real `codex` session — the
`npm run debugger` app is the fastest way to do that — and describe in
the PR exactly what you exercised.

## Reporting bugs

Open an issue with: what happened, exact reproduction steps, the commit
SHA you saw it on, and verbatim error output. Over-share — every omitted
detail is a round trip.

Security issues do **not** go in public issues — see
[`SECURITY.md`](SECURITY.md).
