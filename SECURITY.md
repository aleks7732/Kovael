# Security Policy

## Supported Versions

The following versions of Kovael are currently being supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of Kovael seriously. If you believe you have found a security vulnerability, please report it to us by following these steps:

1. **Do not** open a public GitHub issue.
2. Email your report to `security@example.com` (Placeholder).
3. Include a detailed description of the vulnerability, steps to reproduce, and potential impact.

We will acknowledge receipt of your report within 48 hours and provide a timeline for resolution.

---

## PII-Guard (public repo invariant)

This repository ships three coordinated defenses against accidentally committing PII or secrets — the Three-Layer Defense documented in `Kovael-Security-Audit.md` §3.

| Layer | Tool | Where it runs | When it fires |
|---|---|---|---|
| 1 | `pre-commit` (`.pre-commit-config.yaml`) | contributor's machine | on `git commit` |
| 2 | `pii-guard.yml` workflow | GitHub Actions | every PR + every push to `main` |
| 3 | `secrets-scan.yml` workflow (TruffleHog `--only-verified`) | GitHub Actions | every PR + every push to `main` + weekly cron |

### One-time setup for maintainers

1. **GitHub repository variable.** In repository **Settings → Secrets and variables → Actions → Variables (not Secrets)**, create:

   - Name: `PII_FORBIDDEN_PATTERNS`
   - Value: a pipe-delimited regex alternation of the strings that must never appear in this repo (full names, owner email, hardware MAC, communication IDs, etc.).

   The `pii-guard.yml` workflow falls back to a generic email + MAC + Windows-path regex when this variable is unset, so the guard is never silently disabled — but the admin-configured list is the high-signal layer.

2. **Branch protection.** Require the `Scan diff for forbidden strings` and `TruffleHog verified scan` checks on PRs into `main`.

3. **CODEOWNERS** (`.github/CODEOWNERS`) routes the security-critical surfaces (`SECURITY.md`, `PII-Audit-Report.md`, `WORKFLOW.md`, `.github/`) to the Chair for explicit review.

### One-time setup for contributors

```sh
# Install the hook runner
pip install pre-commit
pre-commit install

# Create your local forbidden-patterns file (gitignored)
touch .kovael-forbidden-patterns.txt
# Populate it from a private channel — never commit this file.
# Format: one regex per line; blank lines and '#' comments allowed.
```

If `.kovael-forbidden-patterns.txt` is missing, the pre-commit hook still runs the generic fallback (email + MAC), so basic protection is always on.

### Why patterns are not in source

The "forbidden strings" are themselves PII. Committing them to a public workflow file or pre-commit config would leak the very identifiers the guard is designed to protect. Both layers therefore read the pattern list from out-of-band sources (GitHub repository variable + gitignored local file) and fall back to a category-level regex when no list is present.

---

## Trust & Safety Posture

Per OpenAI Symphony SPEC.md §10.1, every consumer must document its trust and safety posture explicitly.

* **Subprocess isolation:** The Kovael Triad runs in-process (Architect / Operator / Verifier are TypeScript functions inside the `MeshOrchestrator`). There is no `child_process` sandbox separating agent roles. Operators must treat the orchestrator's host machine as inside the trust boundary.
* **Workspace isolation:** Per-cycle workspace directories (`WorkspaceManager`, planned) provide path-level isolation but do not impose a security sandbox.
* **External traffic:** All external network access is mediated through `SovereignProxy.ts` (MCP server) with PII sanitization. No agent has direct outbound network access.
* **Approval policy:** No operator confirmation gate today. A `hooks.before_run` hook (planned, per Symphony §10.1) will give operators a vetoing checkpoint before any cycle dispatches.

## Acknowledgements

Symphony attributions: this repository adopts patterns from [openai/symphony](https://github.com/openai/symphony) under Apache-2.0.
