# APEX Roadmap

Status: draft implementation roadmap
Date: 2026-05-23
Inputs: `docs/architecture/feature-gap-analysis-2026-05-23.md`,
`docs/architecture/mesh-orchestrator-graph-map.md`, current `main` source tree

This roadmap keeps the original APEX intent but removes generated bloat,
unverified gates, and executor-specific process rules. Each PR should be small
enough to review on its own and should leave the repo closer to a lower-coupled,
platform-ready orchestrator.

## Global Rules

- Keep `src/MeshOrchestrator.ts` from growing. If a PR touches it, it should move
  responsibility into `src/kernel/*` or `src/services/*` and leave the file the
  same size or smaller.
- Preserve existing `/api/v1/*` response shapes, WebSocket event names,
  Prometheus metric labels, and SQLite migration history unless the PR is
  explicitly a versioned contract change.
- Ship user-visible behavior behind an environment flag that defaults off.
- Keep HTTP and WebSocket traffic on the existing orchestrator port unless a
  design review approves another boundary.
- Use additive migrations only. Assign migration numbers in the PR description
  before implementation when multiple branches may run in parallel.
- Every PR that adds a durable subsystem gets an ADR or runbook explaining
  failure modes and rollback.
- Do not delete existing code as dead code unless search proves no live reads and
  the relevant tests still pass. `technicalDialogues` and `interestsDialogues`
  are currently live through `triggerInterAgentChat()`.

## PR 1: Kernel Extraction

Goal: turn `MeshOrchestrator` into a composition root without changing behavior.

Scope:

- create bounded modules for API routing, WebSocket fanout, lifecycle runtime,
  persistence boot, observability wiring, and feature flags;
- move code in small slices with contract tests after each slice;
- keep all current endpoints and WS payloads stable;
- add a state snapshot contract that exposes feature flags.

Acceptance:

- `MeshOrchestrator` line count decreases;
- existing unit and integration tests pass;
- contract tests cover `/livez`, `/readyz`, `/metrics`, `/api/v1/state`, chair
  routes, conversation routes, trace routes, and current WS event types;
- ADR: `docs/adr/0001-kernel-extraction.md`.

## PR 2: Durable Dispatch and Worker Leases

Goal: add a lease-based task queue without replacing the current task path until
the new path has soaked.

Scope:

- add queue, lease, attempt, and dead-letter tables;
- implement enqueue, claim, extend, complete, fail, reap, and stats operations;
- use SQLite transactions for state transitions;
- add worker heartbeat and boot-recovery handling;
- expose additive `/api/v1/dispatch/*` endpoints behind a flag.

Acceptance:

- duplicate enqueue and double-finalization tests pass;
- a simulated worker death is reclaimed by the reaper;
- DLQ promotion and requeue are tested;
- perf smoke shows no regression on current hot endpoints;
- ADR: `docs/adr/0002-durable-dispatcher.md`.

## PR 3: Committee Engine

Goal: make deliberation a backend primitive instead of only a cockpit affordance.

Scope:

- add a committee state machine, persisted turns, and verdict records;
- add create, inspect, verdict, and abort endpoints behind a flag;
- emit pressure-valved WS events for committee lifecycle;
- wire the cockpit drawer to backend state only when enabled.

Acceptance:

- verdicts persist with dissent and receipt links;
- endpoints return stable 404/422/200 behavior for missing, invalid, and complete
  committees;
- frontend tests cover the drawer and verdict states;
- ADR: `docs/adr/0003-committee-primitive.md`.

## PR 4: A2A Trust Fabric

Goal: expose a cryptographic trust boundary for federated peers.

Scope:

- add signed agent card and JWKS endpoints behind `KOVAEL_APEX_A2A`;
- add peer registration, inbound request records, nonce replay protection, and
  key rotation metadata;
- keep disabled behavior explicit with 404 or 503 responses;
- rate-limit public federation endpoints.

Acceptance:

- JWS verification tests cover unknown key, invalid signature, expired token,
  replayed nonce, and audience mismatch;
- key rotation keeps an overlap window and retires old keys safely;
- runbook: `docs/runbooks/apex-key-rotation.md`;
- ADR: `docs/adr/0004-a2a-trust.md`.

## PR 5: Policy Guardrails

Goal: add explainable decisions for routing, tool calls, egress, and budget
escalation.

Scope:

- implement a small JSON policy evaluator without adding a large dependency;
- load bundles atomically and log decisions with bundle and input hashes;
- add simulate and reload endpoints behind a flag;
- begin in allow mode when the flag is off.

Acceptance:

- policy precedence and malformed-bundle tests pass;
- every enabled decision point writes a decision log row;
- rollback runbook validates a known-bad bundle recovery;
- ADR: `docs/adr/0005-policy-engine.md`.

## PR 6: Tenant and Namespace Isolation

Goal: isolate state, budgets, rate limits, and API reads across namespaces.

Scope:

- add tenant and namespace tables;
- backfill existing state to `default/default`;
- scope new APIs through a namespace guard;
- keep unscoped routes mapped to default during the compatibility window.

Acceptance:

- adversarial cross-namespace reads return not found;
- backfill preserves existing data;
- default namespace behavior keeps current tests green;
- runbook: `docs/runbooks/apex-tenant-onboarding.md`;
- ADR: `docs/adr/0006-multi-tenant.md`.

## PR 7: Ops Summary and Incidents

Goal: turn current metrics into an operator-facing health summary.

Scope:

- roll up SLO burn, queue health, chair health, policy deny rates, and provider
  error rates;
- open and close incidents from deterministic rules;
- add an ops summary endpoint and cockpit route behind a flag.

Acceptance:

- incident deduplication and ack/close tests pass;
- summary endpoint meets the existing SLO budget style;
- cockpit route hides cleanly when disabled;
- ADR: `docs/adr/0007-ops-summary.md`.

## PR 8: Replay Harness

Goal: make recorded cycles reproducible enough for debugging regressions.

Scope:

- reconstruct cycle inputs from `CycleLog`;
- replay with deterministic providers;
- diff phase order, claim outcome, token use, and verifier confidence;
- add CLI and optional HTTP endpoints behind a flag.

Acceptance:

- committed fixtures replay identically;
- diff classification tests cover common divergence types;
- CLI works on Windows, Linux, and macOS;
- ADR: `docs/adr/0008-replay.md`.

## PR 9: Quality Flighting

Goal: detect routing and response-quality regressions outside normal unit tests.

Scope:

- shadow selected cycles through alternate routing;
- score outputs with a judge interface;
- store scorecards and expose trends;
- keep all flighting opt-in and sampled.

Acceptance:

- shadow traffic cannot mutate production state;
- scorecards persist and are queryable;
- a failing score threshold blocks promotion in CI or soak;
- ADR: `docs/adr/0009-quality-flighting.md`.

## PR 10: Leader Election and Follower Proxy

Goal: make horizontal deployment explicit instead of implied by Kubernetes.

Scope:

- add a leader lease and follower forwarding behavior;
- ensure only the leader mutates task and cycle state;
- expose leader status in state and metrics;
- document failover and split-brain handling.

Acceptance:

- two orchestrators never both act as leader in tests;
- follower requests proxy or reject predictably;
- failover preserves unfinished leased work;
- runbook: `docs/runbooks/apex-leader-failover.md`;
- ADR: `docs/adr/0010-leader-election.md`.

## First Implementation Slice

Start with PR 1 only. Do not begin dispatcher, committee, A2A, policy, tenancy,
ops, replay, quality, or HA work until the kernel extraction has landed and the
current contract tests are in place.
