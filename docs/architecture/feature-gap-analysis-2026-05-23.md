# Kovael Feature Gap Review

Date: 2026-05-23
Updated: 2026-05-24 after the HTTP router split and a fresh Graphify pass
Scope: current source tree and the MeshOrchestrator graph note

## Summary

Kovael already has a strong local-first orchestration core: chair claims,
conversation topics, Triad lifecycle, event logging, budget controls, rate
limits, AG-UI mapping, and basic tracing are all present in code and tests.

The main gap is not another feature bolted onto the orchestrator. The latest
graph map shows the HTTP router split succeeded: `src/services/HttpApiRouter.ts`
is no longer the top source-file hub. The next risk center is
`src/MeshOrchestrator.ts`, which still bridges protocol flow, service wiring,
persistence, observability, and UI event emission.

## Evidence Baseline

- The 2026-05-24 post-router-split Graphify pass produced 1,558 nodes, 4,007
  edges, and 229 communities. Top backend source-file hubs were
  `MeshOrchestrator.ts` (250 file edges), `PersonaLoader.ts` (123),
  `MevBridge.ts` (110), `SelfHealer.ts` (110), and `ConversationBus.ts` (109).
- `HttpApiRouter.ts` dropped from 599 measured lines to 145 measured lines and
  from 266 source-file graph edges to 59. The route modules under
  `src/services/http/` now hold the API surface in smaller files with
  route-contract coverage.
- Current services already cover local primitives such as `CycleLog`,
  `BudgetTracker`, `RoutingPolicy`, `EpisodicMemory`, `Tracing`, `RateLimiter`,
  `ApiTokenGate`, `TaskClaimMachine`, `ConversationBus`, `CommitteeVoting`,
  `WebSocketBus`, and `InterAgentChatManager`.
- SQLite durability is real: `OrchestratorDb` defaults to
  `.kovael/orchestrator.db` and enables WAL mode.
- The current runtime still assumes one active orchestrator process. Kubernetes
  manifests exist, but leader election, shared lease ownership, and failover are
  not implemented.
- A committee endpoint and extracted `CommitteeVoting` service exist, but there
  is still no persisted committee state machine or durable verdict table.

## Capability Matrix

| Capability | Status | Evidence and gap |
| --- | --- | --- |
| Real-time HTTP and WS orchestration | Shipped | Single-port API and WebSocket bus are wired by `MeshOrchestrator`, with routing in `HttpApiRouter` and upgrade/fanout in `WebSocketBus`. |
| Chair claim and heartbeat lifecycle | Shipped | `ChairRegistry`, claim endpoints, and tests exist. |
| Multi-agent conversations | Shipped | `ConversationBus` supports topics, deltas, mentions, and stopping criteria. |
| Triad task lifecycle | Shipped | `MevBridge`, `TaskClaimMachine`, `CycleLog`, and tests cover the local path. |
| Durable event ledger | Partial | `CycleLog` persists events; replay and cross-process determinism are not complete. |
| Distributed worker queue | Missing | No lease table, worker heartbeat plane, or dead-letter queue exists. |
| Backend committee engine | Partial | `CommitteeVoting` and `/api/v1/conversations/:id/committee` exist; verdicts are emitted and summarized, but not persisted as a committee state machine. |
| Policy-as-code guardrails | Missing | Auth and rate limits exist; route/tool/data policy evaluation does not. |
| Multi-tenant isolation | Missing | State is globally scoped; no tenant or namespace guard is present. |
| A2A trust federation | Missing | No signed agent card, JWKS, or federated inbound API exists on main. |
| Platform observability | Partial | Traces and metrics exist; SLO burn, incident state, and durable trace queries do not. |
| High availability | Missing | No leader election, follower proxying, or warm standby state handoff exists. |

## Review Priorities

1. Keep reducing hub pressure before adding new platform behavior. The next
   natural boundary is lifecycle/composition wiring around `MeshOrchestrator`,
   not more route extraction.
2. Preserve existing contracts while extracting. Existing `/api/v1/*` paths, WS
   event names, Prometheus labels, and SQLite migrations should remain additive
   unless a PR explicitly versions them.
3. Treat horizontal scaling claims as unsafe until a durable lease model and
   leader/follower behavior are implemented.
4. Add platform features behind flags that default off when they change visible
   behavior.
5. Keep docs actionable and evidence-backed. Avoid fixed test counts, copied
   DDL/API sketches, or instructions to delete code unless the code is proven
   unused by search and tests.

## Recommended Next Slice

Start with a composition-root pressure-relief PR that has zero behavior
change:

- map `MeshOrchestrator` constructor wiring into boot phases such as config,
  persistence, runtime services, buses, health, and optional integrations;
- extract only cohesive setup groups where the dependency order is already
  explicit, and keep `MeshOrchestrator` as the owner of ordering;
- add focused tests around shutdown order, event bus wiring, and lifecycle
  emission before moving code;
- do not mix this with distributed worker queues, tenant isolation, or new
  policy engines.

The router split is complete enough for now. Future API changes should use
the existing route modules and contract tests rather than growing
`HttpApiRouter.ts` again.
