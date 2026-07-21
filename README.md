# lichti-opencode-model-fallback

An [OpenCode](https://opencode.ai) plugin that automatically switches to
the next configured model when the current one is rate limited (429) or
permanently retired by the provider (410) — instead of leaving the
session stuck retrying (or silently dead) on a model that will never
respond.

## Why this was created

This plugin exists because of a real production failure, not a
hypothetical one. We were running [OpenCode](https://opencode.ai) against
[NVIDIA Build](https://build.nvidia.com)'s hosted model catalog, which
caps usage at 40 requests/minute **per model**. The fix seemed obvious:
rotate across several models and let a plugin fail over automatically
whenever one gets rate limited.

We first used the third-party
[`opencode-rate-limit`](https://www.npmjs.com/package/opencode-rate-limit)
package for that. In production it never switched models — the session
just sat there retrying the same model forever. The root cause, found by
reading its actual compiled source (not just its README, which itself
turned out to document a config field name that doesn't match OpenCode's
real schema): its `session.status` `"retry"` handler only recognizes
messages containing `"usage limit"` / `"rate limit"` /
`"high concurrency"` / `"reduce concurrency"`. NVIDIA Build's actual 429
error body reads `"Too Many Requests"` — a string that never matches that
hardcoded whitelist, so the plugin silently never intervened while the
underlying request kept retrying forever with exponential backoff,
invisible to the user. A follow-up incident made it worse: one of the
fallback models reached end-of-life and started returning `410 Gone`,
which isn't even a "retry" event in OpenCode's model — a text-matching
plugin built only around retry messages had no chance of catching it at
all.

So this plugin was written from scratch to fix the actual failure mode:
detect errors by their **structured HTTP status code**, not by matching
free text against a curated phrase list, and treat "temporarily rate
limited" and "permanently retired" as the genuinely different failure
classes they are.

## What it does

Concretely, it distinguishes two failure classes that need very
different handling:

- **429 Too Many Requests** — retryable. The model cools down for
  `cooldownMs` and becomes eligible again afterwards.
- **410 Gone** — the model was permanently retired by the provider (this
  happens: hosted model catalogs deprecate models over time). Not
  retryable, so OpenCode never emits a `"retry"` event for it — it's a
  terminal error on the message. The model is removed from rotation for
  good (for the life of the process), not just cooled down.

It's a single file, zero npm dependencies, and logs every switch to
`~/.opencode/model-fallback-plugin.log` — the plugin it replaces logged
only to the process's stdout/console, never to OpenCode's own log file,
which made the original bug almost impossible to diagnose.

## Install

Add it to `opencode.json`'s `plugin` array (note: singular `"plugin"`,
matching OpenCode's real config schema — some docs/READMEs in this
ecosystem say `"plugins"`, which is wrong):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/index.js"]
}
```

OpenCode loads local plugin files by path — this isn't published to npm
on purpose, since a Bun-managed npm install added no value here versus a
plain file. Clone this repo somewhere stable and point `plugin` at
`index.js` with an absolute path (a relative path resolves against
whatever directory OpenCode happens to be launched from, which breaks the
moment you use OpenCode in a different project).

## Configure

Create `~/.opencode/model-fallback.json` (or a `model-fallback.json` in
the OpenCode project directory):

```json
{
  "enabled": true,
  "cooldownMs": 60000,
  "fallbackModels": [
    { "providerID": "nvidia", "modelID": "z-ai/glm-5.2" },
    { "providerID": "nvidia", "modelID": "deepseek-ai/deepseek-v4-pro" },
    { "providerID": "nvidia", "modelID": "moonshotai/kimi-k2.6" }
  ]
}
```

- `enabled`: set `false` to disable the plugin without removing it.
- `cooldownMs`: how long a rate-limited (429) model stays excluded from
  rotation before becoming eligible again. Retired (410) models never
  come back regardless of this value.
- `fallbackModels`: the rotation pool, in priority order. On failure, the
  plugin picks the next model in the list (cycling) that isn't currently
  on cooldown.

## How it works

On a qualifying failure event (`message.part.updated` retry part,
`message.updated` terminal error, `session.error`, or `session.status`
retry), the plugin:

1. Resolves the model that just failed.
2. Marks it unavailable — cooldown for 429, permanent for 410.
3. Picks the next available model from `fallbackModels`.
4. Resends the session's last user message
   (`client.session.promptAsync`) with the new model, then aborts the
   stuck request (`client.session.abort`).

This happens **within the same OpenCode session** — the conversation
history lives server-side keyed by session ID, not in the request body,
so switching models mid-session doesn't lose context. Only the last user
turn is resent (the one whose response failed); everything before it is
already part of the session OpenCode assembles into context for whatever
model handles the next turn.

A short per-session debounce prevents duplicate events about the *same*
underlying failure (e.g. both `session.error` and `message.updated` firing
for one error) from triggering two fallback attempts — but it's keyed on
`(sessionID, modelKey)`, not `sessionID` alone. Debouncing on `sessionID`
alone was an actual production bug here: a 429 on model A switched to
model B, and B's 410 arrived 4ms later — a naive time-only debounce
swallowed it, leaving the session stuck on the dead model B.

## Troubleshooting

Tail the log:

```bash
tail -f ~/.opencode/model-fallback-plugin.log
```

If a model in `fallbackModels` starts returning 410/404 consistently,
the diagnosis is "the provider retired this model," not a plugin bug —
remove it from the list.

## License

MIT
