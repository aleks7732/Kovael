# Agent Hub Lifecycle Runbook

This runbook covers the operator path for app-managed local agent runtimes:
starting supervised inbox adapters, verifying their per-agent hubs, stopping
or parking them safely, and validating that the orchestrator remains the
authoritative control plane.

## Scope

App-managed lifecycle is for trusted local workstations or private mesh hosts.
It is disabled by default. When enabled, the orchestrator starts local
`scripts/kovael-agent-inbox.mjs` adapter processes, each adapter claims a chair
with an `inboxUrl`, and each adapter writes a local SQLite hub:

```text
%LOCALAPPDATA%\Kovael\agents\<agent-id>\agent-hub.sqlite
```

The hub is a local edge log. It records inbound dispatches, runtime state,
reply receipts, errors, idempotency keys, and memory rows for one agent. It is
not a cluster database, not a distributed queue, and not the source of truth
for chairs, topics, routing, or conversation history. The orchestrator remains
authoritative for global mesh state.

## Preconditions

- Node 22+ is installed.
- Dependencies are installed with `npm ci` or `npm install`.
- The orchestrator is built with `npm run build`.
- Runtime CLIs needed by the selected adapters are installed and reachable:
  `codex` for `nyx-codex`, `claude` for `shaev`, or explicit binary paths via
  the relevant runtime environment.
- `KOVAEL_AGENT_HUB_DIR` points at local disk, not a network filesystem.
- `KOVAEL_AGENT_HUB_SECRET` is set to a 32+ character value before
  `KOVAEL_AGENT_RUNTIMES_ENABLED=true`; managed runtimes require hub encryption.

Do not place hub files on SMB, NFS, cloud-synced folders, or shared volume
replicas. SQLite WAL semantics and per-agent idempotency are local-process
contracts; network filesystem locking can corrupt the operator signal and make
dispatch retries ambiguous.

## Start

From the repo root:

```bash
npm run build
KOVAEL_AGENT_RUNTIMES_ENABLED=true npm start
```

Default supervised agents are `shaev` and `nyx-codex`:

```text
KOVAEL_AGENT_RUNTIME_IDS=shaev,nyx-codex
```

`nyx-openclaw` is intentionally excluded from the default lifecycle profile
because it runs the elevated `codex-openclaw` adapter mode. Only include it
after an operator explicitly accepts the elevated sandbox and host-access
posture for that session.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `KOVAEL_AGENT_RUNTIMES_ENABLED` | no | Set `true` to let the orchestrator start local inbox adapters. |
| `KOVAEL_AGENT_RUNTIME_IDS` | no | Comma-separated allowlist of supervised agents. Unknown IDs are ignored. |
| `KOVAEL_AGENT_HUB_DIR` | no | Local parent directory for per-agent `agent-hub.sqlite` files. Defaults to OS app data outside the workspace. |
| `KOVAEL_AGENT_RUNTIMES_PARK_ON_IDLE` | no | When `true`, idle resource mode stops adapters and active mode restarts them. |
| `KOVAEL_API_TOKEN` | recommended | Gates `/api/v1/*`, `/metrics`, and authenticated WebSocket upgrades. The supervisor forwards it to adapters as `KOVAEL_TOKEN`. |
| `KOVAEL_CHAIR_DISPATCH_SECRET` | recommended for real prompts | 32+ character secret for encrypted chair dispatch and reply envelopes. Adapters strip it before launching underlying runtimes. |
| `KOVAEL_AGENT_HUB_SECRET` | required for managed runtimes | Active field-encryption secret for hub payloads, replies, receipts, and memory. |
| `KOVAEL_AGENT_HUB_ENCRYPTION` | no | Set to `required` for manual adapters that must reject plaintext hub storage. |

Keep all three secrets out of source, container images, shell history, and PR
descriptions. Use a local secret manager, CI secret, or Kubernetes Secret as
appropriate for the host.

## Verify Start

Check orchestrator state:

```bash
curl -fsS http://127.0.0.1:8080/api/v1/state
```

Expected:

- `agentRuntimes.enabled` is `true`.
- `agentRuntimes.running` matches the configured local adapters.
- `agentRuntimes.agents[*].hubPath` points under the local hub directory outside the workspace by default.
- `/api/v1/chairs` shows the supervised chairs as claimed.

Check local hub files:

```bash
dir "%LOCALAPPDATA%\Kovael\agents"
```

Expected on Windows defaults:

```text
%LOCALAPPDATA%\Kovael\agents\shaev\agent-hub.sqlite
%LOCALAPPDATA%\Kovael\agents\nyx-codex\agent-hub.sqlite
```

