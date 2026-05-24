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

At the 2026-05-24 post-router-split graph pass:

- The repository graph contained **1,558 nodes**, **4,007 edges**, and
  **229 communities**.
- By source-file edge count, the largest backend files were
  `src/MeshOrchestrator.ts` (**250**),
  `src/services/PersonaLoader.ts` (**123**),
  `src/MevBridge.ts` (**110**),
  `src/services/SelfHealer.ts` (**110**),
  `src/services/ConversationBus.ts` (**109**),
  `src/services/Tracing.ts` (**91**), and
  `src/services/WebSocketBus.ts` (**87**).
- `MeshOrchestrator` is again the central source-file hub. The HTTP API
  surface is still important, but it is now distributed across a dispatcher,
  shared support module, and route-specific handlers instead of one large
  file.
- The highest `MeshOrchestrator` symbol degrees were constructor (**43**),
  file node (**42**), class node (**29**), `wireMevBridge` (**17**),
  `wireWorkflowLoader` (**14**), and `loadAgentCards` (**14**).

This does not mean these files are wrong. It means changes to them have
unusually high blast radius and should be reviewed with that in mind.

## Responsibility clusters connected through `MeshOrchestrator.ts`

### HTTP API and request routing

The orchestrator constructs the HTTP server boundary, while
`HttpApiRouter.ts` now owns request dispatch, CORS preflight, health/metrics
routing, and handshake fallthrough. Shared HTTP mechanics live in
`src/services/http/HttpApiSupport.ts`, and route behavior lives in focused
modules for state, chairs, conversations, traces, and ComfyUI requests.

Relevant neighbors in the graph include:

- `HttpApiRouter.ts`
- `HttpApiSupport.ts`
- `StateRoutes.ts`
- `ChairRoutes.ts`
- `ConversationRoutes.ts`
- `TraceRoutes.ts`
- `ComfyRoutes.ts`
- `HealthEndpoints.ts`
- `ApiTokenGate.ts`
- `RateLimiter.ts`
- `SovereignProxy.ts`

Review implication: API changes should consider authentication, rate
limiting, body limits, response shape stability, and frontend consumers
together. Route additions should stay in the matching route module, with
shared mechanics kept in `HttpApiSupport.ts` only when multiple routes need
them.

### HTTP router split delta

Measured against the pre-extraction router state:

- `src/services/HttpApiRouter.ts` dropped from **599** measured lines to
  **145** measured lines.
- Its source-file graph edge count dropped from **266** to **59**.
- The split HTTP route surface now totals **291** source-file edges across
  `HttpApiRouter.ts`, `HttpApiSupport.ts`, `StateRoutes.ts`,
  `ComfyRoutes.ts`, `TraceRoutes.ts`, `ChairRoutes.ts`, and
  `ConversationRoutes.ts`.
- Each extracted route/support module is below **120** measured lines.

Interpretive note: the total HTTP route edge count is slightly higher than
the old single-file count because explicit module boundaries and imports are
now visible to Graphify. That is an acceptable tradeoff: review blast radius
moved from one router hub to small files with focused route-contract tests.

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

### Lane 1: Composition-root pressure relief

Candidate changes:

- move narrowly scoped boot wiring out of `MeshOrchestrator.ts` only when a
  cohesive service boundary already exists
- keep constructor ordering explicit because it documents dependency setup
- avoid changing event names, API paths, or persistence semantics in the same
  slice
- add focused tests around any extracted lifecycle or wiring behavior

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
has been reduced back to a dispatcher; the next high-value work is to keep
new API behavior in route modules and make future composition-root changes
small, tested, and contract-aware.
