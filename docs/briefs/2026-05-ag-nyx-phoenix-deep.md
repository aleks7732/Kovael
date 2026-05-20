# AG Nyx · PHOENIX Deep-Dive · Days 5–7

**Codename:** PHOENIX-DEEP
**Author:** Nyx-Claude-Code (Anthropic · Claude Opus 4.7), on behalf of the operator
**Supersedes:** §4 (Day 5), §5 (Day 6), §6 (Day 7) of `2026-05-ag-nyx-phoenix.md`
**Reaffirms:** the full §3 (process discipline) of `2026-05-ag-nyx-phoenix-checkpoint.md`
**Branch policy:** three working branches, one per day:
  `antigravity/phoenix-day5-committee`,
  `antigravity/phoenix-day6-a2a`,
  `antigravity/phoenix-day7-otel`.
**PR policy:** draft on open, ready when all stated acceptance gates green.

---

## 0. Why this exists

The original PHOENIX brief gave Days 5–7 a paragraph each. That was enough for Days 1–4 — you delivered exceptional work on those (mid-week grade: A). Days 5–7 introduce primitives the rest of the mesh will depend on for months: a deliberation primitive that fan-outs to multiple chairs at once; an external-trust surface that anyone in the world can speak to; and an observability layer every cycle from now on must emit into. **Those three pieces deserve more than a paragraph.** This document fills in everything the original brief left implicit: schemas, decision trees, failure modes, performance budgets, alternatives considered and rejected, the exact span hierarchy, the exact wire formats, the exact key-rotation procedure.

Read this end to end *before* you cut Day 5's branch. Disagree with anything in writing (a question in `.notes/PHOENIX_LOG.md` for the operator to resolve) — don't silently reinterpret.

---

## 1. Architectural invariants you cannot violate

These are not stylistic preferences. They are load-bearing properties of the system you are extending. **Each one was discovered the hard way at some point in the session log**; breaking one breaks the cockpit.

### 1.1 Pressure-valve invariant

The cockpit's WS bus delivers ~50 Hz under load. React rendering is batched at 100 ms via `flushPressureValve()` in `useWarRoomStore.ts`. **No new feature you ship in Days 5–7 may bypass this batch.** Specifically:

- Conversation deltas, committee turns, A2A SSE events, trace span notifications — every cross-bus message that lands in the cockpit goes through the same coalescing path you already use for `conversation_message_delta`.
- Do **not** call `useWarRoomStore.setState(...)` from inside an `onmessage` handler. Push to the existing pending buffer and let the 100 ms tick drain.
- If you discover a frame type that genuinely cannot wait 100 ms (you almost certainly will not), bring it to the operator before bypassing.

### 1.2 PII discipline (public repo)

This repo is public. The operator's handle was scrubbed in `c83a913`; nothing you ship — code, prompt, log, schema, error string, screenshot caption, persona card — may re-introduce it. `personas/` is read by strangers. **Lore is fictional.** Add a forbidden-string pattern to `.kovael-forbidden-patterns.txt` if you introduce a new term that should never appear in a commit.

### 1.3 Localhost-trust posture for the *internal* mesh

The chair endpoints, the conversation HTTP, the new `/api/v1/committees` endpoint, the OTel trace endpoint — **all of these remain localhost / private-mesh by default.** Body cap stays at 16 KiB. SessionId-bound mutations stay sessionId-bound. The *only* externally-trusted surface in this brief is the A2A adapter on Day 6, and that surface mints its trust from a signed Agent Card — not from a localhost bypass.

### 1.4 Hardware-gated routing stays untouched

`MevBridge.routeArchitect()` is load-bearing for the live demo. You are not allowed to modify its routing logic on Days 5–7. Committee, A2A, and OTel are *layered on top* of the Triad — they do not modify it. The committee runs on the ConversationBus, not the Triad. A2A bridges *into* the Triad through `injectTask`, not around it.

### 1.5 SQLite is in-memory and ephemeral

The `memoryDb` in `MeshOrchestrator` is `:memory:`. Every restart wipes it. **Do not** add persistence assumptions that survive a restart. The receipt ledger, conversation history, committee verdicts, and trace ring buffer are all gone on restart, and that is by design today. If you need durability, write it to the on-disk workspace directory (`.kovael/workspaces/`) and treat the DB as a hot cache.

---

## 2. Day 5 — Committee primitive

### 2.1 Why a Committee and not just a longer Conversation

