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
- **No `src/` code changed yet.** The plan is execution-ready.

## Next Action

Execute the Phase 0+1 plan (registry refactor + manifest validation; preserves
behavior for the 3 supervised chairs). Choose subagent-driven (recommended) or
inline (`executing-plans`). Then author the Phase 2 plan (gated `CommandAdapter`
+ all-9 `agent_cards/*.json` + `validate-all-chairs` manifest lint) and the
Phase 3 plan (bloat remediation).

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
