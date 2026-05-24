# Kovael Feature Gap Review

Date: 2026-05-23
Updated: 2026-05-24 after Stage-6 splits and a fresh Graphify pass
Scope: current source tree and the MeshOrchestrator graph note

## Summary

Kovael already has a strong local-first orchestration core: chair claims,
conversation topics, Triad lifecycle, event logging, budget controls, rate
limits, AG-UI mapping, and basic tracing are all present in code and tests.

The main gap is not another feature bolted onto the orchestrator. The current
graph map shows two high-risk hubs: `src/services/HttpApiRouter.ts` by
source-file edge count and `src/MeshOrchestrator.ts` as the composition root.
Future work should reduce those two hubs before adding distributed platform
features.

## Evidence Baseline

- The 2026-05-24 Graphify pass produced 1,480 nodes, 3,998 edges, and 224
  communities. Top source-file hubs were `HttpApiRouter.ts` (266 file edges)
  and `MeshOrchestrator.ts` (257 file edges).
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

1. Reduce the two current hubs before adding new platform behavior. The next
   natural boundaries are route-specific modules under `HttpApiRouter` and
   further lifecycle wiring cleanup inside `MeshOrchestrator`.
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

Start with a router-focused extraction PR that has zero behavior change:

- move chair, conversation, trace, and Comfy route handlers out of
  `HttpApiRouter.ts` one at a time;
- keep shared `readJsonBody`, `writeJson`, CORS, auth, and rate-limit behavior
  in one audited place;
- keep `MeshOrchestrator` as the composition root;
- add or preserve route-contract tests for state, chair, conversation,
  committee, trace, Comfy, health, readiness, metrics, and WebSocket payloads.

Do not inline or delete `config/banter-dialogues.json` as part of that slice.
It is the runtime data source for `InterAgentChatManager`.
