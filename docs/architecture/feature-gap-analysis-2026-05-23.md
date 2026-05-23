# Kovael Feature Gap Review

Date: 2026-05-23
Scope: current main-branch source tree and the MeshOrchestrator graph note

## Summary

Kovael already has a strong local-first orchestration core: chair claims,
conversation topics, Triad lifecycle, event logging, budget controls, rate
limits, AG-UI mapping, and basic tracing are all present in code and tests.

The main gap is not another feature bolted onto the orchestrator. The graph map
shows `src/MeshOrchestrator.ts` as the highest-connectivity file, and the source
confirms it owns HTTP routing, WebSocket fanout, lifecycle wiring, persistence
boot, and observability bridges. Future work should reduce that coupling before
adding distributed platform features.

## Evidence Baseline

- `src/MeshOrchestrator.ts` is the central integration point called out by the
  graph note, with 91 graph edges and high bridge risk.
- Current services already cover local primitives such as `CycleLog`,
  `BudgetTracker`, `RoutingPolicy`, `EpisodicMemory`, `Tracing`, `RateLimiter`,
  `ApiTokenGate`, `TaskClaimMachine`, and `ConversationBus`.
- SQLite durability is real: `OrchestratorDb` defaults to
  `.kovael/orchestrator.db` and enables WAL mode.
- The current runtime still assumes one active orchestrator process. Kubernetes
  manifests exist, but leader election, shared lease ownership, and failover are
  not implemented.
- A cockpit `ConvenePanel` exists, but there is no dedicated backend committee
  service with persisted turns, verdicts, and API contracts.

## Capability Matrix

| Capability | Status | Evidence and gap |
| --- | --- | --- |
| Real-time HTTP and WS orchestration | Shipped | Single-port API and WebSocket bus are implemented in `MeshOrchestrator`. |
| Chair claim and heartbeat lifecycle | Shipped | `ChairRegistry`, claim endpoints, and tests exist. |
| Multi-agent conversations | Shipped | `ConversationBus` supports topics, deltas, mentions, and stopping criteria. |
| Triad task lifecycle | Shipped | `MevBridge`, `TaskClaimMachine`, `CycleLog`, and tests cover the local path. |
| Durable event ledger | Partial | `CycleLog` persists events; replay and cross-process determinism are not complete. |
| Distributed worker queue | Missing | No lease table, worker heartbeat plane, or dead-letter queue exists. |
| Backend committee engine | Missing | UI affordance exists, but no persisted committee state machine or verdict API. |
| Policy-as-code guardrails | Missing | Auth and rate limits exist; route/tool/data policy evaluation does not. |
| Multi-tenant isolation | Missing | State is globally scoped; no tenant or namespace guard is present. |
| A2A trust federation | Missing | No signed agent card, JWKS, or federated inbound API exists on main. |
| Platform observability | Partial | Traces and metrics exist; SLO burn, incident state, and durable trace queries do not. |
| High availability | Missing | No leader election, follower proxying, or warm standby state handoff exists. |

## Review Priorities

1. Extract bounded surfaces from `MeshOrchestrator` before adding new platform
   behavior. API routing, WS fanout, runtime lifecycle, persistence, and
   observability are the natural first boundaries.
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

Start with a kernel extraction PR that has zero behavior change:

- move HTTP routing into a small API surface module;
- move WebSocket upgrade and broadcast into a bus surface module;
- move persistence boot and migration wiring into a persistence surface;
- move tracing, metrics, and log fanout into an observability surface;
- keep `MeshOrchestrator` as the composition root;
- add contract tests for current state, chair, conversation, trace, health,
  readiness, metrics, and WebSocket event payloads.

Do not delete `technicalDialogues` or `interestsDialogues` as part of that
slice. They are still read by `triggerInterAgentChat()` and should only be
removed if the inter-agent chat feature is deliberately removed or replaced.
