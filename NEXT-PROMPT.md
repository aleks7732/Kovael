# NEXT-PROMPT

> The always-current handoff. Refresh this file at the end of every working
> session so the next session can pick up cleanly.

## Where We Stopped

SQLite hub hardening is implemented on `codex/sqlite-hub-hardening`.

The branch hardens app-managed agent hubs and runtime boundaries:

- adapter env allowlisting and runtime child `KOVAEL_*` secret stripping
- shared runtime redaction and safe failure messages
- mandatory hub encryption for managed runtimes
- encrypted/redacted hub payloads, replies, receipts, memory, and failures
- local-only hub path validation with UNC/cloud-sync rejection
- default managed hub storage outside the workspace
- WAL/SHM sidecar gitignore and docs validation

Fresh verification evidence from this session:

- `npx tsc --noEmit`
- targeted hardening tests: `49 passed | 2 skipped`
- `node scripts/validate-pr.mjs`: full repo validation passed, `515 passed | 4 skipped`
- secure adapter smoke with 32+ char secrets: all 9 fake-deterministic adapters claimed, decrypted, dispatched, replied, and persisted hub success

## Outstanding Todo

- Create and merge the SQLite hub hardening PR from `codex/sqlite-hub-hardening`.
- Keep the unrelated graph/cockpit cleanup out of the SQLite PR:
  - `.graphifyignore`
  - `packages/spatial-war-room/src/store/useWarRoomStore.ts`
  - `packages/spatial-war-room/test/store/useWarRoomStore.spec.ts`
  - `packages/spatial-war-room/src/store/snapshotNormalizers.ts`
  - `packages/spatial-war-room/src/store/snapshotTypes.ts`
  - `packages/spatial-war-room/test/store/snapshotNormalizers.spec.ts`
- Open a separate graph/cockpit cleanup PR for the store snapshot normalizer split and graph ignore improvements.
- Investigate the Node `[DEP0190]` test warning about `shell: true` in child process usage and remove it where safe.
- Decide whether real-runtime smoke for `nyx-codex` and `shaev` should become a documented manual release gate, separate from CI-safe fake-deterministic adapter validation.
- Add a future SQLite backup/checkpoint helper if operators need one; docs now warn not to blindly copy only the main DB file during writes.

## Files In Flight

SQLite hardening files expected in the PR:

- `.gitignore`
- `README.md`
- `docs/CHAIRS.md`
- `docs/runbooks/agent-hub-lifecycle.md`
- `scripts/kovael-agent-inbox.mjs`
- `scripts/real-runtime-smoke.mjs`
- `scripts/validate-all-chairs.mjs`
- `scripts/validate-pr.mjs`
- `src/services/RuntimeSecurity.ts`
- `src/services/SqlitePathSecurity.ts`
- `src/services/AgentHubStore.ts`
- `src/services/AgentRuntimeSupervisor.ts`
- `src/services/ModelProvider.ts`
- `src/__tests__/AgentHubStore.test.ts`
- `src/__tests__/AgentInboxScript.test.ts`
- `src/__tests__/AgentRuntimeRoutes.test.ts`
- `src/__tests__/AgentRuntimeSupervisor.test.ts`
- `NEXT-PROMPT.md`

Unrelated cockpit/graph files remain dirty and should be handled separately.

## Resume Command

Start with `git status --short --branch`, confirm the SQLite hardening PR state,
then either continue PR review fixes or branch/worktree off for the graph/cockpit
cleanup PR.