A `Conversation` is free-form. Agents address each other with `@mention`, the bus picks the next speaker, and adaptive-stability stops the loop when the verifier's confidence stops moving. That works for design discussions, brainstorms, debate. It is the wrong primitive for **"settle on an answer"** because:

- There's no role separation. Whoever speaks last has the final word.
- Stop conditions are stability-only — they don't encode *agreement*.
- The audit trail is a transcript, not a verdict you can chain into the Triad.

The Committee primitive (arXiv 2603.28488 courtroom pattern + arXiv 2510.12697 adaptive stability) layers structure on top:

- **Proponents** propose a position.
- **Critics** stress-test it.
- **Judges** vote and report confidence.
- The loop stops when judge confidence stabilises **and** majority agrees, OR a hard cap fires.
- The output is a `CommitteeVerdict` you can attach to a Triad cycle as the architect's blueprint.

### 2.2 Wire shape

The committee runs on top of `ConversationBus`. Each role's turn is one bus message, formatted as JSON inside `delta` so the existing cockpit transcript renders it naturally. The Theater displays it richly via a new `CommitteeTurnCard` component; raw conversation views render the JSON readably.

```ts
// src/services/Committee.ts

export type CommitteeRole = 'proponent' | 'critic' | 'judge';
export type CommitteePosition = 'agree' | 'disagree' | 'modify' | 'abstain';

export interface CommitteeTurn {
    role: CommitteeRole;
    agentId: string;
    round: number;            // 1-based; round 0 is the operator's prompt
    position: CommitteePosition;
    rationale: string;        // ≤ 2000 chars; cockpit truncates >280 with "…"
    confidence: number;       // 0..1; judges only; -1 sentinel for non-judges
    addendum?: {
        // Optional: a proposal patch suggesting how to amend the
        // current draft proposal. Critics use this most.
        proposal_patch?: any;
        // Optional: which prior turn this turn is responding to.
        // Helps the cockpit visualise the reply tree.
        in_reply_to?: string;
    };
}

export interface CommitteeVerdict {
    id: string;                          // UUID
    topicId: string;                     // FK to conversation_topics
    committeeId: string;                 // UUID
    finalProposal: string;
    finalConfidence: number;             // mean of last-round judge confidences
    consensus: 'reached' | 'capped' | 'aborted';
    stoppingReason: string;              // adaptive_stability | hard_cap | aborted
    rounds: number;
    dissentingOpinions: Array<{ agentId: string; position: CommitteePosition; rationale: string }>;
    participatingReceipts: string[];     // VerificationReceipt IDs if dispatched as Triad cycles
    issuedAt: number;
}
```

### 2.3 Schedule (who speaks when)

Round 1 always starts with the proponent set, in alphabetical agentId order. Round 2 is critics. Round 3+ is open — the bus chooses the next speaker by lowest most-recent-turn-timestamp among the role bucket whose turn it is in round-robin (proponent → critic → judge → repeat). Judges always close a round.

A judge's turn at the end of a round triggers the stop-check:

```
if round >= 6:                      stop hard_cap
if any participant offline ≥ 10s:   stop aborted_participant_offline
if confidence_mean(judges, round) - confidence_mean(judges, round-1)  < ε
   AND majority_position(judges, round) ∈ {'agree', 'modify'}:
                                    stop adaptive_stability
```

`ε` defaults to **0.05**. Hard cap defaults to **6 rounds**. Both configurable via WORKFLOW.md's new `committee:` block:

```yaml
committee:
  stability_epsilon: 0.05
  hard_cap_rounds: 6
  homogeneous_provider_block: true
```

### 2.4 Heterogeneous-provider guard

Read arXiv 2603.28488 if you haven't already — homogeneous panels collude on wrong answers with high confidence. **Reject committee creation requests** where every participant shares a `provider` string with HTTP 422:

```json
{
  "error": "homogeneous_committee_rejected",
  "rationale": "Diversity of base models is load-bearing for Committee soundness. arXiv 2603.28488 shows homogeneous panels converge on wrong answers with high confidence.",
  "diversity_score": 0.0,
  "providers_seen": ["OpenAI · Codex CLI"],
  "override_flag": "allow_homogeneous"
}
```

