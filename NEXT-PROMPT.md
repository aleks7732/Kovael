# NEXT-PROMPT

> The always-current handoff. Refresh this file at the end of every working
> session so the next session can pick up cleanly.

## Where We Stopped (2026-05-29)

Wave-1 ultramax goal landed: **Open Chair Mesh** — connect all agent chairs +
leave room for easy expansion; secure, lightweight, with code-bloat + quality
review baked in.

- Deep dive done. Linux verified on native Node 22 (WSL Ubuntu) via a fresh
  `git archive` of the branch: `tsc` green, **555/555 tests green**. Committed
  line endings are LF (`git ls-files --eol` → `i/lf`).
- Deliverables committed on `claude/reverent-archimedes-d14c6d`:
  - `ULTRAMAX-GOAL.md` — mission brief (NYXCODE-MISSION idiom, Commander's Intent)
  - `docs/superpowers/specs/2026-05-29-chair-mesh-expansion-design.md` — design
    spec (D3 hybrid adapter registry; manifest-driven chairs; phased 0–3)
  - `docs/superpowers/plans/2026-05-29-chair-mesh-expansion-phase-0-1.md` —
    Phase 0+1 TDD implementation plan (7 tasks, behavior-preserving)
- **Phase 0+1 IMPLEMENTED** (subagent-driven, TDD) and opened as a PR. New
  `src/services/runtime/` layer — `AdapterRegistry`, built-in adapters,
  `ChairManifest` (zod), `ChairManifestLoader`; `AgentRuntimeSupervisor`
  de-hardcoded (closed `runtime` union → registry-resolved string); orchestrator
  card-load validated. Full suite **567/567 green on Node 22 Linux** (was 555;
  +12 new). Behavior preserved for the 3 supervised chairs. **Phases 2 & 3 remain.**

## Next Action

1. Land the Phase 0+1 PR (watch the new `linux-verify` CI job + pii-guard +
   secrets-scan).
2. Author + execute the **Phase 2 plan**: the gated `CommandAdapter` (registers a
   `command` runtime kind; binary + env allow-lists; disabled by default),
   `agent_cards/*.json` manifests for all 9 chairs, and a `validate-all-chairs`
   manifest lint. Depends only on the now-frozen `RuntimeAdapter` interface.
3. Then the **Phase 3 plan**: bloat remediation (split `AgentHubStore` 1143 LOC;
   confirm+cut dead `budgetTracker`/`routingPolicy`/`episodicMemory`; de-dup
   `readBoolean`; idempotent `backfillV2Columns`; dep right-placement). Phase 3
   is where the net-`src/`-LOC-must-drop acceptance criterion is paid.

Phase-1 cleanup carried forward (minor): hoist `defaultRuntimeRegistry()` to a
module singleton; tighten `RuntimePolicy` field types to drop the `as Pick` cast.

## Key Facts For The Work

- Expansion seam exists: `MeshOrchestrator.loadAgentCards()` reads
  `agent_cards/*.json` (`src/MeshOrchestrator.ts:581`); the dir is currently absent.
- Seam to open: `src/services/AgentRuntimeSupervisor.ts` — closed `runtime`
  union (L29), literal `byId` (L707), `runtimePolicyFor` (L753),
  `runtimeExecutablePathFor` (L781).
- Bloat track (Phase 3): `AgentHubStore.ts` 1143 LOC; likely-dead
  `budgetTracker`/`routingPolicy`/`episodicMemory` (confirm via
  `OrchestratorContext` before cutting); dup `readBoolean`/`readBooleanEnv`;
  `backfillV2Columns` O(N)/boot; `@modelcontextprotocol/sdk`+`zod` dep placement.
- WSL Linux verify (durable recipe): archive the branch from the MAIN repo
  (`git -C /mnt/i/Kovael archive <branch>`), NOT the worktree (its `.git` points
  to a Windows path WSL can't resolve); set WSL `safe.directory`; pipe a base64'd
  script to avoid PowerShell eating `$vars`; always assert `cd` succeeded.

## Prior Follow-Ups (still open from last session)

- Dependabot PRs: #49 `ws`, #50 root `vite`, #52 root `typescript-eslint`,
  #48 spatial `vite`, #51 spatial `typescript-eslint`.
- Triage #22 (`audit(harden): deep-think pass on iters 01-08 from PR #21`).
- Keep `validate:real-runtimes` manual-only unless an operator validates local
  `nyx-codex` / `shaev` runtime CLIs.

## Useful Commands

```powershell
npx tsc --noEmit; npm test
node scripts/validate-pr.mjs
npm run validate:chairs
git status --short --branch
```
