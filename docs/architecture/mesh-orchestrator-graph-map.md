# MeshOrchestrator graph map

## Purpose

This note records the graph-guided architecture read for `MeshOrchestrator.ts`. It is meant to help reviewers and future contributors understand why this file behaves as the repository's central coordination point before making further security, scaling, API, or UI changes.

The current map was refreshed on 2026-05-24 with:

```bash
npx -y @nodesify/graphify run .
```

That run writes local cache/output under `.graphify/` (`graph.json`,
`graph_report.md`, `db.sqlite`). The directory is intentionally ignored by
git; use the command above to regenerate it.

## Graph snapshot

At the 2026-05-24 graph pass:

- The repository graph contained **1,480 nodes**, **3,998 edges**, and
  **224 communities**.
- By source-file edge count, the largest backend files were
  `src/services/HttpApiRouter.ts` (**266**),
  `src/MeshOrchestrator.ts` (**257**),
  `src/MevBridge.ts` (**110**),
  `src/services/ConversationBus.ts` (**109**),
  `src/services/Tracing.ts` (**91**), and
  `src/services/WebSocketBus.ts` (**88**).
- `MeshOrchestrator` remains the central composition root, but it is no
  longer the only obvious pressure point. The HTTP router is now the top
  source-file hub after the routing split.
- The highest `MeshOrchestrator` symbol degrees were constructor (**46**),
  file node (**42**), `injectTask` (**37**), class node (**29**), and
  `wireMevBridge` (**17**).

This does not mean these files are wrong. It means changes to them have
unusually high blast radius and should be reviewed with that in mind.

## Responsibility clusters connected through `MeshOrchestrator.ts`

### HTTP API and request routing

The orchestrator constructs the HTTP server boundary, while
`HttpApiRouter.ts` now owns request dispatch, CORS preflight, body parsing,
JSON responses, health/metrics routing, chair APIs, conversations, traces,
ComfyUI requests, and handshake fallthrough.

Relevant neighbors in the graph include:

- `HttpApiRouter.ts`
- `HealthEndpoints.ts`
- `ApiTokenGate.ts`
- `RateLimiter.ts`
- `SovereignProxy.ts`
- `handleStateSnapshot`
- `handleChairRequest`
- `handleConversationRequest`
- `handleTracesRequest`

Review implication: API changes should consider authentication, rate
limiting, body limits, response shape stability, and frontend consumers
together. Because `HttpApiRouter.ts` is now the top source-file hub,
route additions should be split or tested locally rather than packed into
one large method.

### WebSocket lifecycle and event fanout

The orchestrator constructs the WebSocket bus, while `WebSocketBus.ts`
owns upgrade auth, rate limiting, cached event replay, telemetry
normalization, and broadcast fanout.

Relevant neighbors include:

- `ApiTokenGate.ts`
- `WebSocketAuthOutcome`
- `WebSocketAuthSource`
- `.broadcast()`
- `useWarRoomStore`
- `PhaseFeed`
- `AgentRosterPanel`
- `ClaimsStrip`

Review implication: changing event names, event order, or payload shape
can break both backend E2E tests and the spatial war-room UI.
Event-contract changes should include tests and, where possible,
documented expected ordering.

### Mission lifecycle and claim state

The orchestrator bridges mission injection, task claims, lifecycle phases, verification receipts, token accounting, and claim release.

Relevant neighbors include:

- `TaskClaimMachine.ts`
- `TriadStateMachine.ts`
- `ChairRegistry.ts`
- `CycleLog.ts`
- `RetryQueue.ts`
- `BudgetTracker.ts`
- `RateLimitTracker.ts`
- `integration.e2e.test.ts`

Review implication: lifecycle work should be tested end-to-end. It is easy for a locally reasonable ordering change to race the WebSocket stream or make UI state appear inconsistent.

### Persistence and operational state

The orchestrator reaches persistence and migration surfaces for runtime state.

Relevant neighbors include:

- `OrchestratorDb.ts`
- `Migrator.ts`
- `CycleLog.ts`
- `EpisodicMemory.ts`
- `FileSink.ts`

Review implication: deployment changes, replica counts, or clustering claims should be checked against the current persistence model. Local SQLite and in-memory state require different operational guarantees than a horizontally scalable shared store.

### Observability and diagnostics

