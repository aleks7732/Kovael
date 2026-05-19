# Kovael Security Audit: GitHub Public Repository Standards (May 2026)

## 1. Push Protection & PII Redaction Best Practices
As of May 2026, GitHub has transitioned **Push Protection** from a feature to a mandatory baseline for all public repositories. The standard has shifted from "detect and notify" to "block and verify."

### Push Protection Excellence
*   **Zero-Trust Scaffolding:** Enable **Push Protection by Default** at the account level. In 2026, this includes AI-powered detection for high-entropy "generic" secrets that lack specific provider patterns.
*   **Inherited Fork Protection:** Ensure all forks inherit the security settings of the parent repository. This prevents "leak-by-forking," where a contributor's personal fork lacks the protection enforced on the main repo.
*   **Repo-Level Exemptions:** Utilize the new (May 2026) **Repository-Level Exemptions** to allow specific CI/CD bots or service accounts to push encrypted payloads without global organization-level bypasses.
*   **Live Validity Checks:** Configure your security overview to prioritize "Active" secrets. GitHub now performs real-time pings to providers (AWS, GCP, npm, Cloudflare) to confirm if a leaked key is live.

### PII Redaction Strategy: The Three-Layer Defense
1.  **Local Layer (Shift-Left):** Use AI-integrated pre-commit hooks (see Section 3) to mask PII (SSNs, emails, phone numbers) before staging.
2.  **In-Flight Layer (Proxying):** For repos interacting with AI APIs, use an **LLM Security Proxy** (e.g., Grepture) to mask PII in outbound prompts.
3.  **Repository Layer (GitHub Actions):** Implement the **PII-filter** action on all Pull Requests to scan descriptions, comments, and commit messages—not just the code.

---

## 2. New Tools & Actions (Released April/May 2026)
These tools represent the "bleeding edge" of security automation for your high-profile repos.

*   **GitHub MCP Server (GA May 5, 2026):** 
    *   *Function:* Moves secret scanning into the **Model Context Protocol** layer.
    *   *Impact:* Allows AI coding agents (like Gemini CLI or Copilot) to scan generated code for secrets *before* the agent writes the file to disk.
*   **PII-filter GitHub Action (Released April 2, 2026):**
    *   *Function:* Native masking plugin for the GitHub Actions environment.
    *   *Impact:* Automatically redacts sensitive data in workflow logs and PR artifacts.
*   **OpenAI Privacy Filter (Released April 22, 2026):**
    *   *Function:* A locally runnable, lightweight LLM specifically trained for PII detection.
    *   *Impact:* Provides high-accuracy redaction without sending data to a third-party scanning service.
*   **Deterministic Dependency Locking (May 2026 Update):**
    *   *Function:* New `dependencies:` YAML block in GitHub Actions.
    *   *Impact:* Forces Actions to lock to specific commit SHAs, preventing supply-chain attacks from "shadow updates" to trusted actions.

---

## 3. Recommended Pre-commit Hook Configurations
For 2026, I recommend a **Hybrid Approach**. Use `detect-secrets` for developer speed and `TruffleHog` for the CI/CD "Final Gate."

### The "Speed" Hook: `detect-secrets` (Local)
**Why:** It is millisecond-fast and uses a `.secrets.baseline` file to ignore existing legacy secrets, preventing developer friction.

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.5.0 # 2026 Stable
    hooks:
      - id: detect-secrets
        args: ['--baseline', '.secrets.baseline']
        exclude: 'package.json|tests/'
```

### The "Deep Audit" Hook: `TruffleHog` (CI/CD)
**Why:** TruffleHog's verification engine pings providers to see if keys are *actually* valid. This eliminates false positives but is too slow for local hooks.

```yaml
# .github/workflows/security-audit.yml
jobs:
  trufflehog:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: TruffleHog OSS
        uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: ${{ github.event.repository.default_branch }}
          head: HEAD
          extra_args: --only-verified # Crucial for 2026 signal-to-noise
```

---

## 4. Tactical Implementation Checklist
- [ ] **Enable "Push Protection for Users"** in your personal GitHub Security settings.
- [ ] **Rotate immediately:** If Push Protection blocks a commit, consider that secret "burned" even if you bypass the block with an exemption.
- [ ] **Audit `CODEOWNERS`:** Ensure every `.env.example` or `config.yaml` requires mandatory review from the Security Team.
- [ ] **Deploy the MCP Server:** If using AI agents for development, enforce the `github-mcp-server` protocol to catch secrets at the prompt level.

**Audit Completed:** May 18, 2026
**Prepared by:** Nyx
