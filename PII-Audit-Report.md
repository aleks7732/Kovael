# PII & Secret Audit Report: Kovael Sovereign Agentic Mesh

**Date:** 2026-05-18
**Auditor:** Nyx (Codebase Investigator)
**Status:** REDACTED — see local audit notes for full strings.

---

## 1. Summary of Findings
The audit of the `VantagePoint` workspace identified multiple instances of Personally Identifiable Information (PII) and hardcoded secrets. **The literal values have been removed from this public document** as part of the May 2026 public-repo hardening pass; they are tracked in the gitignored `.kovael-forbidden-patterns.txt` and in the GitHub repository variable `PII_FORBIDDEN_PATTERNS` consumed by the `pii-guard` workflow.

### High-Risk Exposure Categories
*   **Personal Identity:** Owner full name and LLC details — formerly in `state/owner.json`.
*   **Email Address:** Owner email — formerly in `state/owner.json`, `README.md`.
*   **Hardware Identifiers:** MAC address for the operator workstation — formerly in `scripts/devices.json`.
*   **Plaintext Secrets:** Third-party API tokens — formerly in configuration JSONs.
*   **Communication IDs:** Telegram messenger ID — formerly in `scripts/nyx_telegram_config.json`.
*   **Environmental Leakage:** Operator's Windows user path — present across automation scripts.

---

## 2. Forbidden Pattern Catalog (categories only)

The concrete strings are stored out-of-band:

* CI: GitHub repo variable `PII_FORBIDDEN_PATTERNS` (pipe-delimited regex alternation)
* Pre-commit: contributor's local `.kovael-forbidden-patterns.txt` (gitignored)

| Category | Pattern type | Detection layer |
|---|---|---|
| Identity | Full name string match | Pre-commit + CI |
| Email | RFC 5322 address localpart match | Pre-commit + CI |
| Hardware | IEEE 802 MAC address (`AA:BB:CC:DD:EE:FF`) | Pre-commit + CI (generic fallback covers this even without admin config) |
| Communication | Numeric Telegram ID | Pre-commit + CI |
| Local Paths | `C:\Users\<name>\` path prefix | Pre-commit + CI (generic fallback covers this) |
| Vendor secrets | DynDNS-style tokens, third-party API keys | TruffleHog `--only-verified` |

---

## 3. Recommended Redaction Workflow
1.  **Templating:** Replace hardcoded paths with environment variable placeholders (e.g., `${VPC_ROOT}`).
2.  **Vaulting:** Move tokens and IDs to a secret vault and retrieve them at runtime.
3.  **Owner Scrub:** The `state/` directory is `.gitignore`'d; any sanitized copy ships as `.example`.
4.  **Layered Detection:** Three-Layer Defense per `Kovael-Security-Audit.md` §3 — pre-commit, PII Guard CI, TruffleHog CI.

---

**Action:** All forbidden patterns are now enforced by `.github/workflows/pii-guard.yml`. Configure
`PII_FORBIDDEN_PATTERNS` in repository variables before the first PR; the workflow falls back to a
generic email + MAC + Windows-path regex if the variable is missing so the guard never silently
passes.
