# Chair Mesh Expansion — Phase 3 Plan (Bloat & Quality Remediation)

> Parent spec §8. Net `src/` LOC must end **≤** the pre-goal baseline
> (non-test 13214 / total 23392). Isolated commits; suite green at every step.
> Start LOC (post-Phase-2 main): non-test **13487**, total **24127** —
> must cut ≥273 non-test / ≥735 total.

## Order (isolated commits, lowest-risk first)
1. **Confirm-then-cut the dead trio.** `BudgetTracker.ts` (203) + `RoutingPolicy.ts`
   (215) + `EpisodicMemory.ts` (195) + their 3 test files. Remove imports/decls/
   construction in `MeshOrchestrator.ts` (L30-32, L136-138, L199-201). **Verified
   dead:** only constructed, never read; absent from `OrchestratorContext`; the
   `episodic_memories` table is owned by `Migrator.ts` (schema, tested) not the
   class — leave the schema alone. Keep `memoryDb` (8 other consumers). This is
   the LOC win (−613 non-test, −918 total incl. tests).
2. **De-dup `readBoolean`/`readBooleanEnv`** → `src/common/env-helpers.ts`
   (`AgentRuntimeSupervisor.ts:740`, `MeshOrchestrator.ts:861`; 4 call sites).
3. **Idempotent `backfillV2Columns()`** — guard on `agent_hub_meta.schema_version`
   (`SCHEMA_VERSION='2'`): skip the O(N) scan when already current. Add a test.
4. **Dep audit** — `@modelcontextprotocol/sdk` + `zod` are both on a production
   path (`SovereignProxy.ts`; `zod` also `runtime/ChairManifest.ts`) ⇒ keep in
   `dependencies`; document the verdict (no change).
5. **(Optional, last, highest-risk) Split `AgentHubStore.ts` (1234 LOC)** →
   `schema`/`crypto`/`outbox`/`memory` modules behind the SAME public surface
   (exported class + all public methods/types unchanged). Done only if the gate
   stays green with confidence; else defer (noted in NEXT-PROMPT) — it serves
   maintainability, not the LOC acceptance, which steps 1-3 already satisfy.

## Verification
Targeted vitest per step; full WSL Node-22 gate before PR (build 0, test 0).
Log the net LOC delta. Adversarial verify before PR. Auto-merge on green.
