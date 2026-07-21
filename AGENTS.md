# AGENTS.md

Instructions for AI agents (OpenCode, Codex, Claude Code, Gemini CLI and
others) working in this repository.

## What this project is

A single-file, zero-dependency OpenCode plugin (`index.js`) that fails
over to the next configured model on 429 (rate limit) or 410 (model
retired). See [README.md](README.md) for the full design rationale and
the production incident that motivated it.

## Important rules

- **`index.js` is the entire product — keep it that way.** Don't add a
  build step, a test framework, or npm dependencies to the plugin itself
  unless there's a concrete reason — the whole point of rewriting this
  (vs. the third-party package it replaced) was to keep it small enough
  to read end-to-end in one sitting and to avoid a supply-chain surface.
  The `Makefile`/`scripts/` installer tooling is a separate concern and
  can use `python3` (stdlib only, no pip deps) freely.
- **`opencode.json` is a user-owned file, not a template — never edit it
  with `sed`/text substitution.** `scripts/register-plugin.py` uses real
  JSON parsing to merge the plugin entry in, so it doesn't clobber other
  providers/plugins/settings someone already has there. Any change to how
  install/uninstall touches that file must go through real JSON
  read-modify-write, and stay idempotent (installing twice must not
  duplicate the entry).
- **Detect failures by structured HTTP status code first, text second.**
  The bug this plugin exists to fix was a text-whitelist that didn't
  match a real provider's error body. Any new detection logic must check
  `error.data.statusCode` before falling back to string matching, and the
  string matching must stay broad (not a narrow curated phrase list).
- **Debounce by `(sessionID, modelKey)`, never `sessionID` alone.** A
  time-only debounce keyed just on session was a real production bug: a
  429 on model A switched to model B, and B's 410 arrived 4ms later — the
  debounce swallowed it because it was still "recent," leaving the
  session stuck on a dead model. Only suppress signals that are about the
  *same* failing model as the last handled one.
- **410 is permanent, 429 is not.** Don't unify their cooldown handling —
  a retired model must never re-enter rotation (`Infinity` cooldown), a
  rate-limited one must (`cooldownMs`).
- **Never mention an AI agent as contributor or committer.** Commits in
  this repository must not include trailers like `Co-Authored-By` citing
  Claude, Codex, Gemini, or any other AI agent, nor use an agent as the
  commit author/committer. Author and committer are always the person who
  requested the change.

## Consumers

Known consumer: [nvbuild-opencode](https://github.com/lichti/nvbuild-opencode)
(NVIDIA Build + OpenCode setup), which clones this repo and points
`opencode.json`'s `plugin` field at `index.js` by absolute path. Breaking
changes to the config schema (`model-fallback.json`) or the exported
plugin shape affect that project directly.
