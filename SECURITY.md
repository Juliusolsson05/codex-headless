# Security Policy

`codex-headless` drives the real `codex` CLI and, optionally, routes its
API traffic through a local process. Both have real security
implications. Read this before you embed the package.

## Threat model — what this package does

### It runs an autonomous agent

The package spawns the real `codex` binary in a pseudo-terminal. Codex is
an autonomous coding agent: depending on its approval and sandbox
settings it can read and write files, run shell commands, and make
network requests. `codex-headless` does **not** add a sandbox. The
security posture of a session is exactly the posture of the `codex` CLI
you launched, with whatever settings you gave it.

If you auto-answer approval prompts (the conditions system makes this
easy), you are auto-approving real shell commands. Treat the working
directory and the host accordingly.

### The Responses proxy routes your API traffic through a local process

The optional `ResponsesProxy` is a **plain HTTP server bound to
`127.0.0.1`** on a random port. It is **not** a TLS man-in-the-middle:
there is no CA certificate and no change to system trust. It works
because Codex natively supports a custom `openai_base_url` — Codex is
simply pointed at the local server.

While the proxy is in use:

- Codex's traffic to the OpenAI / ChatGPT backend passes through it —
  prompts, responses, and Codex's own `Authorization` bearer token. The
  proxy **forwards that token to the real upstream untouched**; it does
  not inject, store, or need credentials of its own.
- The server listens only on loopback. **Do not bind it elsewhere.**
  Anything that can reach the port can see the traffic.
- For `chatgpt` auth mode the proxy reads `~/.codex/auth.json` — only
  the `auth_mode` field — to choose the correct upstream.
- The proxy can optionally mirror traffic to an on-disk JSONL file
  (`eventsFile`). That mirror **deliberately excludes the
  `Authorization` header** so a leaked bundle cannot expose bearer
  tokens — but it **does** record request bodies (your prompts, base64,
  capped at 2 MiB) and response bytes. Treat that file as sensitive.

The proxy is **opt-in**. If you don't construct it, no interception
happens — Codex talks to the upstream directly and the package observes
via the rollout file alone.

### Rollout transcripts contain conversation data

The package reads Codex's rollout JSONL from `~/.codex/sessions/`. These
hold full conversation history — anything you or the agent put in
context. Handle whatever you surface from the `committed` channel with
that in mind.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's private vulnerability reporting — "Report a
vulnerability" under the repository's **Security** tab — or by direct
contact with the maintainer. Include a description, reproduction steps,
and impact. You will get an acknowledgement and a fix timeline.

## Scope

**In scope:** this package's own code — process spawning, the Responses
proxy, the parsers, the conditions system, transcript handling.

**Out of scope:** vulnerabilities in the `codex` CLI itself (report
those to OpenAI), in `node-pty`, or in other dependencies — report those
upstream.
