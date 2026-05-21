# Docker Smoke + Measurement Runbook

Validates the distroless `Dockerfile` (merged in PR #21, commit `a49eaab`) by
actually building, running, and measuring the image. Companion to
`scripts/lint-dockerfile.mjs` (daemon-free static lint) and
`scripts/measure-docker-image.mjs` (runs this entire flow when Docker is
present).

## When to run

- Before any release that touches `Dockerfile`, `.dockerignore`, `package.json`,
  `tsconfig.json`, or anything copied into the runtime stage (`personas/`,
  `WORKFLOW.md`, `src/`).
- After bumping the pinned `gcr.io/distroless/nodejs22-debian12:nonroot@sha256:...`
  digest.
- Whenever `npm ci` adds or removes a runtime dependency.

## Prerequisites

- Docker Engine reachable (`docker version` exits 0 and reports both Client and
  Server). The sandbox this runbook was authored in had the client installed
  but no daemon (`dial unix /var/run/docker.sock: connect: no such file or
  directory`), so all metrics below are placeholders pending a host with a
  running daemon.
- Free TCP port `8081` on the host (override with `KOVAEL_SMOKE_PORT=...`).
- `curl` for the manual `/livez` probe (the scripted flow uses `fetch` from
  Node).

## One-shot scripted flow

```bash
node scripts/measure-docker-image.mjs
```

The script is idempotent: it removes any prior `kovael-smoke` container and
`kovael:local` image before building, and tears both down after measuring. If
Docker isn't available it exits 0 with a `[SKIP]` line so it's safe to wire
into CI as a best-effort gate.

On success the script prints a markdown table identical to the one in
[Results](#results) below; paste those values into this file when re-measuring.

## Manual flow

Equivalent to what the script does, broken out for ad-hoc debugging.

### 1. Build

```bash
docker build -t kovael:local -f Dockerfile .
docker images kovael:local --format '{{.Size}}'
```

Record build wall-clock and the printed size.

### 2. Run

```bash
docker run --rm -d --name kovael-smoke -p 8081:8080 kovael:local
```

### 3. Poll `/livez` until 200

```bash
START=$(date +%s%3N)
until curl -fsS -o /dev/null http://127.0.0.1:8081/livez; do
    [ $(( $(date +%s%3N) - START )) -gt 30000 ] && { echo "timeout"; exit 1; }
    sleep 0.5
done
echo "cold start: $(( $(date +%s%3N) - START ))ms"
```

### 4. Steady-state RSS

```bash
sleep 60
docker stats kovael-smoke --no-stream --format '{{.MemUsage}}'
```

### 5. Teardown

```bash
docker rm -f kovael-smoke
docker rmi -f kovael:local
```

## Results

Last measured: not yet measured on a Docker-equipped host.
Sandbox where this runbook was written: Docker client `29.3.1` present, daemon
unreachable.

| metric | value |
| --- | --- |
| image size | (to be measured) |
| build time | (to be measured) |
| cold start to `/livez` 200 | (to be measured) |
| RSS after 60s | (to be measured) |
| operator | (to be measured) |
| date | (to be measured) |
| host arch | (to be measured) |
| docker version | (to be measured) |

Targets the orchestrator is designed to clear (informational, not gates):

- image size under 200 MB compressed (distroless Node 22 base is ~150 MB
  uncompressed)
- cold start to `/livez` 200 under 3 s on a warm host (no DB warmup, no model
  load)
- steady-state RSS under 120 MB with the default persona set

If a measurement misses one of these by more than 25 percent, file an issue
referencing this runbook and the iteration that regressed it.

## Troubleshooting

- **`/livez` never returns 200.** Run `docker logs kovael-smoke` — the
  orchestrator logs `orchestrator_listening` once the HTTP server binds. If
  that line never appears the boot crashed; the stack trace will be in the
  logs. The runtime is distroless so there is no shell to `docker exec` into.
- **Build hangs on `npm ci`.** The Dockerfile uses a BuildKit cache mount at
  `/root/.npm`. A corrupted cache shows up as repeated tarball errors —
  `docker builder prune --filter type=exec.cachemount` clears it.
- **`port is already allocated`.** Another `kovael-smoke` is still running, or
  port 8081 is held by something else. `docker rm -f kovael-smoke` then retry,
  or set `KOVAEL_SMOKE_PORT=9090` for the scripted flow.
- **`HEALTHCHECK` shows `unhealthy`.** The baked-in healthcheck hits
  `/api/v1/state`, which is the gated surface — `/livez` is the unauthenticated
  liveness probe and is what this runbook polls. The two disagreeing is fine
  and expected when `KOVAEL_API_TOKEN` is set.