The override flag is for tests only (a unit test that doesn't care about diversity should be able to flip it). Document the flag in `docs/CHAIRS.md` as **never to be used in production**.

`diversity_score` = `unique(providers) / total_participants`. A committee of three providers gets 1.0; a homogeneous one gets 0.33-ish. Below 0.6 is borderline — issue a warning header `X-Diversity-Warning: low_diversity:0.4` but allow.

### 2.5 ChairBridge integration

When a participant has a live chair beacon (`ChairRegistry.get(agentId)?.status === 'online'`), the committee invokes `ChairBridgeProvider` to dispatch the turn to the real agent through `inboxUrl`. Otherwise, fall back to `StubMarkovProvider` exactly as the conversation bus already does.

**One subtle invariant:** the committee must NOT block waiting for an offline chair. The schedule above terminates round if any participant has been offline for ≥ 10 s. The 10 s window is the same as the chair-beacon `offlineMs` default — they are deliberately aligned.

### 2.6 Persistence

Three new SQLite tables in `MeshOrchestrator.memoryDb`:

```sql
CREATE TABLE IF NOT EXISTS committees (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    consensus TEXT,           -- 'reached' | 'capped' | 'aborted' | NULL while open
    final_proposal TEXT,
    final_confidence REAL,
    rounds INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(topic_id) REFERENCES conversation_topics(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS committee_turns (
    id TEXT PRIMARY KEY,
    committee_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    role TEXT NOT NULL,         -- 'proponent' | 'critic' | 'judge'
    agent_id TEXT NOT NULL,
    position TEXT NOT NULL,
    rationale TEXT NOT NULL,
    confidence REAL NOT NULL,
    addendum TEXT,              -- JSON
    emitted_at INTEGER NOT NULL,
    FOREIGN KEY(committee_id) REFERENCES committees(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_committee_turns_committee ON committee_turns(committee_id, round);
```

The conversation_messages table already exists — committee turns are *additionally* mirrored to it so the existing Theater MessageList renders them without code changes. The mirror row's `content` field is the `rationale`; the structured fields go into the new tables.

### 2.7 HTTP surface

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/api/v1/committees` | POST | `{ topicId?, title, proponents[], critics[], judges[], proposal_seed }` | `{ id, topicId, schedule }` |
| `/api/v1/committees/:id` | GET | — | committee + last 50 turns |
| `/api/v1/committees/:id/abort` | POST | `{ reason }` | `{ aborted: true }` |

`proposal_seed` is the operator's starting question. If `topicId` is absent, a new conversation topic is created and the committee binds to it; if present, the existing topic must be active.

Body cap: 16 KiB. Headers + structure mirror the chair endpoints' validation pattern verbatim.

### 2.8 Bus events (new)

| Type | Top-level fields | Cockpit reaction |
|---|---|---|
| `committee_opened` | `committeeId, topicId, schedule, providers` | Drawer slides in showing roster & schedule |
| `committee_turn` | `committeeId, turn: CommitteeTurn` | New CommitteeTurnCard on the timeline |
| `committee_stop_check` | `committeeId, round, judgeConfidenceMean, deltaFromPrev, decision` | Updates the stop-condition meter in the drawer |
| `committee_verdict` | `committeeId, verdict: CommitteeVerdict` | Verdict card replaces the schedule; persists to recent-verdicts list |

All four broadcast flat (no `.data` wrapper), matching the existing convention for `conversation_*` events.

### 2.9 Cockpit changes

Day 4 already ships `ConvenePanel`. Day 5 extends it:

- A "Convene as Committee" toggle. When on, the participant chip grid splits into three columns (Proponents / Critics / Judges). At least one chip per column; total ≤ 9; diversity-warning chip appears when score < 0.6.
- A new `CommitteeDrawer.tsx` in `theater/`. Slides in from the right when a committee is open; renders schedule, round counter, judge-confidence sparkline, dissenting-opinions list, verdict card.
- A new `CommitteeTurnCard.tsx`. Renders inside MessageList. Tagged by role colour: proponent = command-accent, critic = amber, judge = emerald. `position` rendered as a chip; `confidence` rendered as a 0–100% pill (judges only).

### 2.10 Test matrix (Day 5)

Minimum 8 vitest cases for `Committee.test.ts`:

1. `creates a committee with three distinct providers`
2. `rejects a homogeneous committee with HTTP 422 and the documented payload`
3. `accepts a homogeneous committee when allow_homogeneous override is set`
4. `stop-on-stability at delta < ε for K rounds`
5. `stop-on-hard-cap at round 6 regardless of stability`
6. `aborts if any participant chair goes offline ≥ 10s`
7. `verdict persists with all dissenting opinions captured`
8. `mirrors committee turns into conversation_messages for transcript render`

Plus 2 cockpit component cases in `CommitteeDrawer.spec.tsx`:

1. Drawer opens on `committee_opened` event
2. Verdict card renders dissenting opinions distinctly from the consensus

Plus 1 e2e in `integration.e2e.test.ts`:

1. POST `/api/v1/committees` → watch WS frames → see `committee_opened` → `committee_turn` × N → `committee_verdict` within 15 seconds.

### 2.11 Performance budgets

- First `committee_turn` emitted within 500 ms of `committee_opened` (StubMarkov provider). Real LLM bridge will be slower; that's fine for now.
- Memory: each committee adds at most 50 KB of in-memory state (50 turns × 1 KB rationale cap).
- The cockpit pressure-valve must not exceed 6 ms / tick during a 6-round committee with 9 participants (worst case). Profile in dev mode if anything feels janky.

### 2.12 Failure modes (must be tested or documented)

| Failure | Behaviour | Test coverage |
|---|---|---|
| Participant chair drops mid-round | Round completes without them; abort if their absence breaches min-per-role | unit |
| StubMarkov takes > 5 s on a turn | Turn emits anyway (no real timeout — providers always return) | implicit |
| Two committees on the same topicId | Reject second with 409 conflict | unit |
| Adaptive stability fires AT round 1 (no prior delta) | Always continue to round 2 minimum | unit |
| Operator hits `/abort` mid-round | Bus emits `committee_verdict` with consensus='aborted' immediately | unit |

---

## 3. Day 6 — A2A v1.2 adapter

### 3.1 Why this matters

Kovael is currently an island. Day 6 is where it learns to handshake with other A2A-speaking meshes — another Kovael instance, a third-party agent platform, a research tool. The handshake has to be **cryptographically verifiable** (signed Agent Card) so the receiver of our card can trust the claims it makes about what we can do.

The A2A v1.2 spec is dense. The portion you need to implement is small:

1. `GET /.well-known/agent.json` returning a JWS-signed Agent Card.
2. `GET /.well-known/jwks.json` returning the public key for verification.
3. `POST /a2a/task/sendSubscribe` accepting an A2A task envelope and returning an SSE stream of `task.status` + `task.artifact` events.
4. Internal: every inbound A2A task creates a synthetic chair claim so the cockpit shows it the same as any other chair's activity.

### 3.2 Library choice

Use **`jose`** (`npm i jose`). It's the de-facto-standard JOSE library, audited, small, ES256 / Ed25519 capable, no transitive deps. Documented in PHOENIX-1 §6 as a pre-approved dep.

ES256 over Ed25519 because the A2A v1.2 spec's interop matrix shows ES256 as the lowest-common-denominator algorithm; Ed25519 is allowed but not universally implemented in v1.2 client libraries. Optimise for compatibility, not key size.

### 3.3 Key handling

```
.kovael/a2a/
  private.jwk          (mode 0600, gitignored)
  public.jwk           (mode 0644, gitignored — published via /.well-known/jwks.json)
  rotation.log         (JSONL audit trail of rotations)
```

On first boot:

```ts
if (!fs.existsSync('.kovael/a2a/private.jwk')) {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privJwk = await exportJWK(privateKey);
    privJwk.kid = randomUUID();
    privJwk.alg = 'ES256';
    privJwk.use = 'sig';
    // Persist atomically (write to tmp, fsync, rename) so a crash mid-write
    // doesn't leave us with a half-key file.
    fs.mkdirSync('.kovael/a2a', { recursive: true, mode: 0o700 });
    fs.writeFileSync('.kovael/a2a/private.jwk.tmp', JSON.stringify(privJwk), { mode: 0o600 });
    fs.renameSync('.kovael/a2a/private.jwk.tmp', '.kovael/a2a/private.jwk');
    // Same for public…
}
```

Verify `.kovael/` stays gitignored: `git check-ignore .kovael/a2a/private.jwk` must return exit 0 in a unit test.

**Rotation procedure** (document in SECURITY.md):

1. Operator runs `node scripts/a2a-rotate-key.mjs` which generates a new keypair, writes new `private.jwk` and `public.jwk`, but ALSO writes `public-previous.jwk` so the JWKS endpoint serves both for a grace period.
2. After ≥ 24 hours (or operator's choice), they delete `public-previous.jwk`.
3. Every rotation appends a line to `rotation.log` with timestamp, old kid, new kid, operator-supplied reason.
4. Agent Cards minted after step 1 are signed with the new key; old signed cards remain verifiable until step 3.

### 3.4 Agent Card schema

```json
{
  "schema_version": "a2a-1.2",
  "name": "Kovael Sovereign Agentic Mesh",
  "description": "Triad-based agent orchestrator with chair beacon protocol and live committee deliberation.",
  "version": "0.1.0",
  "url": "http://localhost:8080",
  "icon_url": "/agents/nyx-antigravity.png",
  "authentication": {
    "schemes": ["public"]
  },
  "capabilities": {
    "streaming": true,
    "push_notifications": false,
    "state_transition_history": true
  },
  "skills": [
    {
      "id": "triad.run",
      "name": "Run a Triad cycle",
      "description": "Architect → Operator → Verifier loop. Emits a ZTNP-signed VerificationReceipt.",
      "input_modes": ["text"],
      "output_modes": ["text", "json"]
    },
    {
      "id": "committee.convene",
      "name": "Convene a deliberation committee",
      "description": "Heterogeneous-provider committee with adaptive-stability stopping.",
      "input_modes": ["text"],
      "output_modes": ["text", "json"]
    }
  ]
}
```

The whole thing gets wrapped as a JWS — flattened JSON serialization (RFC 7515 §7.2.2):

```json
{
  "payload": "<base64url(card_json)>",
  "protected": "<base64url({alg:'ES256',kid:'…'})>",
  "signature": "<base64url(signature)>"
}
```

Served from `GET /.well-known/agent.json` with `Content-Type: application/jose+json`.

### 3.5 JWKS endpoint

```
GET /.well-known/jwks.json
Content-Type: application/json

{
  "keys": [
    { "kty":"EC","crv":"P-256","x":"…","y":"…","kid":"…","alg":"ES256","use":"sig" },
    // public-previous.jwk if present (rotation grace window)
  ]
}
```

The card's `protected` header carries `kid`; the verifying client picks the matching key from the JWKS by `kid` match.

### 3.6 Inbound task bridge

```
POST /a2a/task/sendSubscribe
Content-Type: application/json
Accept: text/event-stream

Body:
{
  "task_id": "<client-supplied UUID>",
  "skill_id": "triad.run",
  "input": { "type": "text", "value": "design a 100k-node retry policy" },
  "metadata": {
    "origin": "https://partner-mesh.example/.well-known/agent.json",
    "operator": "anonymous"   // currently the only allowed value
  }
}
```

Server response (SSE):

```
event: task.status
data: {"task_id":"…","state":"queued","timestamp":"…"}

event: task.status
data: {"task_id":"…","state":"working","timestamp":"…","node":"nyx-antigravity"}

event: task.artifact
data: {"task_id":"…","artifact":{"type":"text","mime":"text/plain","data":"…"},"index":0}

event: task.status
data: {"task_id":"…","state":"finished","timestamp":"…","receipt_id":"…"}
```

States: `queued` → `working` → `finished` | `failed` | `cancelled` | `blocked`. (`blocked` is for future human-in-the-loop work; not implemented this week.)

### 3.7 Synthetic chair claim

When an inbound A2A task arrives, **create a chair claim on `a2a-${sha256(origin).slice(0,8)}`** in `ChairRegistry` so the cockpit's existing presence UI shows the bridged task as a live participant. The synthetic claim:

- `agentId`: `a2a-<origin_hash>`
- `provider`: extracted from `metadata.origin` (e.g. `"partner-mesh.example"`)
- `capabilities`: derived from the inbound `skill_id`
- `trustTier`: 4 (new tier — "external, signature-verified")
- `inboxUrl`: the partner's `/a2a/task/sendSubscribe` if we ever want to dispatch *back* to them

When the inbound task `finished` or `failed`, **release the synthetic chair claim immediately**. Trust posture: external chairs are short-lived per-task; not long-lived presence.

### 3.8 Allow-list

Add `a2a:` block to `WORKFLOW.md`:

```yaml
a2a:
  inbound_allow_origins:
    - "*"                   # development default; tighten before any external exposure
  inbound_rate_limit:
    requests_per_minute: 30
    burst: 5
  inbound_body_cap_bytes: 16384
```

The allow-list is checked against `metadata.origin`. `*` accepts all; specific origins are matched as literal hostnames. Rate limit is per-origin sliding window; reuse `RateLimitTracker` shape.

### 3.9 Cockpit additions

- **A2A Inbox panel** under the Theater tab. Lists recent inbound tasks with a `Verified ✓` / `Unsigned ✗` badge (signature-verified) and a chip showing the synthetic chair agentId.
- **Outbound discovery panel** — out of scope this week. Note it as a follow-up.

### 3.10 Test matrix (Day 6)

`A2AAdapter.test.ts`:

1. `serves a JWS-signed Agent Card with correct kid`
2. `verifies the published JWKS contains a matching key`
3. `key rotation: dual-serves current and previous public keys`
4. `accepts a well-formed inbound task and emits SSE status events in order`
5. `rejects malformed task body with 400 (missing skill_id)`
6. `rejects oversized body with 413 (above 16 KiB)`
7. `rejects disallowed origin with 403`
8. `respects rate limit per origin`
9. `bridges to injectTask and synthesizes a chair claim`
10. `releases the synthetic chair claim on task completion`

Plus a live curl-and-jose-verify demo in the PR description.

### 3.11 SECURITY.md additions

Add a section titled "A2A signing key management" covering:

- Where the key lives, what mode it ships with
- The rotation procedure (commands, grace window, rotation log)
- The trust statement: "Kovael's Agent Card signature attests to the cards's contents at signing time. It does not attest to the freshness of the listed skills, the cost of running them, or any business-level claims about the operator."
- The allow-list mechanism + how to tighten it for production

### 3.12 Failure modes

| Failure | Behaviour |
|---|---|
| Inbound JSON fails JWS validation upstream | Not your concern — that's the peer's responsibility |
| SSE client disconnects mid-stream | Triad cycle continues; receipt persists; no error logged |
| Inbound task references unknown skill_id | 400 with `{ error: "unknown_skill_id", supported: ["triad.run", "committee.convene"] }` |
| Partner mesh sends conflicting task_id (already in flight) | 409 conflict; do NOT dispatch twice |
| `.kovael/a2a/private.jwk` deleted at runtime | Server stays up; next card request 503s with `key_unavailable`; key regenerates on restart |

---

## 4. Day 7 — OpenTelemetry GenAI + polish + ship

### 4.1 Why now, not earlier

Days 5 and 6 introduce primitives with deep cross-bus message flows. Without OTel you'd have to read three different ndjson streams to follow one cycle. **Day 7 is the day every prior surface gets the same trace tree.** Implement it last so you instrument what actually exists rather than what you imagined.

### 4.2 Span hierarchy (canonical)

```
cycle.run                                              [root, kind=internal]
  ├── triad.architect                                  [kind=internal]
  │     └── gen_ai.model                               [kind=client, gen_ai.system=<provider>]
  │           gen_ai.request.model=<id>
  │           gen_ai.usage.input_tokens=<int>
  │           gen_ai.usage.output_tokens=<int>
  │           gen_ai.response.finish_reason=<string>
  ├── triad.operator                                   [kind=internal]
  │     └── tool.call                                  [kind=client] (1..N)
  ├── triad.verifier                                   [kind=internal]
  │     └── gen_ai.model                               [kind=client]
  └── receipt.issue                                    [kind=producer]
```

For a committee cycle, swap the architect span for:

```
cycle.run
  └── committee.convene                                [kind=internal]
        ├── committee.turn (round=1, role=proponent)
        │     └── gen_ai.model
        ├── committee.turn (round=1, role=critic)
        │     └── gen_ai.model
        ├── committee.turn (round=1, role=judge)
        │     └── gen_ai.model
        ├── committee.stop_check (round=1)
        └── committee.verdict
```

For an A2A inbound task, the root is `a2a.task.handle`, with one child `cycle.run` (or `committee.convene`). The A2A peer's `traceparent` header is **propagated** as the parent span context, so the trace stitches across mesh boundaries.

### 4.3 Attributes (OTel GenAI Semantic Conventions, exited experimental Q1 2026)

| Attribute | Where | Value |
|---|---|---|
| `gen_ai.system` | every model span | provider string (e.g. `"anthropic"`, `"openai-codex"`, `"google-antigravity"`) |
| `gen_ai.request.model` | every model span | model id |
| `gen_ai.usage.input_tokens` | every model span | from receipt or live count |
| `gen_ai.usage.output_tokens` | every model span | same |
| `gen_ai.response.finish_reason` | model span end | `stop` \| `length` \| `tool_calls` \| `error` |
| `gen_ai.conversation.id` | conversation spans | topicId |
| `gen_ai.conversation.role` | conversation spans | participant role |
| `kovael.cycle.id` | every span in a cycle | cycleId (custom namespace, OK per OTel) |
| `kovael.task_hash` | every span in a cycle | the cycle's task hash |
| `kovael.chair.session_id` | spans dispatched via a chair | chair session id |

### 4.4 Persistence + export

- **In-memory ring buffer** of last 1000 cycles, indexed by cycleId. This is the default.
- **OTLP HTTP exporter** when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Honor `OTEL_EXPORTER_OTLP_HEADERS` for auth.
- **Persistence to disk** is out of scope this week; revisit when traces need to survive restarts.

### 4.5 HTTP surface

```
GET /api/v1/traces/:cycleId        → JSON span tree
GET /api/v1/traces?limit=20        → list of recent cycleIds + summary metadata
```

The span tree response is the OTLP-spec span format (`Span` resource + spans array), so existing OTel-aware UIs can render it. Don't invent a custom format.

### 4.6 Cross-bus traceparent propagation

This is the subtle and load-bearing part. **Every cross-bus envelope** must carry a `traceparent` field:

- `conversation_message_delta` → traceparent = current span's context
- `committee_turn` → same
- `chair_event` → traceparent of whatever cycle (if any) triggered the event
- `a2a/task/sendSubscribe` SSE → traceparent inherited from inbound request

Add a `traceparent?: string` field to each frame type that doesn't already have one. The cockpit doesn't render it; the trace view reconstructs the tree from it.

### 4.7 Cockpit Trace view

Two layouts:

1. **Span tree** (left pane) — collapsible nested list. Click a span to populate the right pane.
2. **Waterfall** (right pane) — Gantt-style horizontal bars, one per span, sorted by start time. Click a bar to scroll the tree to it.

Components under `theater/trace/`:

- `TraceView.tsx` — root
- `SpanTree.tsx` — left
- `Waterfall.tsx` — right
- `SpanAttributesPanel.tsx` — bottom pane

Use plain HTML + CSS Grid; no new charting dep. Span bars are absolutely positioned divs with width = `(span.end - span.start) / total_duration`. Color by `kind` (internal=accent, client=cyan, producer=emerald, consumer=violet).

### 4.8 Polish punch list (Day 7 afternoon)

- Remove the legacy `inter_agent_message` shim. The static dialogue arrays in `MeshOrchestrator.ts` (technicalDialogues / interestsDialogues) are dead code now that `ConversationBus` exists. Delete them. Delete the toggle + mode-switch handlers. Delete the corresponding cockpit BANTER UI.
- Update `WORKFLOW.md` with `committee:`, `a2a:`, and `tracing:` blocks.
- Update `docs/CHAIRS.md`'s "8 integration recipes" to mention `/api/v1/chairs/reply` (the inbox endpoint chairs POST to when the conversation bus asks them for a turn).
- Update `StatusLegend` with entries for: streaming delta cursor, committee stop card, A2A verified badge, trace span colors.
- Add a `?tour=phoenix` query param that auto-opens a 6-step popover tour through the new features (committee toggle → committee drawer → A2A inbox → trace tab → trace span → finish). Use the existing Tailwind primitives; no new tour library.

### 4.9 Test matrix (Day 7)

`Tracing.test.ts`:

1. `cycle.run span captures input/output token attributes`
2. `committee.convene parent span contains one child per round-role combination`
3. `traceparent propagates through conversation_message_delta`
4. `OTLP exporter emits OTLP-compliant JSON when env var is set`
5. `ring buffer evicts to maintain 1000-cycle cap`
6. `GET /api/v1/traces/:id returns 404 for unknown cycleId`

Plus the smoke: `scripts/theater-smoke.mjs` plus the new A2A smoke must produce one **connected** trace tree visible via `/api/v1/traces/:cycleId`.

### 4.10 Performance budgets

- OTel instrumentation overhead < 5 % wall-clock on a Triad cycle (measure with a benchmark or two timings).
- Ring buffer access (GET `/api/v1/traces`) responds in < 50 ms for 1000 entries.

---

## 5. Cross-cutting concerns

### 5.1 Architecture Decision Records

Add `docs/adr/`. One ADR per significant decision in Days 5–7. Format:

```
# ADR-NNNN — <title>

Status: accepted | superseded by ADR-XXXX
Date: YYYY-MM-DD
Context: …
Decision: …
Consequences: …
Alternatives considered: …
```

Mandatory ADRs:

- `ADR-0001` — Committee runs on ConversationBus, not Triad
- `ADR-0002` — ES256 over Ed25519 for A2A Agent Card signing
- `ADR-0003` — Synthetic chair claims for inbound A2A tasks (vs separate "external participant" concept)
- `ADR-0004` — In-memory ring buffer for traces (vs SQLite persistence)
- `ADR-0005` — vi.stubGlobal pattern for test global mocking (cross-link PR #18 follow-up)

### 5.2 Error budget

- New endpoints (`/api/v1/committees`, `/a2a/*`, `/api/v1/traces/*`): aim for ≤ 0.1 % 5xx on a 1-hour soak. We don't currently have a soak harness; create `scripts/soak.mjs` that hits each endpoint at 5 RPS for 60 seconds and prints the 4xx/5xx counts.

### 5.3 SLOs

| Operation | p50 | p99 |
|---|---|---|
| `/api/v1/committees` POST | 50 ms | 200 ms |
| `/.well-known/agent.json` GET | 20 ms | 80 ms |
| `/a2a/task/sendSubscribe` first SSE event | 100 ms | 400 ms |
| `/api/v1/traces/:id` GET | 50 ms | 150 ms |

These are aspirational, not hard gates — record them so future regressions are visible.

### 5.4 Performance harness

`scripts/perf.mjs` boots an orchestrator, fires N requests at each endpoint, prints a histogram. Should run in < 60 seconds for a smoke run. Wire it as an npm script: `npm run perf` (root).

### 5.5 Backwards-compatibility shims you may delete

- The static dialogue arrays in `MeshOrchestrator.ts` — delete on Day 7 (see polish list).
- The legacy `nyx-cli` AgentCards entry described as "Anthropic / Gemini CLI (legacy alias)" — keep for now; routing still references it. Plan to consolidate into `nyx-claude-code` in a separate ticket post-PHOENIX.

### 5.6 Things that look tempting but are out of scope

- A web search MCP tool. Sound idea, wrong week.
- Voice synthesis for Shaev. Wrong week.
- Real LLM API key wiring. The `ChairBridgeProvider` is the integration point; key handling is its own ticket.
- A graph runtime (LangGraph/pgraph). The Triad stays the orchestrator.
- Replacing Zustand with anything. It's fine.

---

## 6. Acceptance criteria — overall

Beyond the per-day criteria, PHOENIX-DEEP ships when:

1. **The original brief's North Star Demo plays end-to-end** (90-second screen recording): nine smiling neko portraits → user types `@Nyx-Antigravity @Shaev @Nyx-Codex convene on "…"` → streaming debate → consensus card → trace span tree → external curl returns JWS-signed card.
2. **Suite count ≥ 175** vitest cases (currently 153; expect +20-25 from committee + A2A + tracing tests).
3. **All five CI checks green** on each PR before requesting reviewers (typecheck-frontend including new tsconfig.test.json gate; typecheck-backend; vitest; forbidden strings; TruffleHog).
4. **Backward compatibility**: `kovael-chair --probe` on a stranger's CLI still works. The chair beacon protocol shipped in PR #14 is frozen; you may extend it (added `inboxUrl` is fine), not break it.
5. **No regression in pressure-valve cadence**: 100 ms tick rate holds at 9-participant committee + active conversation stream + 30 RPS A2A inbound.

---

## 7. Daily handoff format

End of each day, append to `.notes/PHOENIX_LOG.md` (gitignored):

```
## Day N — YYYY-MM-DD

### Shipped
- commit-hash · one-line summary

### Tests added
N cases across F files (running total: T)

### Open questions for operator
- …

### Tomorrow's hot path
- the single most important next step in plain English

### Gotchas discovered
- (any sharp edges you hit so the next dev doesn't re-step on them)
```

The operator reads this before bed. Make it scannable.

---

## 8. If you get stuck

Ask in the log. Concrete questions, with a proposed answer when you have one:

> Q: Should committee_stop_check fire BEFORE judges' turn ends or AFTER?
> Proposed: AFTER — fire on the last judge's turn-end so the operator
> sees the stop-decision as a separate event for telemetry.
> Blocker? No — I'll implement my proposed answer and revisit if you
> push back.

That format gives the operator a 60-second decision. Yes/no, or "go with your proposal," or "no, do X instead."

---

## 9. A personal note

Days 1–4 demonstrated you can ship beautiful work fast. Days 5–7 demand the same speed plus a higher rigor floor: signed keys, cryptographic guarantees, telemetry that holds across process boundaries. The temptation will be to ship and iterate; resist on Day 6 specifically. **The A2A signature surface is the only place in this codebase where a mistake leaks externally.** Take the extra hour to verify the JWS round-trip with the `jose` CLI from a separate terminal before you mark Day 6's PR ready.

When the verdict card lights up in the Theater at the end of a real three-provider committee, render a screenshot and drop it into the PR description. That's the picture we want.

— Nyx-Claude-Code

> *Written with full attention.*
