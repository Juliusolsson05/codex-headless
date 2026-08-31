// codex-headless / config / ProjectTrust.ts
//
// Pre-trust a project folder ON DISK so Codex never shows its trust dialog for
// sessions this package's consumers spawn.
//
// WHY DISK WRITES INSTEAD OF DRIVING THE TUI DIALOG (agent-code#714).
// -------------------------------------------------------------------
// Synthesizing keystrokes into provider trust dialogs produced four distinct
// production failures in a single day (agent-code#705 #711 #712 #713): an
// upstream re-layout inverted an accept keystroke and killed sessions; clicks
// were refused invisibly against dead backends; a wake readiness timeout
// murdered a live CLI that was legitimately waiting on its own dialog; and the
// modal held the whole application hostage. Every one of those shares a single
// root: the dialog existing at all. The consumer's user picks the working
// directory explicitly — that choice IS the trust decision — so we record it
// where Codex itself records it, before the process ever starts:
//
//   [projects."/abs/path"]
//   trust_level = "trusted"
//
// in `$CODEX_HOME/config.toml`. Format verified against a live user config
// (a dozen organically-written entries) and against codex-rs
// (core/src/config/edit.rs `set_project_trust_level`, which owns the same
// table).
//
// WHY APPEND-ONLY, NEVER PARSE-AND-RESERIALIZE.
// ---------------------------------------------
// config.toml is a USER-OWNED file: hand-written settings, comments, ordering.
// codex-rs edits it with toml_edit precisely to preserve formatting; a JS
// parse→mutate→dump round-trip would destroy comments and reorder tables the
// first time we touched it. Appending a new `[projects."…"]` table at EOF is
// always valid TOML (a table header terminates whatever table came before it)
// and provably leaves every existing byte alone. The one shape we cannot
// safely append under is an INLINE `projects = { … }` assignment — appending a
// `[projects."x"]` header alongside it is a duplicate-key parse error that
// would stop Codex from launching at all — so that shape is detected and
// skipped (dialog fallback).
//
// WHY EXISTING ENTRIES ARE NEVER MODIFIED.
// ----------------------------------------
// A project table that already exists — whatever its trust level says — is a
// decision the user (or Codex, at their keystroke) already recorded. Upgrading
// an explicit non-trusted entry to "trusted" behind their back would turn a
// convenience into a consent bypass. Absent table = no decision yet = the
// consumer's explicit folder choice fills it in.
//
// WHY THIS NEVER THROWS.
// ----------------------
// Pre-trust is an optimization, not a gate. The trust-dialog condition, modal,
// and parser all remain as the fallback; a read-only disk, a corrupt config,
// or a future format change must degrade to "the dialog appears" — never to
// "the session cannot spawn".

import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'

import { getCodexHome } from '../transcript/ProjectDir.js'

/** `$CODEX_HOME/config.toml` — the file codex-rs reads trust from. */
export function getCodexConfigPath(): string {
  return join(getCodexHome(), 'config.toml')
}

export type CodexProjectTrustResult =
  /** The table was absent; we appended it with trust_level = "trusted". */
  | 'trusted-appended'
  /** A table for this exact path already exists — left untouched. */
  | 'already-configured'
  /** `projects` is an inline table we cannot append under — left untouched. */
  | 'skipped-inline-projects'
  /** Read/write failed; config untouched (or partially unreadable). */
  | 'skipped-error'

// TOML basic strings escape exactly backslash and double-quote; paths carry
// both on hostile input and backslashes routinely on Windows.
function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Canonicalize the way entries appear in organically-written configs: an
// absolute path with no trailing separator. Codex matches its cwd against the
// key textually, so writing the resolved form mirrors what its own writer
// produces for the same directory.
function canonicalizeProjectPath(cwd: string): string {
  const resolved = resolve(cwd)
  return resolved.length > 1 && resolved.endsWith(sep)
    ? resolved.slice(0, -1)
    : resolved
}

// Matches an `[projects."<path>"]` (or `[projects.'<path>']` / unlikely bare
// key) table header for the EXACT path, tolerating whitespace. Built per-call
// because the path is data. The escaped-regex form must match the
// escaped-TOML form we would write AND the form codex writes (identical for
// paths without quotes/backslashes; for exotic paths we only need to not
// duplicate our own writes).
function projectTableHeaderPattern(path: string): RegExp {
  const escapedForToml = escapeTomlBasicString(path)
  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^\\s*\\[\\s*projects\\s*\\.\\s*(?:"${escapeRegex(escapedForToml)}"|'${escapeRegex(path)}')\\s*\\]`,
    'm',
  )
}

// An inline `projects = { … }` (or `projects = {}`) assignment at top level.
// Appending a `[projects."x"]` header alongside one is a TOML duplicate-key
// error that would prevent Codex from starting — strictly worse than showing
// the dialog — so its presence makes us stand down entirely.
const INLINE_PROJECTS_RE = /^\s*projects\s*=/m

/**
 * Ensure `[projects."<cwd>"] trust_level = "trusted"` exists in Codex's
 * config. Append-only, idempotent, never throws — see the module header for
 * every WHY. `configPath` exists for tests; production callers use the
 * CODEX_HOME-derived default.
 */
export async function ensureCodexProjectTrust(
  cwd: string,
  options: { configPath?: string } = {},
): Promise<CodexProjectTrustResult> {
  const configPath = options.configPath ?? getCodexConfigPath()
  const projectPath = canonicalizeProjectPath(cwd)
  try {
    let existing = ''
    try {
      existing = await readFile(configPath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Anything but "file does not exist" means we cannot know what is in
      // the config; appending blind could duplicate an entry we failed to
      // read. Stand down.
      if (code !== 'ENOENT') return 'skipped-error'
      // A fresh machine may not have ~/.codex yet; codex creates it on first
      // run, and so do we for the config we are about to write.
      await mkdir(dirname(configPath), { recursive: true })
    }

    if (projectTableHeaderPattern(projectPath).test(existing)) {
      return 'already-configured'
    }
    if (INLINE_PROJECTS_RE.test(existing)) {
      return 'skipped-inline-projects'
    }

    const entry =
      `[projects."${escapeTomlBasicString(projectPath)}"]\n` +
      `trust_level = "trusted"\n`
    // Separate from prior content with exactly one blank line, matching how
    // codex's own writer (and the organic files we verified) space project
    // tables. An empty file gets the entry with no leading padding.
    const needsNewline = existing.length > 0 && !existing.endsWith('\n')
    const separator = existing.length === 0 ? '' : `${needsNewline ? '\n' : ''}\n`
    const next = existing + separator + entry

    // Atomic temp+rename so a concurrently launching Codex never reads a torn
    // config. The nonce keeps two racing sessions' temp files apart; last
    // rename wins with a complete file either way (both writers produce a
    // superset of `existing`; the loser's entry is re-appended on its next
    // spawn since ensure is idempotent).
    const tempPath = `${configPath}.agent-code-trust-${process.pid}-${Date.now()}.tmp`
    await writeFile(tempPath, next, 'utf8')
    await rename(tempPath, configPath)
    return 'trusted-appended'
  } catch {
    return 'skipped-error'
  }
}
