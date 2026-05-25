# Chair Beacon Protocol

The Kovael cockpit's agent roster shows two layers of state for every chair:

1. **Static identity** — name, provider, MCP capabilities, trust tier
   (declared in `src/AgentCards.ts`).
2. **Runtime presence** — whether that chair is *actually occupied right
   now* by a live agent process (tracked by
   `src/services/ChairRegistry.ts`).

Any agent — Claude Code, Antigravity IDE, Codex CLI, ADK, JetBrains
Cowork, Hermes-hosted Shaev, anything — speaks the same three-call
protocol to claim, hold, and release a chair.

> Trust posture: the chair endpoints are intended for localhost / private
> mesh use. Do not expose `/api/v1/chairs/*` directly to the public
> internet without an authenticating reverse proxy.

## The protocol

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/chairs/claim` | POST | Take a seat. Returns `sessionId` + `heartbeatIntervalMs` + `ttlMs`. |
| `/api/v1/chairs/heartbeat` | POST | Refresh liveness. Must include the `sessionId` from claim. |
| `/api/v1/chairs/release` | POST | Graceful exit. |
| `/api/v1/chairs/reply` | POST | Return a live chair response for an in-flight dispatch. |
| `/api/v1/chairs` | GET  | Current roster snapshot. |

Beacons newer than 15s render as **live** (pulsing green pill). Between
15s and 30s the cockpit shows **stale** (amber). At 30s the chair is
evicted as **offline** (red, then dropped from presence).

Claimed presence and dispatch capability are separate. A chair is visible
as occupied after `claim`/`heartbeat`, and the Theater can select it for a
debate. If the claim includes an `inboxUrl`, Kovael posts the turn payload
to that inbox URL and the agent answers by posting `{ topicId, agentId,
content }` to `/api/v1/chairs/reply`. Without an `inboxUrl`, Kovael records
that the chair was presence-only instead of fabricating a live agent reply.

## Durable local inboxes

`scripts/kovael-agent-inbox.mjs` is the loopback-only runtime adapter for
live chair handoff. It starts a local `/inbox`, claims the chair with that
`inboxUrl`, runs the configured runtime for each dispatch, and returns the
answer through `/api/v1/chairs/reply`.

Each inbox adapter also opens a local SQLite hub file:

```text
%LOCALAPPDATA%\Kovael\agents\<agent-id>\agent-hub.sqlite
```

The hub records inbound dispatches, runtime status, replies, errors,
idempotency keys, and simple memory rows. It is a local edge log only:
Kovael's orchestrator remains authoritative for chairs, topics,
conversation history, and routing. Stopping the app releases chairs and
stops the adapter process, but it does not delete the hub file.

Do not put hub files on a network filesystem, cloud-synced folder, or
shared replica volume. Hubs are not a distributed queue and are not
replicated between orchestrator instances. If a hub is deleted, that
agent loses local edge history, but global orchestrator state remains
intact. The default app-managed hub location is outside the workspace.
SQLite WAL sidecars (`-wal` and `-shm`) stay beside the hub on local disk.

```bash
node scripts/kovael-agent-inbox.mjs \
  --id nyx-codex \
  --provider "OpenAI · Codex CLI" \
  --runtime codex \
  --host http://127.0.0.1:8080 \
  --hub-path .kovael/agents/nyx-codex/agent-hub.sqlite