WAL sidecar files (`agent-hub.sqlite-wal` and `agent-hub.sqlite-shm`) may
appear beside the hub. They are runtime data, remain gitignored, and must stay
on the same local disk as the main hub file. For backups, checkpoint or use a
SQLite-aware backup flow instead of blindly copying only the main file during
writes.

## Stop

Stop the orchestrator with `Ctrl+C` or the service manager for the host. The
supervisor sends `SIGTERM` to each managed adapter. Each adapter attempts to
release its chair through `/api/v1/chairs/release`, closes its local inbox, and
closes the hub database.

Stopping does not delete hub files. That is intentional: hubs are durable local
edge logs and can be inspected, backed up, pruned, or deleted by an operator
without corrupting orchestrator state.

## Idle Park And Restart

With `KOVAEL_AGENT_RUNTIMES_PARK_ON_IDLE=true`, adaptive resource mode stops
supervised adapters when the orchestrator enters idle mode. When interactive
use resumes, active mode restarts the configured adapters and reuses the same
per-agent hub paths.

This restart is non-destructive. The next claim supersedes any stale session
from the parked adapter, and idempotency rows remain in the local hub.

Set the flag to `false` when a long-running local runtime must remain claimed
even while the cockpit and API are quiet:

```bash
KOVAEL_AGENT_RUNTIMES_ENABLED=true \
KOVAEL_AGENT_HUB_SECRET=change-me-to-a-32-character-secret \
KOVAEL_AGENT_RUNTIMES_PARK_ON_IDLE=false \
npm start
```

## Validation

Fast docs/package validation for this lane:

```bash
npm run validate:pr
```

Full chair dispatch validation:

```bash
npm run validate:chairs
```

Equivalent direct command when script aliases are unavailable:

```bash
node scripts/validate-pr.mjs
```

The all-chair validation builds against `dist`, boots an ephemeral
orchestrator, claims all canonical chairs through real HTTP, dispatches to fake
loopback inboxes, and asserts every chair receives traffic. It is strict by
default and fails on chair fallback paths; set
`KOVAEL_ALLOW_CHAIR_FALLBACKS=true` only when intentionally validating a
fallback-tolerant environment. Failures retain sanitized artifacts under
`.notes/chair-smoke/<timestamp>/`; set
`KOVAEL_RETAIN_SMOKE_ARTIFACTS=always` to retain those artifacts for passing
runs too.

## Docker And Kubernetes Caveats

The production Docker image and Kubernetes manifests are orchestrator-first.
Supervised local runtimes must stay disabled unless the deployment is
explicitly designed for them.

For Docker, enable local runtimes only if the image includes the adapter script
and any runtime CLIs, and mount a writable local hub directory:

```bash
docker run --rm -p 8080:8080 \
  -e KOVAEL_AGENT_RUNTIMES_ENABLED=true \
  -e KOVAEL_AGENT_HUB_DIR=/data/agents \
  -e KOVAEL_AGENT_HUB_SECRET="$KOVAEL_AGENT_HUB_SECRET" \
  -v kovael-agent-hubs:/data/agents \
  kovael:latest
```

For Kubernetes, do not turn on `KOVAEL_AGENT_RUNTIMES_ENABLED` in the default
two-replica deployment. Each pod would supervise its own local adapters and its
own hub files, which is not distributed replication. If a specialized operator
deployment needs local adapters, use one replica, an explicit writable volume
for `KOVAEL_AGENT_HUB_DIR`, runtime binaries in the image, and Secrets for
`KOVAEL_API_TOKEN`, `KOVAEL_CHAIR_DISPATCH_SECRET`, and any
`KOVAEL_AGENT_HUB_SECRET` material. The hub volume must be local disk for that
pod, not a network filesystem shared by replicas.

## Troubleshooting

- `agentRuntimes.enabled` is `false`: confirm `KOVAEL_AGENT_RUNTIMES_ENABLED`
  is set in the same environment that launches `npm start`.
- A configured agent is missing: confirm the ID is supported by the local
  lifecycle profile. `nyx-openclaw` requires explicit elevated opt-in work.
- Hubs do not appear: confirm `KOVAEL_AGENT_HUB_DIR` is writable local disk and
  `KOVAEL_AGENT_HUB_SECRET` is set for managed runtimes.
- Chairs claim then disappear: check adapter stderr in orchestrator logs and
  confirm the runtime CLI can launch from the configured working directory.
- Dispatch fails with security errors: set the same
  `KOVAEL_CHAIR_DISPATCH_SECRET` for the orchestrator and adapter boundary.
