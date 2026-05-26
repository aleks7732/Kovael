# Kovael

> Sovereign Agentic Mesh: a Node 22 + TypeScript command core for
> coordinating local and cloud agent runtimes in real time.

[![CI](https://github.com/aleks7732/Kovael/actions/workflows/ci.yml/badge.svg)](https://github.com/aleks7732/Kovael/actions/workflows/ci.yml)
[![PII guard](https://github.com/aleks7732/Kovael/actions/workflows/pii-guard.yml/badge.svg)](https://github.com/aleks7732/Kovael/actions/workflows/pii-guard.yml)
[![TruffleHog](https://github.com/aleks7732/Kovael/actions/workflows/secrets-scan.yml/badge.svg)](https://github.com/aleks7732/Kovael/actions/workflows/secrets-scan.yml)

Kovael is a single-port orchestrator for a heterogeneous fleet of agent
"chairs": Claude Code, Gemini/Antigravity, Codex, ADK, JetBrains
Cowork, and a local Hermes-hosted persona. It exposes HTTP, WebSocket,
and SSE surfaces, persists orchestration state in SQLite, and ships with
a React cockpit for live mesh visibility.

```text
 ┌─ Spatial War Room cockpit (Vite, :5173) ──────────┐
 │ Canvas, roster, mission console, theater, traces  │
 └──────────────┬───────────────────────┬────────────┘
                │ WebSocket frames      │ HTTP /api/v1/*
 ┌──────────────┴───────────────────────┴────────────┐
 │ MeshOrchestrator (:8080)                           │
 │                                                    │
 │ ChairRegistry       ConversationBus   MevBridge    │
 │ HttpApiRouter       WebSocketBus      MevHandshake │
 │ WorkflowLoader      PersonaLoader     CycleLog     │
 │ BudgetTracker       RoutingPolicy     RetryQueue   │
 │ Reconciler          HardwareMonitor   Tracing      │
 │ ComfyUiBridge       SelfHealer        Learning     │
 │                                                    │
 │ SQLite: chairs, conversation history, cycle ledger │
 └──────────────┬─────────────────────────────────────┘
                │ Chair Beacon claim / heartbeat
 ┌──────────────┴─────────────────────────────────────┐
 │ 9 canonical chairs, 9 persona files, one protocol  │
 └────────────────────────────────────────────────────┘
```

## Current Capabilities

- **Chair Beacon Protocol** - agents claim, heartbeat, release, and
  reply over `/api/v1/chairs/*`; presence is surfaced to the cockpit in
  near real time. See [docs/CHAIRS.md](./docs/CHAIRS.md).
- **Conversation Theater** - topics, threaded history, `@mention`
  routing, streaming deltas, committee votes, and verifier-backed
  stopping signals.
- **Triad execution** - every injected goal moves through architect,
  operator, and verifier phases, with exactly-once task claiming and
  structured verification receipts.
- **Routing controls** - VRAM gating, retry queue, reconciliation,
  circuit breakers, rate-limit tracking, and Thompson-sampling routing
  policy are wired into the composition root.
- **Trace and telemetry surfaces** - OpenTelemetry GenAI spans are kept
  in a bounded in-memory ring buffer and can be exported over OTLP when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Adaptive resource mode** - the server stays in the normal active
  profile while UI/API/WS traffic or task work is present, then shifts to
  a lightweight idle profile that pauses hardware polling and trims
  replay buffers.
- **Local agent lifecycle** - optional supervised inbox adapters start
  with the orchestrator and stop on orchestrator shutdown or idle parking.
  Each adapter owns a local SQLite hub file for durable per-agent inbox,
  reply, idempotency, and memory rows; the orchestrator remains the
  source of truth for chairs, topics, and routing.
- **ComfyUI bridge** - portrait/render requests can be routed to ComfyUI
  when enabled, with deterministic SVG fallback behavior for local
  development and tests.
- **Hot-loaded configuration** - workflow and persona documents are
  loaded from `WORKFLOW.md` and `personas/*.md`; inter-agent banter
  prompts live in [config/banter-dialogues.json](./config/banter-dialogues.json).
- **Operational hygiene** - JSON logging, health probes, Prometheus
  metrics, bearer-token gates, CORS preflight, body-size limits, and
  WebSocket auth/rate limiting are covered by tests.

## Run Locally

Requires Node 22+.

```bash
npm install
npm run build
npm start
```

The orchestrator listens on port `8080` by default when started through
`dist/boot-mesh.js`.

Start the cockpit in a second shell:

```bash
npm run showcase
# or
npm run dev --workspace=packages/spatial-war-room
```

The cockpit development server listens on Vite's default port, normally
`5173`.

Adaptive resource mode is enabled by default. Chair heartbeat traffic and
health probes do not keep the server active, so long-lived agents can stay
claimed without preventing idle trimming. Useful overrides:

| Variable | Default | Purpose |
|---|---:|---|
| `KOVAEL_RESOURCE_MODE_ENABLED` | `true` | Set `false` to disable adaptive idle mode |
| `KOVAEL_RESOURCE_IDLE_AFTER_MS` | `600000` | Quiet window before the server enters idle mode |
| `KOVAEL_RESOURCE_SWEEP_INTERVAL_MS` | `5000` | How often the idle guard checks for inactivity |
| `KOVAEL_RESOURCE_IDLE_TASK_RETAIN` | `20` | Task replay entries retained after idle trimming |
| `KOVAEL_RESOURCE_IDLE_TRACE_RETAIN` | `20` | Trace entries retained after idle trimming |

Local agent runtime supervision is opt-in. When enabled, Kovael starts
the local loopback inbox adapters for `shaev` and `nyx-codex` by default,
passes each adapter a persistent `agent-hub.sqlite`, and releases the
chairs cleanly when the orchestrator stops. Idle resource mode can also
park supervised adapters and restart them on active use. `nyx-openclaw` is
intentionally not part of the default supervised set because it uses the
elevated `codex-openclaw` runtime profile.

| Variable | Default | Purpose |
|---|---:|---|
| `KOVAEL_AGENT_RUNTIMES_ENABLED` | `false` | Start supervised local agent inbox adapters with the orchestrator |
| `KOVAEL_AGENT_RUNTIME_IDS` | `shaev,nyx-codex` | Comma-separated supervised agent IDs; unknown IDs are ignored |
| `KOVAEL_AGENT_HUB_DIR` | OS app data | Directory for per-agent `agent-hub.sqlite` files; default is outside the workspace |
| `KOVAEL_AGENT_RUNTIMES_PARK_ON_IDLE` | `true` | Stop supervised adapters when resource mode enters idle; restart on active use |
| `KOVAEL_API_TOKEN` | unset | Bearer-token gate for `/api/v1/*`, `/metrics`, and authenticated WebSocket upgrades; forwarded to supervised adapters as `KOVAEL_TOKEN` |
| `KOVAEL_CHAIR_DISPATCH_SECRET` | unset | Enables encrypted chair dispatch/reply envelopes; use at least 32 characters |
| `KOVAEL_ALLOW_CHAIR_FALLBACKS` | `false` | Allows chair smoke validation to tolerate local fallback paths; strict live dispatch is the default |
| `KOVAEL_RETAIN_SMOKE_ARTIFACTS` | unset | Set to `always` to retain sanitized all-chair smoke artifacts under `.notes/chair-smoke/<timestamp>/`; failures are retained automatically |
| `KOVAEL_AGENT_HUB_SECRET` | unset | Enables agent hub field encryption; required for app-managed runtimes and should be at least 32 characters |
| `KOVAEL_AGENT_HUB_ENCRYPTION` | optional | Set to `required` for manual adapters that must refuse plaintext hub storage |

Agent hub files are local edge logs, not distributed sources of truth.
They can be backed up, pruned, or rebuilt without corrupting global
orchestrator state. Do not put hub files on a network filesystem, shared
replica volume, or cloud-synced directory. Do not build distributed
replication around per-agent hubs; the orchestrator remains authoritative
for chairs, topics, conversation history, and routing. Managed runtimes
require hub encryption, and the default hub directory is outside the
workspace. SQLite WAL sidecars (`-wal` and `-shm`) are runtime files and
must stay on local disk with the main hub database. See
[docs/runbooks/agent-hub-lifecycle.md](./docs/runbooks/agent-hub-lifecycle.md)
for operator setup and validation.

Claim a chair from another shell:

```bash
node scripts/kovael-chair.mjs \
  --id nyx-claude-code \
  --provider "Anthropic · Claude Code CLI" \
  --capabilities filesystem,git,bash,agents
```

## API Surfaces

Probe endpoints are intentionally ungated so Kubernetes can call them:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/livez` | Liveness probe |
| `GET` | `/readyz` | Readiness probe |
| `GET` | `/metrics` | Prometheus metrics; token-gated when `KOVAEL_API_TOKEN` is set |

Dispatch observability emits sanitized `chair_dispatch_started`,
`chair_dispatch_attempt`, `chair_dispatch_accepted`,
`chair_dispatch_receipt`, `chair_dispatch_success`, and
`chair_dispatch_failure` events. These include request/session IDs,
attempt counts, and latency fields where available, but not raw prompts,
messages, replies, bearer headers, full inbox URL paths, or reply proof
secrets. `/metrics` exposes `kovael_chair_dispatch_attempts_total`,
`kovael_chair_dispatch_retries_total`,
`kovael_chair_dispatch_accepted_total`,
`kovael_chair_dispatch_success_total`,
`kovael_chair_dispatch_failures_total`, and
`kovael_chair_dispatch_inflight`.

Primary HTTP API:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/state` | Mesh state snapshot |
| `GET` | `/api/v1/chairs` or `/api/v1/chairs/snapshot` | Chair roster snapshot |
| `POST` | `/api/v1/chairs/claim` | Claim or refresh a runtime chair |
| `POST` | `/api/v1/chairs/heartbeat` | Heartbeat an existing chair session |
| `POST` | `/api/v1/chairs/release` | Release a chair session |
| `POST` | `/api/v1/chairs/reply` | Deliver an async chair reply |
| `POST` | `/api/v1/conversations` | Create a conversation topic |
| `POST` | `/api/v1/conversations/:id/message` | Post a user message and trigger convene |
| `POST` | `/api/v1/conversations/:id/committee` | Run committee voting for a topic |
| `POST` | `/api/v1/conversations/:id/close` | Close a topic |
| `GET` | `/api/v1/conversations/:id/history` | Read topic history |
| `GET` | `/api/v1/traces` | List bounded cycle traces |
| `GET` | `/api/v1/traces/:cycleId` | Read one cycle trace |
| `POST` | `/api/v1/traces/reroute` | Broadcast a trace reroute request |
| `POST` | `/api/v1/comfy/render` or `/api/v1/comfy/mix` | Render a portrait or LoRA mix |
| `POST` | `/api/v1/comfy/stream-url` | Build a ComfyUI stream descriptor |

Additional realtime surfaces:

- WebSocket upgrade on the orchestrator port for mesh events and
  telemetry.
- `GET /mev/handshake` SSE for blueprint validation events.

## The Nine Chairs

Provider strings match [src/AgentCards.ts](./src/AgentCards.ts). Use
them verbatim when claiming a chair.

| Chair | Provider | Tier | VRAM |
|---|---|---:|---|
| `shaev` | VantagePoint Local · Hermes 3 | 3 | 24 GB |
| `nyx-antigravity` | Google · Gemini 3 Pro (Antigravity IDE) | 1 | 32 GB |
| `nyx-claude-code` | Anthropic · Claude Code CLI | 1 | cloud |
| `nyx-cli` | Anthropic · Gemini CLI (legacy alias) | 1 | 8 GB |
| `nyx-agcli` | Google · Antigravity CLI | 1 | cloud |
| `nyx-adk` | Google · Agent Development Kit (Python) | 2 | cloud |
| `nyx-codex` | OpenAI · Codex CLI | 2 | cloud |
| `nyx-openclaw` | OpenAI · Codex (elevated sandbox) | 2 | 16 GB |
| `nyx-cw` | JetBrains · Junie / Cowork plugin | 2 | cloud |

Each chair has a persona document under [personas/](./personas) and
portraits under [packages/spatial-war-room/public/agents/](./packages/spatial-war-room/public/agents/).

## Architecture Notes

- [src/MeshOrchestrator.ts](./src/MeshOrchestrator.ts) is the
  composition root. It wires the HTTP router, WebSocket bus, chair
  registry, workflow/persona loaders, tracing, cycle ledger, routing,
  retry, reconciliation, and hardware monitors.
- [src/services/HttpApiRouter.ts](./src/services/HttpApiRouter.ts)
  owns HTTP routing, CORS preflight, JSON body parsing, body limits, and
  JSON responses.
- [src/services/WebSocketBus.ts](./src/services/WebSocketBus.ts) owns
  upgrade auth, message-size limits, rate limiting, and event broadcast.
- [src/MevBridge.ts](./src/MevBridge.ts) owns the triad pipeline and is
  wired through post-construction setters by the composition root.
- [src/services/ConversationBus.ts](./src/services/ConversationBus.ts)
  owns topics, history, convene loops, and committee delegation through
  [src/services/CommitteeVoting.ts](./src/services/CommitteeVoting.ts).
- [src/services/Tracing.ts](./src/services/Tracing.ts) wraps the OTel
  SDK, while [TraceRingBuffer](./src/services/TraceRingBuffer.ts) and
  [TraceSanitizers](./src/services/TraceSanitizers.ts) keep trace
  storage bounded and sanitized.
- [src/services/ResourceGovernor.ts](./src/services/ResourceGovernor.ts)
  owns active/idle resource transitions for the server.
- [src/services/AgentRuntimeSupervisor.ts](./src/services/AgentRuntimeSupervisor.ts)
  owns opt-in local inbox adapter lifecycles, including idle parking and
  non-destructive stop/start behavior.
- [src/services/AgentHubStore.ts](./src/services/AgentHubStore.ts)
  owns the per-agent SQLite hub schema used for local dispatch durability,
  idempotency, reply receipts, and memory rows.
- [packages/spatial-war-room/](./packages/spatial-war-room/) is the
  React 19 cockpit: Vite 8, Tailwind 4, xyflow 12, Zustand 5, and
  lucide-react.

## Container And Kubernetes

Build and run the orchestrator image:

```bash
docker build -t kovael:latest .
docker run --rm -p 8080:8080 --init kovael:latest
```

The Dockerfile builds TypeScript in a Node 22 builder stage, prunes
development dependencies, and runs on a pinned distroless Node 22
runtime as the `nonroot` user. The cockpit is excluded from the
orchestrator image by `.dockerignore` and should be built/static-hosted
separately.

Supervised local agent runtimes are disabled in container and Kubernetes
defaults. Enable `KOVAEL_AGENT_RUNTIMES_ENABLED` there only after adding a
writable local hub volume, the adapter/runtime binaries needed by the
selected agents, and secret injection for `KOVAEL_API_TOKEN`,
`KOVAEL_CHAIR_DISPATCH_SECRET`, and `KOVAEL_AGENT_HUB_SECRET`. Managed
runtimes require hub encryption. The default Kubernetes deployment is two
replicas; per-agent hubs are local edge logs, not distributed replication
state.

Kubernetes manifests live under [deploy/k8s/](./deploy/k8s/):

- `deployment.yaml` - two replicas by default, rolling update, non-root
  user, read-only root filesystem, dropped Linux capabilities, and
  `/livez`/`/readyz` probes.
- `service.yaml` - `ClusterIP` service on port `8080`.
- `hpa.yaml` - horizontal autoscaling for the orchestrator deployment.
- `pdb.yaml` - disruption budget for rolling maintenance.

Daemon-free checks are available for the image and manifests:

```bash
node scripts/lint-dockerfile.mjs
node scripts/lint-k8s-manifests.mjs
```

## Verification

Fast local gates:

```bash
npx tsc --noEmit
npm test
npm run typecheck --workspace=packages/spatial-war-room
npm run typecheck:tests --workspace=packages/spatial-war-room
npm run build --workspace=packages/spatial-war-room
```

Full PR gate:

```bash
npm run validate:pr
```

`validate-pr.mjs` runs the root build, root Vitest suite, cockpit
typechecks, cockpit build, strict all-chair validation, and a changed-file
high-confidence secret scan. The chair smoke fails on fallback dispatch by
default; set `KOVAEL_ALLOW_CHAIR_FALLBACKS=true` only for an intentional
fallback-tolerant run.

Use the package alias for the all-chair dispatch validation:

```bash
npm run validate:chairs
```

The repository currently has 52 Vitest files across the orchestrator and
cockpit, with more than 400 individual `it(...)` cases.

## Security Posture

Kovael defaults to a localhost-oriented trust posture. Do not expose the
orchestrator directly to the public internet. Put it behind an
authenticating reverse proxy and set `KOVAEL_API_TOKEN` for bearer-token
protection on `/api/v1/*`, `/metrics`, and authenticated WebSocket
upgrades.

HTTP hardening currently includes:

- `headersTimeout: 12s`
- `requestTimeout: 30s`
- `keepAliveTimeout: 10s`
- `OPTIONS` preflight before auth/rate limiting
- default JSON body limit of 16 KiB, with route-specific overrides
- structured `400`, `413`, `429`, and `401` responses

PII and secret hygiene are enforced through pre-commit configuration,
the PII Guard workflow, TruffleHog workflow, and the changed-file secret
scan inside `scripts/validate-pr.mjs`. See [SECURITY.md](./SECURITY.md)
for reporting and setup details.

Runtime secrets are operator-managed. Use `KOVAEL_API_TOKEN` for the HTTP
and WebSocket gate, `KOVAEL_CHAIR_DISPATCH_SECRET` for encrypted chair
dispatch/reply envelopes, and `KOVAEL_AGENT_HUB_SECRET` for active hub
field encryption. Never commit these values or bake them into the Docker
image.

## Documentation

- [WORKFLOW.md](./WORKFLOW.md) - triad contract, routing config, budget,
  retry, and workflow policy.
- [docs/CHAIRS.md](./docs/CHAIRS.md) - Chair Beacon Protocol and
  per-runtime claim recipes.
- [docs/architecture/](./docs/architecture/) - architecture maps and
  feature-gap analysis.
- [docs/perf/](./docs/perf/) - performance baseline and SLO notes.
- [docs/runbooks/](./docs/runbooks/) - operational verification
  runbooks.
- [docs/runbooks/agent-hub-lifecycle.md](./docs/runbooks/agent-hub-lifecycle.md) -
  app-managed local runtime and per-agent hub operations.
- [SECURITY.md](./SECURITY.md) - security policy and PII guard setup.
- [CONTRIBUTING.md](./CONTRIBUTING.md) - contribution guidelines.

Historical execution briefs remain under [docs/briefs/](./docs/briefs/)
and [docs/prs/](./docs/prs/). They are kept as project history, not as
the current implementation status.

## License

[MIT](./LICENSE)
