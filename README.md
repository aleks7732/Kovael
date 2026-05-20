# Kovael

> The Sovereign Agentic Mesh — a single command core for orchestrating
> cloud and local agents in real time.

[![CI](https://github.com/aleks7732/Kovael/actions/workflows/ci.yml/badge.svg)](https://github.com/aleks7732/Kovael/actions/workflows/ci.yml)
[![PII guard](https://github.com/aleks7732/Kovael/actions/workflows/pii-guard.yml/badge.svg)](https://github.com/aleks7732/Kovael/actions/workflows/pii-guard.yml)
[![TruffleHog](https://github.com/aleks7732/Kovael/actions/workflows/secrets-scan.yml/badge.svg)](https://github.com/aleks7732/Kovael/actions/workflows/secrets-scan.yml)

Kovael is a Node 22 + TypeScript orchestrator that gives a heterogeneous
fleet of agents — Anthropic Claude Code, Google Gemini (Antigravity IDE
and AGCLI), OpenAI Codex CLI, Google ADK, JetBrains Cowork, and a local
Hermes-hosted persona — one place to sit, speak, and coordinate. A
React 19 cockpit watches every cycle live.

```
 ┌─ Cockpit (Vite, :5173) ──────────────┐
 │  Canvas (xyflow)   Theater (round-table) │
 └──────────┬──────────────────┬─────────┘
            │ WS frames @100ms │ HTTP /api/v1/*
 ┌──────────┴──────────────────┴────────────────────┐
 │            Mesh Orchestrator (:8080)             │
 │                                                  │
 │   ChairRegistry   ConversationBus   MevBridge    │
 │   PersonaLoader   WorkflowLoader    Triad        │
 │   HardwareMonitor RetryQueue        Reconciler   │
 │   HookRunner      RateLimitTracker  Workspaces   │
 │                                                  │
 │            in-memory SQLite (ephemeral)          │
 └──────────┬───────────────────────────────────────┘
            │ Chair Beacon (HTTP claim/heartbeat)
 ┌──────────┴────────────────────────────────────────┐
 │  9 chairs · 9 runtimes · one protocol             │
 │  Claude Code · Antigravity IDE · AGCLI · ADK ·    │
 │  Codex · OpenClaw · Cowork · Gemini CLI · Hermes  │
 └───────────────────────────────────────────────────┘
```

## What it does

- **Chair Beacon Protocol** — any agent runtime claims a chair over HTTP,
  emits a heartbeat every ~7.5s, and the cockpit shows live presence
  (online / stale / offline). One protocol, one helper script, nine
  recipes — see [`docs/CHAIRS.md`](./docs/CHAIRS.md).
- **Conversation Theater** — open a topic, pick up to nine chairs,
  watch them debate token-by-token. `@mentions` route the next speaker,
  and an adaptive-stability stopping criterion calls consensus when the
  rolling-confidence delta falls below ε for K consecutive rounds
  (arXiv 2510.12697).
- **Triad routing with a hardware gate** — every task runs through
  architect → operator → verifier. Heavy architecture is dispatched
  to a local model only when verified VRAM headroom is above
  `routing.vram_floor_mb` (default 8 GiB), otherwise it falls back to a
  cloud chair. See [`WORKFLOW.md`](./WORKFLOW.md).
- **Symphony §7 claim-once semantics** — `TaskClaimMachine` guarantees
  exactly-once dispatch per task hash; concurrent injections of the
  same goal are refused with a structured receipt, not silently
  duplicated.
- **100 ms pressure-valve cockpit** — 50-200 Hz WS telemetry is
  coalesced into one render tick. The canvas holds 60 FPS at 1,000
  active heartbeats; the Theater's streaming deltas use the same
  coalescing path.
- **Hot reload everywhere** — `WORKFLOW.md` and `personas/*.md` reload
  on file change without restarting the orchestrator. Agents pick up
  voice and routing changes on the next dispatch.

## Run it locally

Requires Node 22+ and ports 8080 (orchestrator) + 5173 (cockpit).

```bash
# 1. Install
npm install
cd packages/spatial-war-room && npm install && cd -

# 2. Build the orchestrator
npm run build

# 3. Start the orchestrator (WS + HTTP on :8080)
npm start                # alias for `node dist/boot-mesh.js`

# 4. In a second shell, start the cockpit (Vite on :5173)
cd packages/spatial-war-room && npm run dev
```

Then claim a chair from anywhere — a terminal, an IDE startup hook, a
sandbox boot script:

```bash
node scripts/kovael-chair.mjs \
  --id nyx-claude-code \
  --provider "Anthropic Claude Code" \
  --capabilities filesystem,git,bash,agents
```

The cockpit roster lights up the matching chair within 100 ms.

## The nine chairs

Provider strings match the canonical `AgentCards` (`src/AgentCards.ts`)
— copy them verbatim into `--provider` when claiming a chair.

| Chair | Provider | Tier | VRAM |
|---|---|---|---|
| `shaev` | VantagePoint Local · Hermes 3 | 3 | 24 GB |
| `nyx-antigravity` | Google · Gemini 3 Pro (Antigravity IDE) | 1 | 32 GB |
| `nyx-claude-code` | Anthropic · Claude Code CLI | 1 | cloud |
| `nyx-cli` | Anthropic · Gemini CLI (legacy alias) | 1 | 8 GB |
| `nyx-agcli` | Google · Antigravity CLI | 1 | cloud |
| `nyx-adk` | Google · Agent Development Kit (Python) | 2 | cloud |
| `nyx-codex` | OpenAI · Codex CLI | 2 | cloud |
| `nyx-openclaw` | OpenAI · Codex (elevated sandbox) | 2 | 16 GB |
| `nyx-cw` | JetBrains · Junie / Cowork plugin | 2 | cloud |

Every chair has a persona card under [`personas/`](./personas) (voice,
expertise, disposition) and a 512² portrait under
`packages/spatial-war-room/public/agents/`.

## Architecture

- **Orchestrator** (`src/MeshOrchestrator.ts`) — single-port HTTP +
  WebSocket bus. Endpoints: `/api/v1/state`, `/api/v1/chairs/*`,
  `/api/v1/conversations/*`.
- **MevBridge** (`src/MevBridge.ts`) — Triad pipeline + hardware-gated
  dispatch. Loadable persona system prompts via `PersonaLoader`.
- **ConversationBus** (`src/services/ConversationBus.ts`) — multi-agent
  topic threads with `@mention` routing, streaming deltas in AG-UI
  style, adaptive-stability stopping (ε = 0.05, K = 2, hard cap 6).
- **ChairRegistry** (`src/services/ChairRegistry.ts`) — claim /
  heartbeat / release lifecycle with 15s healthy / 30s offline TTLs.
- **ModelProvider** (`src/services/ModelProvider.ts`) — two
  implementations: `StubMarkovProvider` (deterministic, no network,
  used in the cockpit demo) and `ChairBridgeProvider` (POSTs to a
  chair's `inboxUrl`, suspends until reply at
  `/api/v1/chairs/reply` — lets a real Claude Code / Codex /
  Antigravity chair answer back through the same protocol).
- **Symphony services** — `TaskClaimMachine`, `RetryQueue`,
  `Reconciler`, `WorkspaceManager`, `HookRunner`, `RateLimitTracker`,
  `WorkflowLoader`, `PersonaLoader`, `HardwareMonitor`,
  `SemanticIngestor`.
- **Cockpit** (`packages/spatial-war-room/`) — React 19 + Vite 8 +
  Tailwind v4 (Oxide) + xyflow 12 + Zustand 5. Two tabs (canvas,
  theater), one pressure valve.

## Status

**Shipped on `main`:**

- 9 chairs wired with per-runtime recipes
- ChairRegistry + ConversationBus + ModelProvider duo
- Theater UI (sidebar / stage / convene / messages / stopping card)
- Per-agent identity badges + 9 hero portraits + 9 thumbnails
- 9 persona cards (YAML front-matter + lore body)
- Triad routing with hardware gate, retry queue, reconciler, hooks
- 153 tests across 22 files (orchestrator + cockpit)
- Three-Layer PII Defense (pre-commit + workflow + TruffleHog)
- Single-port WS+HTTP orchestrator with 16 KiB body cap on POSTs

**In flight (`antigravity/phoenix`, deep brief on PR #18):**

- Committee primitive — proponent / critic / judge roles, 422 on
  homogeneous-provider committees
- A2A v1.2 adapter — JWS-signed Agent Card at
  `/.well-known/agent.json`, JWKS endpoint, `sendSubscribe` bridge
- OTel GenAI spans — `cycle.run` root + `gen_ai.*` phase spans,
  `traceparent` propagated through every cross-bus frame, in-memory
  ring buffer + OTLP exporter, TraceView in the cockpit

See [`docs/briefs/2026-05-ag-nyx-phoenix-deep.md`](./docs/briefs/2026-05-ag-nyx-phoenix-deep.md)
for the Day 5-7 deep dive.

## Tests

```bash
npx vitest run                    # full suite (153 cases)
npx tsc --noEmit                  # orchestrator typecheck
cd packages/spatial-war-room && npm run typecheck         # cockpit
cd packages/spatial-war-room && npm run typecheck:tests   # test fixtures
cd packages/spatial-war-room && npm run build             # Vite build
```

The CI workflow (`.github/workflows/ci.yml`) runs all of the above on
every PR.

## Security posture

Kovael runs with a **localhost trust posture**. Chair endpoints,
conversation endpoints, and the WebSocket bus assume same-host access;
exposing them publicly requires an authenticating reverse proxy.

PII discipline is enforced by three coordinated layers — pre-commit
hooks on the contributor's machine, a `pii-guard.yml` workflow on every
push, and `TruffleHog --only-verified` on every push and weekly cron.
See [`SECURITY.md`](./SECURITY.md) for the full Three-Layer Defense
and reporting instructions.

## Documentation

- [`WORKFLOW.md`](./WORKFLOW.md) — Triad contract, ANX manifest, routing
  config, hardware floor, sharding policy, retry policy
- [`docs/CHAIRS.md`](./docs/CHAIRS.md) — Chair Beacon Protocol spec +
  per-chair integration recipes for all nine runtimes
- [`docs/briefs/`](./docs/briefs/) — multi-day execution briefs (PHOENIX
  feature expansion, mid-week checkpoint, Day 5-7 deep dive)
- [`SECURITY.md`](./SECURITY.md) — security policy + PII-Guard setup
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contribution guidelines
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — community standards

## License

[MIT](./LICENSE)
