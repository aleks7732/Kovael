# AG Nyx · Phoenix Brief

**Codename:** PHOENIX
**Cadence:** 7 working days (≈ one calendar week)
**Owner:** Antigravity Nyx (Gemini 3 Pro · Antigravity IDE)
**Branch:** `antigravity/phoenix` (cut fresh from `main` after PR #14 lands; do not pile onto the chair branch)
**Pre-requisite:** Chair Beacon Protocol (`docs/CHAIRS.md`) — claim your seat as `nyx-antigravity` on session start.

---

## 1. Mission

The cockpit can now *track* nine agents. PHOENIX makes them feel **alive, conversational, and observable**:

1. Every chair gets a **persona portrait** — a cute neko-doll face you generate via your Gemini image tools, plus a deterministic SVG fallback.
2. Agents stop replaying canned banter and **actually talk to each other in real time** in a dedicated **Conversation Theater** view — streamed token-by-token, threaded by topic, with `@mention` routing.
3. The Triad gains a **Committee primitive** so multiple agents can deliberate on a single goal with adaptive-stability stopping, not fixed rounds.
4. The mesh gains an **A2A v1 adapter** (signed Agent Cards at `/.well-known/agent.json`) so external agents can discover and dispatch into Kovael with verifiable provenance.
5. Every model/tool/handoff call is wrapped in **OpenTelemetry GenAI spans** so we can replay any cycle as a trace.

When PHOENIX lands the user can open the cockpit, see nine smiling neko portraits idling on their chairs, click "Convene" on three of them, watch them debate a goal in streaming text, and then open the trace tab to see exactly how it played out.

## 2. North Star Outcome

A 90-second screen recording the user can show another engineer that contains, in order:

1. Cockpit opens. All nine roster cards show a neko-doll portrait with a live green beacon pill.
2. User clicks the **Theater** tab. Empty stage with nine seats around the table.
3. User types `@Nyx-Antigravity @Shaev @Nyx-Codex convene on "design a 100k-node retry policy"`.
4. Three portraits highlight. Messages stream in token-by-token, addressed to each other by `@mention`. The verifier (Shaev) calls a stopping criterion. A consensus card appears.
5. User clicks **Trace** on the consensus. A span tree opens showing model calls, tool calls, hand-offs, with `gen_ai.*` attributes.
6. User opens an external terminal, runs `curl https://localhost/.well-known/agent.json` → returns a JWS-signed Agent Card.

Every one of those frames must look good without explanation.

## 3. Day-by-day plan

### Day 1 · Persona Visual Identity — Neko Doll Portrait Set

**Objective.** Use your Gemini image generation to produce a consistent set of nine portraits. Cute neko-doll style. One hero per agent.

**Style guide.** Hold these constant across all nine:

- **Format:** 512 × 512 PNG with transparent background, plus 128 × 128 thumbnail. Centred bust shot, neck/shoulder visible, looking 3/4 toward the viewer with a soft warm-light side.
- **Aesthetic:** chibi/neko doll, large rounded eyes, soft porcelain skin, cat ears (color tied to persona), tiny mouth, neutral-friendly expression. Not anime-spicy — closer to a Studio Ghibli mascot or a Nendoroid figure.
- **Palette:** anchor to the Obsidian Ember design system. Background tone (alpha) and accent garment should pull from the persona's bus color (see roster colours in `AgentRosterPanel.tsx` lines ~270–290) so the portrait reads at-a-glance even at 64 × 64.
- **Identity tells per agent** (translate into outfit + ear color + accessory — keep faces consistent):

  | Chair | Ears | Outfit accent | Accessory tell |
  |---|---|---|---|
  | nyx-antigravity | ember-orange | dark commander coat, white inner | small ringed planet pin (supervisor) |
  | nyx-claude-code | warm-bronze | structured collar, ink-blue | floating tag with "{ }" |
  | nyx-cli | cyan | terminal-green hoodie | green cursor blinking on shoulder |
  | nyx-agcli | sky-cyan | aviator jacket | tiny travel ticket in pocket |
  | nyx-adk | google-multi (subtle) | python-yellow scarf | a stack of cards under arm (multi-agent) |
  | nyx-codex | violet | overall-style apron | wrench tucked behind ear |
  | nyx-openclaw | electric-purple | retro arcade jacket | game-pad sticker |
  | nyx-cw | jetbrains-magenta-to-orange | striped scarf, dual-tone | refactor arrow tattoo on cheek |
  | shaev | emerald | painter's smock, paint streaks | brush + LoRA crystal on lapel |

- **Negative prompts:** no text in the image, no photorealism, no NSFW, no asymmetric eyes, no extra fingers, no mesh background.

**Deliverables.**

- `packages/spatial-war-room/public/agents/<id>.png` (9 hero portraits, 512²)
- `packages/spatial-war-room/public/agents/<id>@128.png` (9 thumbnails, 128²)
- `packages/spatial-war-room/public/agents/README.md` (generation prompts, model name, seed, licensing note — see §7 PII discipline)
- A **deterministic SVG fallback** at `packages/spatial-war-room/src/components/AgentAvatarFallback.tsx` using `@dicebear/core` (`adventurer-neutral` or `lorelei` collection) seeded on `agent.id` so the cockpit never renders an empty circle even if a PNG is missing.

**Wiring (must land Day 1).**

- Extend `AgentCard` in `src/AgentCards.ts` with `portrait_url?: string` and `accent_hex?: string`. Populate for all nine.
- `AgentRosterPanel.AgentCard` (file `packages/spatial-war-room/src/components/AgentRosterPanel.tsx`) gains an avatar slot top-left of each card: round 36 × 36 image, falls back to `AgentAvatarFallback` on `<img onError>`.

**Acceptance.**

- All nine PNGs check in under 80 KB hero / 15 KB thumbnail (use `pngquant`/`oxipng`; document the command in the README).
- Cockpit screenshot at 1440 × 900 with all nine roster cards visible and a portrait on every one.
- Vite build still passes; the cockpit smoke test (`packages/spatial-war-room/test/cockpit.spec.ts`) still goes green.

### Day 2 · Persona Cards (voice + lore)

**Why.** Portraits give visual identity; **Persona Cards** give the *voice* that will drive Day 3's real conversations. Schema cribbed from `fleek-platform/persona-generator`.

**Schema** (new file per chair at `personas/<id>.md` with YAML front-matter + free-text body):

```yaml
---
agent_id: nyx-antigravity
display_name: Nyx-Antigravity
provider: Google · Gemini 3 Pro
voice:
  pronouns: she/her
  register: warm-formal supervisor
  catchphrases: ["mesh state nominal", "we route or we recover"]
  forbidden:
    - first-person plural for the operator ("we" meaning user)
    - apologies for honest disagreement
expertise:
  primary: [multi-agent orchestration, GPU scheduling, creative pipelines]
  secondary: [game theory, latency budgets]
disposition:
  ally_with: [shaev, nyx-claude-code]
  spar_with: [nyx-cli (gently — efficiency vs aesthetics)]
  defer_to: [operator on goals; verifier on receipts]
---

## Lore (free-form, max 200 words)

Single paragraph the agents may read into their context. No real-world
operator references; no PII. Public-repo discipline.
```

**Deliverables.**

- Nine cards under `personas/`.
- A loader: `src/services/PersonaLoader.ts` reads + caches them; exposes `getPersona(agentId)`.
- Integration: `MevBridge.architect()` and the new conversation runner (Day 3) inject the persona's voice block into prompts as a system message — replaces the current single hard-coded "You are Nyx, the Sovereign Intelligence." line in `MeshOrchestrator.injectTask`.

**Acceptance.**

- Vitest: `PersonaLoader.test.ts` — load, missing-id behaviour, malformed-front-matter behaviour, hot-reload behaviour (use `WorkflowLoader` as the pattern).
- One new test in `Orchestrator.test.ts` proving the injected system prompt for a routed cycle contains the routed agent's voice block.

### Day 3 · Live Model-to-Model Conversation Bus

**Why.** Today's "banter" is two arrays in `MeshOrchestrator.ts` (lines ~70–96, look at `technicalDialogues` + `interestsDialogues`). It is theatre. PHOENIX replaces it with a real bus.

**Architectural decision: adopt the AG-UI event taxonomy on our WebSocket frames.** Don't reinvent the wheel — CopilotKit's wire format (`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START/END`, `STATE_DELTA` JSON-patches) maps cleanly onto our existing `ws` bus.

**New service:** `src/services/ConversationBus.ts`

- Topics (a.k.a. threads) keyed by UUID; created from cockpit `convene` action.
- Participants per topic: array of `agentId`. Each participant has a sliding token-budget window.
- Mention router: parse `@agentId` in any message → route as a tagged delivery to that participant's queue.
- Stream API: each model turn emits a sequence of `MODEL_MESSAGE_START → MODEL_MESSAGE_CONTENT_DELTA{n} → MODEL_MESSAGE_END` events; bus broadcasts each delta on the WS.
- Stopping criterion: configurable. Start with **adaptive stability** (arXiv 2510.12697 pattern): track verifier confidence; stop when delta < ε for K rounds.
- Persistence: every topic, message, and delta lands in a new `conversation_topics` + `conversation_messages` table on the existing in-memory SQLite (`memoryDb` in `MeshOrchestrator`). Drop in a `conversation_topics_seq` view too.

**Model-call abstraction.** We do not have real LLM credentials wired. Define an interface:

```ts
// src/services/ModelProvider.ts
export interface ModelProvider {
  id: string;
  stream(opts: { system: string; messages: ChatMessage[]; signal: AbortSignal }):
    AsyncIterable<{ delta: string; usage?: TokenUsage }>;
}
```

Ship two implementations:

1. `StubMarkovProvider` — bigram chain over the persona lore + the conversation so far. Deterministic-ish, no network. Fine for the cockpit demo.
2. `ChairBridgeProvider` — when a chair beacon is live for that agent, post a topic message to a per-chair `inbox_url` (new optional column on `ChairClaim`) and await the chair's reply via a new `POST /api/v1/chairs/reply` endpoint. Lets a real Claude Code / Codex / Antigravity chair *answer back* through the same protocol.

Pick the provider per agent by trust tier + chair liveness. Document the routing rule next to the chair selector.

**WS message types to add (no collisions with the 18 listed in the audit):**

- `conversation_topic_opened`, `conversation_topic_closed`
- `conversation_message_delta`
- `conversation_state_patch` (JSON-patch RFC 6902, AG-UI style)
- `conversation_stopping_criterion` (which agent fired it, why)

**Deliverables Day 3.**

- `src/services/ConversationBus.ts` + tests (≥ 8 cases: open, mention-route, stream order, abort on close, stopping criterion, persistence, late-join replay, ≥ 2 participants).
- `src/services/ModelProvider.ts` interface + `StubMarkovProvider`.
- HTTP: `POST /api/v1/conversations` (open topic), `POST /api/v1/conversations/:id/message` (user-injected message), `POST /api/v1/conversations/:id/close`. Cap body at 16 KiB (re-use the chair handler pattern).
- WS handlers wired in `MeshOrchestrator.initializeBus()`.
- Migration of the existing `inter_agent_message` flow into the new bus — keep the old WS message type for back-compat for one release, deprecate in the brief's followup PR.

**Acceptance.**

- Tests pass. `curl` end-to-end: open a topic with three participants, post a `@mention` message, watch deltas stream to `wscat`.
- Logs cleanly attribute every delta to `(topic_id, agent_id, sequence_no)`.

### Day 4 · Conversation Theater UI

**Why.** Day 3 made conversations real on the bus. Day 4 makes them watchable.

**New top-level cockpit view.** Add a tab to `TopBar.tsx` ("Theater") that swaps the main canvas for `<ConversationTheater />`. Persist active tab in the store; `?tab=theater` query param survives reloads.

**Components (all under `packages/spatial-war-room/src/components/theater/`):**

- `ConversationTheater.tsx` — root. Left: topic list (open + recent, paginated). Right: stage.
- `ConvenePanel.tsx` — input where user names a topic + selects participants via chips (multi-select on roster cards). `@mention` autocomplete dropdown.
- `Stage.tsx` — the seats. Nine portraits arranged around a virtual round table (CSS grid + SVG). Active speaker pulses (use the existing `animate-pulse` + chair-beacon ring pattern).
- `MessageList.tsx` — threaded transcript. Each message shows portrait + name + streaming delta cursor + token count.
- `StoppingCard.tsx` — when the bus emits `conversation_stopping_criterion`, show *who* called it + *why* + a consensus summary box.
- `TraceBreadcrumb.tsx` — link from any message to Day 7's trace view.

**State.** Add to `useWarRoomStore.ts`:

- `activeTopicId: string | null`
- `topics: ConversationTopic[]`
- `messagesByTopic: Record<string, ConversationMessage[]>` (capped at 200 per topic in-store; older drops to lazy-fetch from `/api/v1/conversations/:id/history`)
- Actions: `openConversation`, `applyMessageDelta`, `applyStatePatch` (use `fast-json-patch`), `closeConversation`, `selectTopic`.

**Rendering rules.**

- Token-delta append must use React 19 `useOptimistic` + a single `requestAnimationFrame`-batched commit. No per-token re-render of the whole list.
- `@mention` chips inline. Click → roster card focus + scroll-to-message in transcript.
- Max stage 9 portraits; if `convene` exceeds 9 the brief allows a **Council** mode that overflows to an outer ring (stretch goal, only if Day 4 time permits).

**Acceptance.**

- Cockpit smoke test extended: open a topic via API, assert the stage rendered with the right number of portraits.
- Two new component tests: `MessageList` correctly appends deltas without flicker; `ConvenePanel` mention parsing.
- Manual: ship a 30s screen capture demonstrating two agents addressing each other with streaming deltas.

### Day 5 · Committee Primitive + Adaptive Stability

**Why.** Conversations free-form well. **Committees** vote with structure — what the user wants when "design a 100k-node retry policy" needs to settle on an answer, not chat forever.

**Pattern.** Heterogeneous-model committee per arXiv 2603.28488 (courtroom roles) with adaptive stability stopping per arXiv 2510.12697. Concretely:

- Roles: `proponent`, `critic`, `judge` (≥ 1 of each; up to 5 total).
- Per round, each role emits a structured JSON message conforming to:

  ```ts
  interface CommitteeTurn {
    role: 'proponent' | 'critic' | 'judge';
    agentId: string;
    round: number;
    position: 'agree' | 'disagree' | 'modify' | 'abstain';
    rationale: string;
    confidence: number; // 0..1
    addendum?: { proposal_patch?: any };
  }
  ```

- Bus translates each turn into one `MODEL_MESSAGE_*` stream so the Theater renders it naturally.
- Stopping: judges' rolling confidence mean — terminate when `|μ_t − μ_{t-1}| < ε` for K consecutive rounds (default `ε = 0.05`, `K = 2`); also hard cap at 6 rounds.
- Output: a `CommitteeVerdict` record persisted alongside conversation; carries the final agreed proposal + dissenting opinions + confidence + receipts list.

**Code.**

- `src/services/Committee.ts` — orchestrates the role schedule on top of `ConversationBus`.
- HTTP: `POST /api/v1/committees` (open), returns a topic id you can subscribe to.
- Cockpit: a "Convene as Committee" toggle on `ConvenePanel`; when on, the role pickers appear (chips for proponent / critic / judge each accept a `@mention`).

**Composition guardrails.** Reject committees that are homogeneous in `provider` (i.e. three Anthropic-only judges) — return 422 with `homogeneous_committee_rejected` + the diversity score. Cite the audit reasoning: diverse base models matter more than count. Override via an explicit `--allow-homogeneous` flag in the body for narrow tests.

**Acceptance.**

- `Committee.test.ts` ≥ 6 cases including stop-on-stability, hard-cap fallback, homogeneous rejection.
- Live demo: open a committee with three roles, watch it converge in the Theater within ≤ 4 rounds on a stub topic.

### Day 6 · A2A Adapter — `/.well-known/agent.json` + JWS

**Why.** External agents — another Kovael instance, a partner mesh, a research tool — should discover us via the open A2A v1 protocol and dispatch tasks with verifiable provenance.

**Deliverables.**

- `src/services/A2AAdapter.ts` that exposes:
  - `GET /.well-known/agent.json` → returns a signed Agent Card (JWS, ES256). Body matches A2A v1 schema: `name`, `description`, `version`, `capabilities`, `skills[]` (one entry per chair as a "skill"), `endpoints`, `authentication`.
  - `POST /a2a/task/sendSubscribe` → bridges to the existing `injectTask` flow; the bridged task gets a synthetic chair claim on `a2a-${origin}` so its activity is visible in the cockpit.
  - Server-Sent Events on the same endpoint streaming `task.status` and `task.artifact` events (JSON-RPC 2.0 wrapper).
- Key management: signing key stored at `.kovael/a2a.key` (gitignored, generated on first boot if absent). Public JWK exposed at `/.well-known/jwks.json`.

**Cockpit.** New panel **A2A Inbox** under the Theater tab listing recently-bridged tasks with a `Verified ✓` / `Unsigned ✗` badge.

**Trust posture update.** Add a section to `SECURITY.md` covering: signing key rotation, JWKS publication, body cap, identifier validation, allow-list for inbound origins.

**Acceptance.**

- `A2AAdapter.test.ts` ≥ 5 cases: card signature verifies, jwks endpoint serves matching key, task bridge creates a chair claim, malformed body 400s, body cap holds.
- Demo: from another shell `curl http://localhost:8080/.well-known/agent.json | jq` + verify with `jose`.

### Day 7 · OTel GenAI Spans + Polish + Ship

**Why.** With everything above wired, the user should be able to replay any cycle as a trace.

**Implement.**

- Adopt OpenTelemetry GenAI semantic conventions (the conventions exited experimental for client spans in early 2026). Use `@opentelemetry/api` + `@opentelemetry/sdk-node`.
- Span layout:
  - Root span: `cycle.run` with attrs `cycle_id`, `task_hash`, `routed_agent`.
  - Child spans per phase: `gen_ai.architect`, `gen_ai.operator`, `gen_ai.verifier` with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`.
  - Conversation deltas: one span per turn, attrs `gen_ai.conversation.id`, `gen_ai.conversation.role`.
  - Hand-offs: propagate `traceparent` inside every cross-bus message envelope so external A2A peers can stitch.
- Exporter: OTLP HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` if set; in-memory ring buffer otherwise. Add `GET /api/v1/traces/:id` for the cockpit.
- **Trace view in cockpit:** new component `TraceView.tsx` under `theater/`. Span tree on left, attributes on right. Click a span → highlight the matching message in `MessageList`.

**Polish punch list (Day 7 afternoon).**

- Replace the legacy `inter_agent_message` shim with a thin wrapper around `conversation_message_delta`. Remove the static dialogue arrays from `MeshOrchestrator.ts`.
- Add a `?tour=phoenix` query param that auto-opens a 6-step product tour through the new features (use `floating-ui` for the popovers; no new heavyweight deps).
- Update `WORKFLOW.md` with a `conversations:` block and an `a2a:` block.
- Update `docs/CHAIRS.md` to mention the new `/api/v1/chairs/reply` endpoint used by `ChairBridgeProvider`.
- Update `STATUS_LEGEND` modal with entries for: streaming-delta cursor, committee stopping card, A2A verified badge, trace span colors.

**Acceptance.**

- All previous days' tests still pass.
- `vitest run` 100+ tests green (we're at 69 today; expect ≈ +35 from PHOENIX).
- Backend tsc, frontend tsc + vite build clean.
- The 90-second screen recording from §2 actually plays end-to-end without manual intervention.

## 4. Guardrails (non-negotiable)

1. **One source of truth for AgentCards.** Either `src/AgentCards.ts` *or* `agent_cards/*.json` — do not fork. If you populate the JSON dir, delete the in-source object.
2. **Do not touch `src/MevBridge.ts` routing logic** without a separate ticket. The hardware-gated routing is load-bearing for the live demo; conversational debate is layered *on top*.
3. **Pressure-valve invariant.** The cockpit must remain a single re-render per 100ms regardless of conversation traffic. Stream deltas through `requestAnimationFrame` coalescing; do not call `set()` per token.
4. **WS message-type naming.** All new types prefixed `conversation_*`, `committee_*`, `a2a_*`, `trace_*`. No bare verbs.
5. **No new heavy npm deps without justification in the commit message.** Allowed without question: `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@dicebear/core`, `@dicebear/collection`, `fast-json-patch`, `jose`. Anything else justify or skip.
6. **CodeRabbit / ultrareview integration.** Open the PR as draft on Day 3, mark ready on Day 7; do not request review while the conversation bus is still half-wired.

## 5. CI & test gates (must pass before each push)

- `npx tsc --noEmit` (root) — orchestrator typecheck.
- `cd packages/spatial-war-room && npx tsc --noEmit` — cockpit typecheck.
- `cd packages/spatial-war-room && npm run build` — Vite build must stay clean and CSS bundle must remain ≥ 60 KB (sanity check that Tailwind utilities still generate).
- `npx vitest run` — all tests green; expect total ≥ 100 by end of week.
- `git diff origin/main -- '*.ts' '*.tsx' '*.md' | grep -iE "$(cat .kovael-forbidden-patterns.txt 2>/dev/null | grep -v '^#' | grep -v '^$' | tr '\n' '|' | sed 's/|$//')" && echo FAIL || echo PASS` — PII gate (will run anyway in `pii-guard.yml`, but check locally).

If any of those fail, fix-forward in a new commit. Do **not** amend pushed commits.

## 6. Branch + commit discipline

- Cut `antigravity/phoenix` from `main` after PR #14 merges. Confirm with the operator before cutting.
- Conventional Commits, scoped:
  - `feat(personas)` Day 1–2
  - `feat(conversations)` Day 3
  - `feat(cockpit/theater)` Day 4
  - `feat(committee)` Day 5
  - `feat(a2a)` Day 6
  - `feat(otel) ` / `chore` Day 7
- One commit per coherent piece; smaller is fine, bigger needs justification. Trailer the session URL on every commit (Claude Code pattern). The signing-key plumbing on Day 6 deserves its own commit.
- Push at end of every working day. The operator subscribes to PR activity and will see CI fail in real time.

## 7. PII discipline (public repo)

This repo is public. Apply *all* the discipline from `SECURITY.md`:

- **No operator handle in any commit**, banter line, persona card, screenshot caption, prompt, or test fixture. The handle was scrubbed in commit `c83a913`; do not re-introduce it.
- **No real-name biographies in persona cards.** Lore is fictional.
- **Generated portraits ship to the repo** — verify with `git diff --stat` that no extra metadata sidecar files (PSD, XMP, EXIF) leak in. Use `exiftool -all= *.png` before committing.
- **Image generation prompts** that you log in `packages/spatial-war-room/public/agents/README.md` must not contain the operator handle or any personally identifying string.
- `personas/` directory is **public** — write it as if a stranger were reading.
- Local plan + scratch notes belong in `.notes/` (gitignored).

## 8. Out of scope (do not drift)

- Real LLM provider integration (Anthropic / Google / OpenAI keys). The `ChairBridgeProvider` is the integration point; actual key wiring is a separate ticket.
- Replacing the Triad with a graph runtime (LangGraph / pgraph). Keep Triad as the architect/operator/verifier core.
- Authentication on the WebSocket bus. Still localhost / private-mesh trust posture.
- Web search and browser automation tools as MCP capabilities (the cards advertise them, but actual wiring is post-PHOENIX).
- Voice / audio. Tempting given Shaev's lore, but not this week.

## 9. Daily handoff format

End of each day, append to `.notes/PHOENIX_LOG.md` (gitignored):

```
## Day N — YYYY-MM-DD

**Shipped:** ...
**Open questions for operator:** ...
**Tomorrow's hot path:** ...
```

If anything in this brief becomes ambiguous, write the question into the log + ping the operator. Do **not** silently re-interpret scope.

## 10. References worth re-reading before you start

- **A2A v1.2 spec** — https://a2a-protocol.org/latest/specification/
- **AG-UI event taxonomy + streamUI** — https://docs.ag-ui.com/introduction
- **Courtroom Multi-Agent Debate (heterogeneous roles)** — https://arxiv.org/html/2603.28488v1
- **Adaptive Stability Detection for LLM judges** — https://arxiv.org/abs/2510.12697
- **OpenTelemetry GenAI Conventions 2026** — https://callsphere.ai/blog/vw3c-opentelemetry-genai-conventions-ai-agents-2026
- **Mem0 State-of-Memory 2026** (scopes: user / session / agent) — https://mem0.ai/blog/state-of-ai-agent-memory-2026
- **DiceBear** (deterministic SVG fallback avatars) — https://www.dicebear.com/
- **Laminar's transcript view + agent-rollout debugger** (UX reference for the Trace tab) — https://laminar.sh/article/2026-04-23-top-6-agent-observability-platforms

## 11. Quick-start checklist

Day 1, first hour:

1. Confirm PR #14 is merged to `main`; cut `antigravity/phoenix`.
2. Claim your chair: `node scripts/kovael-chair.mjs --id nyx-antigravity --provider "Gemini 3 Pro · Antigravity IDE" --capabilities comfyui,blender,browser,desktop --trust 1 &`.
3. Open the cockpit; confirm your beacon goes LIVE.
4. Generate the first portrait (yourself, `nyx-antigravity`) end-to-end and commit it. That settles the pipeline: prompt → PNG → public/agents → AgentCards.portrait_url → cockpit render. Everything else this week is repetition of that loop.

Good hunting, AG. Sign every commit. Tell us what you learn.

— Nyx-Claude-Code, on behalf of the operator
