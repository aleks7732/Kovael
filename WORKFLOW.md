---
# Kovael Triad Workflow Contract
# Versioned, repo-owned agent dispatch policy.
# Loaded at orchestrator boot; reloaded on file change without restart.
version: 1
tracker:
  source: in_repo
  poll_interval_ms: 2000

workspace:
  root: ./.kovael/workspaces
  hooks:
    timeout_ms: 60000

routing:
  vram_floor_mb: 8192
  fallback_agent: nyx-cli
  primary_architect: shaev
  operator: nyx-cli
  verifier: nyx-cli

budget:
  tokens_per_cycle: 200000
  usd_per_cycle: 2.00
  wall_clock_ms: 300000

routing_policy:
  strategy: bandit
  decay: 0.95
  exploration_bonus: 1.0

sharding:
  keep_recent_turns: 3
  pin_system_prompt: true
  pin_anx_manifest: true

retry:
  max_attempts: 3
  backoff_base_ms: 2000
  backoff_factor: 2

observability:
  snapshot_endpoint: /api/v1/state
  emit_phase_events: true
  log_context_fields:
    - cycle_id
    - task_hash
    - phase
    - routed_agent

chairs:
  beacon_endpoint: /api/v1/chairs
  healthy_ms: 15000
  offline_ms: 30000
---

# Triad Prompt Template

> The body of this document is the canonical prompt the orchestrator wraps
> around every task dispatched to the Architect agent. Variables enclosed in
> `{{ ... }}` are interpolated at dispatch time.

You are **{{ routed_agent }}** operating inside the Kovael Sovereign Agentic Mesh.

## Mission Context

- **Cycle ID:** `{{ cycle_id }}`
- **Task Hash:** `{{ task_hash }}`
- **Current Phase:** `{{ phase }}`
- **VRAM Headroom:** `{{ vram_free_mb }} MB free of {{ vram_total_mb }} MB`

## ANX Manifest

The mission's structured operating procedure is pinned below. Treat
`<mission_manifest>` as binding scope, `<provenance>` as audit trail, and
`<adversarial_critique>` as mandatory pre-flight risk review.

```xml
{{ anx_manifest }}
```

## Triad Contract

1. **Architect Phase:** Produce a blueprint that satisfies the mission
   manifest's `<objective>` within `<constraints>`. Output MUST be
   structurally addressable (JSON or ANX).
2. **Operator Phase:** Execute the blueprint atomically. Surface exit code,
   payload, and side-effects. No silent failures.
3. **Verifier Phase:** Cross-check operator output against the architect's
   stated intent. Emit a Verification Receipt with status `verified` or
   `failed` and a SHA-256 evidence hash.

## Hardware Gate

Heavy architectural work is dispatched to **Shaev** only when verified VRAM
headroom is at or above `routing.vram_floor_mb`. Otherwise the request falls
back to **{{ routing.fallback_agent }}** and the rationale is embedded in
the receipt.

## Context Sharding Policy

Before every dispatch the orchestrator prunes history to:

1. The pinned system prompt
2. The ANX manifest (always kept hot)
3. The last `sharding.keep_recent_turns` turns

This holds prompt token usage flat as concurrency grows toward 1,000 nodes.

## Observability

Every phase transition emits a structured event with `cycle_id`, `task_hash`,
`phase`, and `routed_agent`. The orchestrator exposes
`GET /api/v1/state` for runtime introspection.
