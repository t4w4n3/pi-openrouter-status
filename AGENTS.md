# AGENTS.md

Project guidance for coding agents working in this repository.

## Tasks (mise)

Run tasks with `mise run <task>`:

| Task | Description |
|---|---|
| `check` | Full quality + security gate (same as pre-push hook) |
| `check-fast` | Fast gate used by the pre-commit hook |
| `install` | Provision pinned tools and npm dependencies |
| `lint` | Biome check at maximum strictness (lint + format + import order) |
| `lint:fix` | Auto-fix lint and formatting issues |
| `sast` | Semgrep SAST: TypeScript rules + secret patterns |
| `scan` | Trivy scan: vulnerabilities, misconfigurations, secrets |
| `secrets` | Gitleaks secret scan over full git history |
| `test` | Run unit tests with `bun test` |
| `typecheck` | TypeScript strict check (no emit) |
| `vuln` | OSV-Scanner dependency vulnerability scan (bun.lock) |

Quality gates to satisfy before committing: `mise run check-fast`; before
pushing: `mise run check` (tests, typecheck, lint, SAST, secret and
vulnerability scans).
