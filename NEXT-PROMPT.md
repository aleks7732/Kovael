# NEXT-PROMPT

> The always-current handoff. Refresh this file at the end of every working
> session so the next session can pick up cleanly.

## Where We Stopped

Main is current through the chair dispatch correctness work:

- `67fe0d4` Harden per-agent SQLite hubs (#53)
- `74683c0` Refine graph cleanup and snapshot normalizers (#54)
- `f3a6750` Harden chair dispatch and outbox correctness (#55)

The repo was clean on `main` before starting this follow-up branch:

- Branch: `codex/release-hygiene-followups`
- Purpose: clear small release-hygiene leftovers after #55

## Current Follow-Up Scope

- Refresh this stale handoff file so it no longer points at merged PRs.
- Remove the Node `[DEP0190]` warning caused by `spawn(..., { shell: true })`
  in the spatial war-room cockpit smoke test.
- Validate the focused cockpit test and the normal PR gate before merging.

## Remaining Todo

- Decide whether real-runtime smoke for `nyx-codex` and `shaev` should become
  a documented manual release gate, separate from CI-safe fake-deterministic
  adapter validation.
- Add a future SQLite backup/checkpoint helper if operators need one; docs warn
  not to blindly copy only the main DB file during writes.
- Consider deferred architecture cleanup PRs:
  - `codex/theater-trace-correlation`
  - `codex/agent-hub-store-split-protocol-dedupe`

## Useful Commands

```powershell
git status --short --branch
npx vitest run packages/spatial-war-room/test/cockpit.spec.ts
node scripts/validate-pr.mjs
npm run validate:chairs
node scripts/real-runtime-smoke.mjs --agents nyx-codex,shaev --require-real --timeout-ms 180000
```
