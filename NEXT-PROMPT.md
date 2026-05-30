# NEXT-PROMPT

> The always-current handoff. Refresh this file at the end of every working
> session so the next session can pick up cleanly.

## Where We Stopped (2026-05-29)

**Open Chair Mesh goal — COMPLETE.** Connecting any agent chair is now a
manifest-driven, zero-core-edit operation, the mesh stays sovereign/loopback/
encrypted, and net `src/` is *lighter* than before the goal started.

Three PRs merged to `main` (squash), Node-22 Linux green at every boundary:

- `#62` (`937f44b`) — **Phase 0+1**: pluggable `RuntimeAdapter`/`AdapterRegistry`,
  `ChairManifest` (zod) + `ChairManifestLoader`, built-in adapters; supervisor
  de-hardcoded; `.gitattributes` + Node-22 Linux CI gate.
- `#63` (`dfbcad7`) — **Phase 2**: gated generic `CommandAdapter` (`command`
  kind, disabled-by-default, `KOVAEL_COMMAND_ADAPTER_ALLOW` binary allow-list +
  per-manifest `allowEnv`, array-args-no-shell); `agent_cards/*.json` for all 9
  chairs (mirror `AgentCards`, parity test-enforced); manifest-driven supervision;
  `validate-all-chairs` + vitest manifest lint (schema + registry + persona).
- `#64` (`6d75697`) — **Phase 3**: removed confirmed-dead trio
  (`BudgetTracker`/`RoutingPolicy`/`EpisodicMemory`); de-duped `readBoolean*` into
  `src/common/env-helpers.ts`; `backfillV2Columns()` idempotent (schema-version
  guard); dep audit (sdk+zod stay in `dependencies`).

**Acceptance criteria — all met.** Zero-`src`-edit 10th command chair (tested);
9 manifests; `validate:chairs` schema+registry+persona; `CommandAdapter`
disabled-by-default + allow-list (tested); security invariants intact (loopback,
token gate, AES-256-GCM envelopes, HMAC replyProof, SSRF guard, sovereignty —
no new deps); **net `src/` LOC ≤ baseline**: non-test **13214 → 12878 (−336)**,
total **23392 → 23232 (−160)**. Final suite **586/586 green on Node 22 Linux**.

## Next Action — Deferred Follow-Up (flagged for human review)

- **Split `src/services/AgentHubStore.ts` (1234 LOC)** into `schema`/`crypto`/
  `outbox`/`memory` modules behind the same public surface. **Deliberately
  deferred** from Phase 3: the net-LOC "lighter" acceptance was already met
  without it, the split *adds* LOC, and it is a high-risk extraction of
  AES-256-GCM crypto + SQLite where a subtle error could silently regress an
  encryption invariant — disproportionate for an auto-merged PR. Do it as a
  focused, human-reviewed, behavior-preserving refactor (public methods/types
  byte-identical; lean on the existing AgentHubStore encryption/outbox/memory/
  migration tests as the safety net).

## Key Facts For The Work

- Add a chair: drop `agent_cards/<id>.json` (+ a `personas/<id>.md` with matching
  `agent_id`). Built-in kind for the 3 supervised; `command` (allow-listed) or
  omit `runtime` (presence-only) for the rest. Zero `src/` edits.
- Command runtime gating is defense-in-depth: supervisor sets `enabled:false` for
  non-allow-listed binaries AND the inbox re-gates at the spawn point; elevation
  (`danger-full-access`) is gated by the resolved adapter policy + manifest
  `elevated` flag, NOT by chair id (closed a manifest-aliasing bypass).
- Env reaching a command child: `childEnv(spec)` forwards
  `KOVAEL_COMMAND_ADAPTER_ALLOW` + manifest `allowEnv` vars (secret names denied)
  to the inbox; `runCommand` then forwards `allowEnv` to the grandchild.
- WSL Linux verify (durable recipe): this WSL shell runs native Node v22 — run the
  gate directly. Archive the branch from the MAIN repo
  (`git -C /mnt/i/Kovael archive <branch>`) into a native-ext4 dir (e.g.
  `$HOME/kvgate`), then `npm ci && npm run build && npm test`. Do NOT `npm ci` in a
  worktree under `/mnt/i` (drvfs rejects npm's symlink/permission ops). Worktrees:
  create with WSL git off `origin/main` — they check out LF-clean and git works.

## Prior Follow-Ups (still open from earlier sessions)

- Dependabot PRs: #49 `ws`, #50 root `vite`, #52 root `typescript-eslint`,
  #48 spatial `vite`, #51 spatial `typescript-eslint`.
- Triage #22 (`audit(harden): deep-think pass on iters 01-08 from PR #21`).
- Keep `validate:real-runtimes` manual-only unless an operator validates local
  `nyx-codex` / `shaev` runtime CLIs.

## Useful Commands

```bash
# WSL Node-22 gate (run from a native-ext4 dir, not /mnt/i):
git -C /mnt/i/Kovael archive <branch> | (cd "$HOME/kvgate" && tar -x) && \
  (cd "$HOME/kvgate" && npm ci && npm run build && npm test)
npm run validate:chairs   # schema + registry + persona lint, then live dispatch
```
