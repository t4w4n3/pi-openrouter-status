# pi-openrouter-status

A [Pi](https://pi.dev) package that turns the footer into an OpenRouter
telemetry line. Its only job is the status line: it writes no config,
registers no command, and touches no request payload.

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

## Install

```sh
pi install git:github.com/t4w4n3/pi-openrouter-status@v0.3.0
```

Requires an OpenRouter model as the active model for the status line to
report anything.

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
