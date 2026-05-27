# NEXT-PROMPT

> The always-current handoff. Refresh this file at the end of every working
> session so the next session can pick up cleanly.

## Where We Stopped

Main is current through the agent safety and access-boundary work:

- `67fe0d4` Harden per-agent SQLite hubs (#53)
- `74683c0` Refine graph cleanup and snapshot normalizers (#54)
- `f3a6750` Harden chair dispatch and outbox correctness (#55)
- `a902e41` Clean up release hygiene followups
- `f01ddd6` Guard Theater trace correlation by cycle id (#57)
- `b049509` Document manual real-runtime smoke gate (#58)
- `07b7281` Harden agent access boundaries (#59)

The repo is expected to be clean on `main` after #59. Kovael now binds to
loopback by default, protects local agent config/state from semantic ingest,
and documents SSH local forwarding as the default encrypted remote-access
posture.

## Current Follow-Up Scope

- Clear the remaining Dependabot PR queue.
- Keep `validate:real-runtimes` manual-only unless an operator is explicitly
  ready to validate local `nyx-codex` and `shaev` runtime CLIs.
- Triage issue #22 when the dependency queue is clear.

## Remaining Todo

- Run `npm run validate:real-runtimes` only when local real runtime CLIs are
  installed/configured and the operator wants that manual release gate.
- Merge or close the open Dependabot PRs:
  - #49 `ws`
  - #50 root `vite`
  - #52 root `typescript-eslint`
  - #48 spatial `vite`
  - #51 spatial `typescript-eslint`
- Triage #22: `audit(harden): deep-think pass on iters 01-08 from PR #21`.
- Add a future SQLite backup/checkpoint helper only if operators need one; docs
  already warn not to blindly copy only the main DB file during writes.
- Consider deferred architecture cleanup:
  - `codex/agent-hub-store-split-protocol-dedupe`

## Useful Commands

```powershell
git status --short --branch
npx vitest run packages/spatial-war-room/test/cockpit.spec.ts
node scripts/validate-pr.mjs
npm run validate:chairs
node scripts/real-runtime-smoke.mjs --agents nyx-codex,shaev --require-real --timeout-ms 180000
```