```

Set `KOVAEL_CHAIR_DISPATCH_SECRET` to a 32+ character secret to require
encrypted dispatch and reply envelopes. The adapter keeps that secret for
the inbox/reply boundary and strips it before launching the underlying
agent runtime. `KOVAEL_AGENT_HUB_SECRET` enables active field encryption
inside `agent-hub.sqlite`; managed runtimes require hub encryption and
refuse startup without a 32+ character hub secret.

## App-managed lifecycle

The orchestrator can supervise local inbox adapters directly. This is
off by default:

```bash
KOVAEL_AGENT_RUNTIMES_ENABLED=true npm start
```

Default supervised agents are `shaev` and `nyx-codex`. `nyx-openclaw` is
not started by the default local lifecycle profile because it uses the
elevated `codex-openclaw` runtime profile. Add it only through an
explicit elevated-runtime opt-in.

| Variable | Default | Purpose |
|---|---:|---|
| `KOVAEL_AGENT_RUNTIMES_ENABLED` | `false` | Start local inbox adapters with the orchestrator |
| `KOVAEL_AGENT_RUNTIME_IDS` | `shaev,nyx-codex` | Comma-separated supervised agent IDs |
| `KOVAEL_AGENT_HUB_DIR` | OS app data | Parent directory for per-agent hub files; default is outside the workspace |
| `KOVAEL_AGENT_RUNTIMES_PARK_ON_IDLE` | `true` | Stop adapters in idle mode and restart on active use |
| `KOVAEL_API_TOKEN` | unset | Bearer token for orchestrator API/metrics/WS gates; forwarded to adapters as `KOVAEL_TOKEN` |
| `KOVAEL_CHAIR_DISPATCH_SECRET` | unset | 32+ character dispatch/reply envelope secret |
| `KOVAEL_AGENT_HUB_SECRET` | unset | Active field-encryption secret for hub payloads, replies, receipts, and memory |
| `KOVAEL_AGENT_HUB_ENCRYPTION` | optional | Set to `required` for manual adapters that must reject plaintext hub storage |

If `KOVAEL_API_TOKEN` gates the HTTP API, the supervisor passes it to the
adapter as `KOVAEL_TOKEN` and uses `--with-token`; the adapter removes
both token variables before spawning the underlying runtime.

Lifecycle behavior:

- App start: the supervisor starts configured adapters after the
  orchestrator binds its HTTP port.
- App stop: the supervisor sends `SIGTERM`; adapters release their chair,
  close their loopback inbox, and close their hub database.
- Idle parking: when `KOVAEL_AGENT_RUNTIMES_PARK_ON_IDLE=true`, adaptive
  resource mode stops adapters on idle and restarts them on active use.
  Hub files are reused non-destructively.

Container and Kubernetes defaults keep supervised local runtimes disabled.
Only enable them in Docker or Kubernetes after adding runtime binaries, a
writable local hub volume, and secret injection for `KOVAEL_API_TOKEN`,
`KOVAEL_CHAIR_DISPATCH_SECRET`, and `KOVAEL_AGENT_HUB_SECRET` material.
Managed runtimes require hub encryption. The default two-replica
Kubernetes deployment must not share per-agent hubs as distributed state.

See `docs/runbooks/agent-hub-lifecycle.md` for the operator runbook.

## Quick-start — `kovael-chair` helper

A zero-dependency Node wrapper is included at `scripts/kovael-chair.mjs`.
It handles claim → heartbeat (every 7.5s by default) → release on
SIGINT/SIGTERM/SIGHUP.

```bash
node scripts/kovael-chair.mjs \
  --id nyx-codex \
  --provider "OpenAI Codex CLI" \
  --capabilities filesystem,git,shell \
  --trust 2 \
  --inbox-url http://127.0.0.1:9001/inbox
```

Omit `--inbox-url` for presence-only beacons. Presence-only chairs stay
visible and selectable, but Kovael will mark their debate turn as not
handoff-capable until they register an inbox.

One-shot probe (claim + immediate release; useful as a session-start
breadcrumb if you don't want a long-running heartbeat process):

```bash
node scripts/kovael-chair.mjs --id nyx-claude-code --provider "Claude Code" --probe
```

Environment overrides:

- `KOVAEL_HOST` — defaults to `http://localhost:8080`.
- `KOVAEL_TOKEN` — optional bearer token forwarded as `Authorization`.

## Recipe per chair

### 1. Nyx-Claude-Code (this session)

From inside a Claude Code session, run the helper in the background of
your shell. Claude Code's harness reaps the process when the session
ends.

```bash
node scripts/kovael-chair.mjs \
  --id nyx-claude-code \
  --provider "Anthropic Claude Code" \
  --capabilities filesystem,git,bash,agents &
```

### 2. Nyx-Antigravity (Gemini 3 Pro IDE)

Add a workspace startup task to `.antigravity/tasks.json`:

```json
{
  "label": "kovael-chair",
  "type": "shell",
  "command": "node ${workspaceFolder}/scripts/kovael-chair.mjs --id nyx-antigravity --provider 'Gemini 3 Pro · Antigravity IDE' --capabilities comfyui,blender,browser,desktop --trust 1",
  "runOptions": { "runOn": "folderOpen" }
}
```

### 3. Nyx-AGCLI (Antigravity CLI)

Drop into `~/.agcli/init.sh`:

```bash
( node "$KOVAEL_REPO/scripts/kovael-chair.mjs" \
    --id nyx-agcli \
    --provider "Antigravity CLI" \
    --capabilities terminal,filesystem,git,browser \
    --trust 1 &)
```

### 4. Nyx-ADK (Google Agent Development Kit)

ADK runs Python. Use a one-shot probe from a tool callback:

```python
import requests, os
HOST = os.environ.get("KOVAEL_HOST", "http://localhost:8080")

def kovael_chair_claim():
    r = requests.post(f"{HOST}/api/v1/chairs/claim", json={
        "agentId": "nyx-adk",
        "provider": "Google ADK",
        "capabilities": ["python", "google-cloud", "tool-use"],
        "trustTier": 2,
    }, timeout=2)
    return r.json()
```

Hold the returned `sessionId` and call `/chairs/heartbeat` from your
ADK runtime loop every ~7.5 seconds, then `/chairs/release` on shutdown.

### 5. Nyx-Codex (OpenAI Codex CLI, standard sandbox)

Codex supports post-exec hooks. Add to `~/.codex/hooks/post-exec`:

```bash
#!/usr/bin/env bash
node "$KOVAEL_REPO/scripts/kovael-chair.mjs" \
  --id nyx-codex --provider "OpenAI Codex CLI" \
  --capabilities filesystem,git,shell --trust 2 --probe
```

This probes per-exec. For long-running Codex sessions, swap `--probe`
for a backgrounded heartbeat invocation.

### 6. Nyx-OpenClaw (Codex elevated sandbox)

Sandbox boot script (`/opt/openclaw/entrypoint.sh`):

```bash
exec node /opt/scripts/kovael-chair.mjs \
  --id nyx-openclaw --provider "OpenAI Codex · Elevated Sandbox" \
  --capabilities sandbox-execution,game-dev-pack,network-egress \
  --trust 2 \
  --host "$KOVAEL_HOST"
```

`exec` makes the sandbox PID 1 the helper itself — container exit
becomes a clean release.

### 7. Nyx-Cowork (JetBrains Junie / Cowork plugin)

JetBrains IDEs expose external tools. Add a startup external tool with:

- **Program:** `node`
- **Arguments:** `$ProjectFileDir$/scripts/kovael-chair.mjs --id nyx-cw --provider "JetBrains Junie" --capabilities filesystem,git,refactoring,inspections --trust 2`
- **Working directory:** `$ProjectFileDir$`

Bind it to the `IDE Startup` activity.

### 8. Shaev (in Hermes)

Hermes 3 supports tool calls. Register `kovael_chair_heartbeat` as a
tool and instruct the system prompt to call it once per response:

```yaml
tools:
  - name: kovael_chair_heartbeat
    description: Tell the Kovael orchestrator that Shaev is alive.
    parameters:
      type: object
      properties:
        sessionId: { type: string }
      required: [sessionId]
    runtime: shell
    command: |
      curl -fsS -X POST $KOVAEL_HOST/api/v1/chairs/heartbeat \
        -H 'Content-Type: application/json' \
        -d "{\"agentId\":\"shaev\",\"sessionId\":\"$1\"}"
```

Initial claim happens once at Hermes boot via the helper script; the
tool then keeps the chair warm during inference.

## Troubleshooting

- **`409 unknown_or_superseded_session`** — your heartbeat is using a
  session that has been replaced (a later claim from the same agentId
  evicts the prior session). Re-claim and reuse the new sessionId.
- **Pill stuck on `STALE`** — beacon hasn't arrived in 15s+. Check the
  helper process is still running; check network reachability to
  `KOVAEL_HOST`.
- **Pill never appears** — the orchestrator may not be listening; verify
  with `curl http://localhost:8080/api/v1/chairs`.
