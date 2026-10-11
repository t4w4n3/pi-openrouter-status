# pi-openrouter-status

A [Pi](https://pi.dev) package that turns the footer into an OpenRouter
telemetry line and ships the OpenRouter provider-pinning / retry policy as
idempotent config snippets.

```text
~/dev/project (main)
↑3.5k ↓13 R120 $0.001 ⇢ StreamLake · fp8 ↻1 12.3%/1.0M (auto)   z-ai/glm-5.3-flash • high
```

## What it shows

The status line answers "which OpenRouter endpoint actually served this
turn?":

- **provider** — the `provider` field of OpenRouter SSE chunks (the endpoint
  really resolved, after routing/fallbacks)
- **quantization** — the endpoint tag from `/models/{id}/endpoints`
  (e.g. `fp8`, `native`)
- **retries** — assistant messages that ended in error during the current
  turn (`↻N`). Every retryable error is followed by a Pi retry, so counting
  errors counts retries; the final failure of an exhausted run is shown as
  N+1.

The provider line replaces Pi's default footer with an equivalent render
(pwd + git branch + session name, token/cost totals, context percentage,
model + thinking level, other extensions' statuses).

## What it ships

`/openrouter-pin` merges — idempotently, with a `.bak` backup and your
unrelated keys preserved — the following fragments into
`~/.pi/agent/models.json` and `~/.pi/agent/settings.json` (honoring
`PI_CODING_AGENT_DIR`):

| File | Fragment |
|---|---|
| `models.json` | `modelOverrides` for `z-ai/glm-5.3-flash`: single-endpoint bootstrap pin (StreamLake) with `allow_fallbacks: false`; session-affinity compat flags for `meta/muse-spark-1.3-contributor` |
| `settings.json` | `retry`: enabled, 4 retries, 2 s base delay, 60 s max delay |
| `settings.json` | `compaction.modelOverrides`: per-model auto-compact thresholds (see below) |

### Runtime failover policy (`provider-pin.ts`)

OpenRouter's router cannot be told to retry the same provider on a 429 —
within an `only` list it skips an unavailable endpoint instantly (verified
experimentally), so any multi-endpoint list loses the context cache on the
first rate limit. The extension therefore owns routing at the HTTP layer:

- Every GLM request is rewritten via the `before_provider_request` hook to
  carry `provider.only = [activeEndpoint]` — a single endpoint, so
  OpenRouter has nothing to fail over to.
- A 429 then surfaces to Pi's retry layer, which re-issues the same
  payload — same endpoint — with exponential backoff honoring
  `Retry-After`, up to the agent retry policy's `maxRetries` (4).
- A model request only counts as failed once its retries are exhausted
  (`message_end` with `stopReason: "error"`). After
  `FAIL_THRESHOLD` (2) consecutive failures the pin moves to the next
  endpoint (Novita); after `COOLDOWN_MS` (10 min) without failures the
  cheapest endpoint (StreamLake) is restored.

The static fragment pins StreamLake as a safe bootstrap default for
sessions where the extension is not loaded.

### Compaction tuning

Pi auto-compacts when the context exceeds `contextWindow - reserveTokens`
(default reserve: 16384 tokens) — on a 1M-token window that only triggers
near 984K tokens. `/openrouter-pin` queries the OpenRouter catalog for the
declared `context_length` of every enabled `openrouter/*` model and writes

```
reserveTokens = max(16384, contextLength - 350000)
```

so a 1M model auto-compacts at ~350K tokens while a 200K model keeps the
built-in default (compact ~184K). Overrides equal to the default are not
written. Since Pi caches settings in memory, restart Pi or run `/reload`
after the command for the thresholds to take effect.

On session start, the extension shows a one-time hint if the fragments are
not applied yet. Nothing is ever written without running the command, and a
second run is a no-op.

## Install

```sh
pi install git:github.com/t4w4n3/pi-openrouter-status@v0.1.0
```

Then run `/openrouter-pin` once inside Pi. Requires an OpenRouter model as
the active model for the status line to report anything.

## Development

[mise](https://mise.jdx.dev) is the single entrypoint for the developer
experience: tools are pinned in `mise.toml` and every gate is a task.

```sh
mise install       # provision the pinned toolchain + npm deps
mise run check     # full quality + security gate (same as pre-push)
mise run lint      # Biome at maximum strictness (lint + format + imports)
mise run typecheck # tsc --noEmit, all strict flags on
mise run test      # bun test
```

Security gates (also local, no CI):

| Task | Tool | Scope |
|---|---|---|
| `mise run sast` | Semgrep | `p/typescript` + `p/secrets`, error on findings |
| `mise run secrets` | Gitleaks | secret scan over full git history |
| `mise run vuln` | OSV-Scanner | dependency vulnerabilities (`bun.lock`) |
| `mise run scan` | Trivy | vulnerabilities, misconfigurations, secrets |

Git hooks are managed by [hk](https://hk.jdx.dev) (`hk.pkl`):

- **pre-commit** — Biome fix + re-stage, Gitleaks on the repo
- **pre-push** — the full `mise run check` gate

Enable them with:

```sh
mise exec -- hk install
```

There is deliberately no CI: everything is enforced on the developer
machine, at commit and push time (shift-left).

## License

[MIT](./LICENSE)