The orchestrator is also a bridge to logs, traces, metrics, and event streams.

Relevant neighbors include:

- `Logger.ts`
- `Tracing.ts`
- `AgUiEventStream.ts`
- `Reconciler.ts`
- `SemanticIngestor.ts`

Review implication: new operational features should preserve enough diagnostics to debug claim contention, retry behavior, auth failures, and frontend stream issues without leaking credentials or private payloads.

### Frontend state consumers

The graph connects the orchestrator to the spatial war-room through the store and display components.

Relevant neighbors include:

- `useWarRoomStore`
- `SpatialWarRoom.tsx`
- `PhaseFeed`
- `MissionBriefPanel`
- `CycleInspector`
- `StatusLegend`
- `AgentRosterPanel`

Review implication: UI/UX changes should be traced back to the event contract. If a UI panel needs clearer state, prefer adding explicit derived state or documented event semantics rather than making every component infer lifecycle meaning independently.

## Review checklist for future PRs touching `MeshOrchestrator.ts`

Use this checklist for any PR that modifies `src/MeshOrchestrator.ts` or the event/API surfaces it owns.

### Scope

- [ ] Is the PR narrowly scoped, or is it mixing API, lifecycle, persistence, and UI behavior?
- [ ] Does the PR description identify which responsibility cluster is being changed?
- [ ] Are unrelated refactors split into a separate PR?

### Contract safety

- [ ] Are HTTP response status codes and JSON shapes preserved or deliberately documented?
- [ ] Are WebSocket event names and payload shapes preserved or deliberately documented?
- [ ] Are event ordering assumptions covered by tests?
- [ ] Are frontend store consumers checked for compatibility?

### Security and abuse resistance

- [ ] Are authenticated routes still gated by `ApiTokenGate` where expected?
- [ ] Are unauthenticated surfaces limited to health/readiness paths intended for infrastructure probes?
- [ ] Are request body limits, rate limits, and WebSocket admission behavior considered?
- [ ] Are tokens or query credentials scrubbed before they can leak into logs or downstream handlers?

### Runtime and deployment safety

- [ ] Does the change assume single-instance state, or does it require a shared store/leader model?
- [ ] Are persistence writes and migrations compatible with the current storage backend?
- [ ] Does the change behave correctly when retries, claim contention, or chair disconnects occur?

### Observability

- [ ] Does the change emit enough structured information for debugging without leaking secrets?
- [ ] Are metrics, traces, or logs updated if the operational behavior changes?
- [ ] Can failures be distinguished between auth, rate limit, malformed input, lifecycle race, and backend exception?

### Testing

- [ ] Is there a targeted unit test for the changed service or state machine?
- [ ] Is there an E2E test when the change crosses HTTP, WebSocket, and lifecycle state?
- [ ] If the change affects the spatial war-room, did the relevant frontend test run?
- [ ] If the change affects deployment assumptions, is the runbook or manifest updated?

## Recommended PR lanes from the graph

The graph suggests splitting future work into independent lanes instead of
re-expanding the orchestrator or growing the router into a second
composition root.

### Lane 1: API router decomposition

Candidate changes:

- split chair, conversation, trace, and Comfy handlers into focused modules
- keep `readJsonBody` and `writeJson` shared and tested
- preserve `/api/v1/*` response shapes while moving code
- add route-level tests before moving each handler

### Lane 2: WebSocket contract clarity

Candidate changes:

- document event names and payload shapes
- test expected lifecycle event order
- clarify auth failure close codes and token scrubbing behavior
- add UI-facing event contract notes for store maintainers

### Lane 3: Deployment safety

Candidate changes:

- document single-writer assumptions
- align Kubernetes replica guidance with SQLite/local-memory state
- add explicit warnings/runbook guidance before enabling horizontal replicas

### Lane 4: UI state readability

Candidate changes:

- derive mission lifecycle state in `useWarRoomStore`
- reduce per-component lifecycle inference
- make phase, claim, receipt, and token status easier to visualize

## Bottom line

`MeshOrchestrator.ts` is still the project bridge between protocol,
runtime, persistence, observability, and UI event flow. `HttpApiRouter.ts`
is now the largest source-file hub and deserves the same caution.
Future work should either keep changes extremely narrow or extract
responsibility into services with clear tests and documented contracts.
