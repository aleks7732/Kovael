# Orchestrator latency SLOs

These targets define the **per-request p99 budget** for the orchestrator's hot
HTTP surface, measured sequentially over loopback (no client-side concurrency).
The numbers are deliberately tight: this is a localhost in-process boot, so any
regression here points at code, not network. Load characteristics (concurrent
clients, sustained throughput) are out of scope and tracked separately.

`scripts/perf.mjs` is the canonical measurement harness. It exits non-zero when
any of the budgets below are missed, so it can run as a CI gate.

| endpoint                       | p99 budget |
|--------------------------------|-----------:|
| `/livez`                       |  5 ms      |
| `/api/v1/state`                | 50 ms      |
| `/api/v1/chairs/heartbeat`     | 20 ms      |
| `/metrics`                     | 10 ms      |
| `/api/v1/chairs/claim`         | 30 ms      |

## Rationale

- `/livez` is a liveness probe. Kubernetes hits it on a tight cadence and any
  blocking work inside it makes the orchestrator look unhealthy under load.
- `/api/v1/state` aggregates several in-memory snapshots. 50 ms leaves room for
  the snapshot to grow without breaking the cockpit's poll loop.
- `/api/v1/chairs/heartbeat` runs continuously per claimed chair. It must be
  cheap — the budget is generous enough to absorb GC pauses but tight enough
  to catch accidental I/O on the hot path.
- `/metrics` is scraped by Prometheus; 10 ms keeps it well under typical
  scrape timeouts even when the registry grows.
- `/api/v1/chairs/claim` is cold(er) than heartbeat (it allocates a session
  and emits an audit event) so it gets a slightly wider budget.

## Updating these targets

Numbers should only move **down** as the orchestrator gets faster. If a code
change legitimately requires more headroom (e.g. a new per-request guarantee),
land the perf-impacting change in one PR, update the SLO + baseline in a
follow-up PR with the measured rationale.
