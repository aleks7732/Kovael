# Kovael Ultramax — Sovereign Chair Mesh: Connect-All + Open-Expansion

> **Design spec.** Status: **approved, pre-plan.** Author: `nyx-claude-code` chair.
> Date: 2026-05-29. Companion brief: [`ULTRAMAX-GOAL.md`](../../../ULTRAMAX-GOAL.md).
> Next step: `writing-plans` → phased implementation plan.

---

## 1. Context & current state (evidence-based)

Kovael already connects chairs through **three layers**. Two are data-driven;
one is hardcoded and is the bottleneck for "easy expansion."

| Layer | Where | State |
|---|---|---|
| **Static identity** | [`src/AgentCards.ts`](../../../src/AgentCards.ts) + loader [`MeshOrchestrator.loadAgentCards()`](../../../src/MeshOrchestrator.ts) (L581) | **Data-driven.** Reads `agent_cards/*.json` from CWD at boot; TS object is fallback. The `agent_cards/` dir does not exist yet, so the fallback is always used today — but the seam is real. |
| **Runtime presence** | [`src/services/ChairRegistry.ts`](../../../src/services/ChairRegistry.ts) | **Open-admission.** `claim`/`heartbeat`/`release`/`reply`; any `agentId` may claim (no whitelist). 15s live → 30s evict. |
| **Runtime lifecycle / dispatch** | [`src/services/AgentRuntimeSupervisor.ts`](../../../src/services/AgentRuntimeSupervisor.ts) | **HARDCODED.** `runtime` is a closed union `'codex' \| 'codex-openclaw' \| 'claude-shaev'` (L29); `byId` is a literal map of exactly 3 specs (L707); `DEFAULT_AGENT_IDS = ['shaev','nyx-codex']` (L186). 7 of 9 chairs have no supervisable runtime type. |

**Consequence:** a presence-only/self-beaconing chair needs only a card +
persona + rebuild, but a **dispatch-capable** chair needs a TypeScript edit to
the supervisor's `byId` map *and* the closed `runtime` union *and* the dispatch
switch in [`scripts/kovael-agent-inbox.mjs`](../../../scripts/kovael-agent-inbox.mjs).
Every new dispatchable chair is a core code change. That is the seam to open.

**Linux status (verified 2026-05-29, native Node 22 / WSL Ubuntu, fresh
`git archive` of the branch):** `tsc` build exit 0; root Vitest suite **555
tests / 62 files, all green** (22s). Committed line endings are **LF**
(`git ls-files --eol` → `i/lf`); the Windows working tree shows CRLF only
because `core.autocrlf=true` converts on checkout. There is **no
`.gitattributes`**, so LF-cleanliness depends on each contributor's autocrlf
config — a defense-in-depth gap, not a current break. (Cockpit workspace
tests were not separately exercised on Linux; root orchestrator suite only.)

**Code-weight findings (recon, to be remediated in Phase 3):** god-files —
[`AgentHubStore.ts`](../../../src/services/AgentHubStore.ts) **1143 LOC**
(schema + AES-GCM crypto + outbox + backfill in one class),
`MeshOrchestrator.ts` 798, `AgentRuntimeSupervisor.ts` 794,
`ModelProvider.ts` 653; `budgetTracker`/`routingPolicy`/`episodicMemory`
constructed in `MeshOrchestrator` but with **0 call sites** in `MevBridge` or
`ConversationBus` (likely dead — confirm via `OrchestratorContext` before
cutting); duplicated `readBoolean`/`readBooleanEnv`; `backfillV2Columns()`
runs an O(N) full-table scan on **every** `AgentHubStore` construction;
`@modelcontextprotocol/sdk` and `zod` sit in `dependencies` (audit whether
they belong in `devDependencies`).

---

## 2. Goal & non-goals

**Goal.** Make connecting any chair — the 9 today or #10…#N — a
**manifest-driven, zero-core-edit** operation, while preserving Kovael's
loopback/sovereignty/encryption posture and *reducing* net code weight.

**Non-goals (YAGNI).** Distributed multi-node / WebRTC mesh; NPU offload;
vector-DB swap; any of the speculative "future outlook" from
`deepmaxreturn.md`. Desktop-app scraping / token extraction / auth bypass
remains explicitly forbidden (unchanged project rule).

---

## 3. Architecture — D3 Hybrid adapter model

Chosen from three options (see companion brief for the D1/D2/D3 record).
**D3 = typed built-in adapters + one generic, hard-gated `CommandAdapter`.**

```text
agent_cards/<id>.json  ─┐                         (manifest: identity + runtime)
                        │  validate (zod schema)
                        ▼
                 ChairManifestLoader ── cards ──► AgentCards view (cockpit/registry)
                        │
                        └── runtime spec ──► AdapterRegistry.resolve(kind)
                                                   │
                          ┌────────────────────────┼───────────────────────────┐
                          ▼                         ▼                           ▼
                   ClaudeShaevAdapter        CodexAdapter              CommandAdapter (generic,
                   (typed built-in)          (typed built-in)          allow-listed, opt-in)
                          └──────────── AgentRuntimeSupervisor (lifecycle) ─────┘
                                                   │
                                       kovael-agent-inbox.mjs (loopback inbox,
                                       SSRF guard, envelope crypto, secret strip)
                                                   │
                                       /api/v1/chairs/* (claim/heartbeat/reply)
```

The supervisor stops owning a literal map; it owns a **registry lookup**.
Adding a runtime *type* = register one adapter. Adding a *chair* on an
existing runtime = drop a manifest, **zero TS**.

---

## 4. Components

### 4.1 Chair manifest schema (`zod`, already in-tree)
One JSON shape per chair in `agent_cards/<id>.json`, unifying card + runtime:

```jsonc
{
  "id": "nyx-adk",                       // must match persona agent_id
  "name": "Nyx ADK",
  "provider": "Google · Agent Development Kit (Python)",
  "trustTier": 2,
  "capabilities": ["python", "google-cloud", "tool-use"],
  "vram": "cloud",
  "portrait": "nyx-adk.png",             // optional; resolved against the cockpit assets dir
  "runtime": {                            // optional; omit = presence-only/self-beaconing
    "kind": "command",                   // built-in kind OR "command" for the generic adapter
    "supervised": true,
    "command": "python",                 // command-adapter only
    "args": ["-m", "nyx_adk.inbox"],     // command-adapter only
    "allowEnv": ["KOVAEL_HOST"],          // command-adapter only; explicit env allow-list
    "elevated": false
  }
}
```

A `zod` schema validates every manifest at load and in CI. Unknown `runtime.kind`
or a non-allow-listed command fails **loudly at load**, never silently at dispatch.

### 4.2 `ChairManifestLoader`
Extract and harden the existing `MeshOrchestrator.loadAgentCards()` (L581) into
a dedicated, tested module: schema-validate each file, surface precise errors,
cross-check that each manifest `id` has a matching `personas/<id>.md`
`agent_id` (closes the "persona drift" friction), and fall back to the TS
`AgentCards` only when `agent_cards/` is absent.

### 4.3 `RuntimeAdapter` interface + `AdapterRegistry`
Replaces the closed union (L29) and the literal `byId` map (L707):

```ts
interface RuntimeAdapter {
  readonly kind: string;            // matches manifest runtime.kind
  readonly supervised: boolean;     // can the supervisor own its lifecycle?
  buildSpec(manifest: ChairManifest): AgentRuntimeSpec;  // replaces byId entry
}
interface AdapterRegistry {
  register(adapter: RuntimeAdapter): void;
  resolve(kind: string): RuntimeAdapter | undefined;     // unknown → clear error
  kinds(): string[];
}
```

Built-in adapters (`claude-shaev`, `codex`, `codex-openclaw`) self-register at
boot, preserving today's exact behavior. `DEFAULT_AGENT_IDS` and
`defaultAgentRuntimeSpecs()` become **derived from the loaded manifests +
registry**, not literals.

### 4.4 `CommandAdapter` (generic, gated, opt-in)
For the long tail (ADK/Python, Antigravity, AGCLI, Cowork). Reuses the inbox
adapter's existing security (loopback-only inbox, `http(s)`-only SSRF scheme
guard, dispatch-secret stripping before spawn). Adds:
- **Binary allow-list** via `KOVAEL_COMMAND_ADAPTER_ALLOW` (comma-separated).
  Empty/unset ⇒ the command adapter is **disabled** (secure default).
- **Explicit env allow-list** per manifest (`allowEnv`); nothing else passes to
  the child.
- No shell interpolation; args are an array, never a concatenated string.

### 4.5 Validation / lint
[`scripts/validate-all-chairs.mjs`](../../../scripts/validate-all-chairs.mjs)
already derives its agent list from `Object.keys(AgentCards)`; extend it to load
+ schema-validate every `agent_cards/*.json`, assert persona pairing, and assert
each declared `runtime.kind` resolves in the registry. A bad manifest fails the
PR gate, not production.

---

## 5. Data flow

**Boot:** `ChairManifestLoader` reads `agent_cards/*.json` → validates → emits
(a) the cards view (cockpit roster / `AgentCards`) and (b) runtime specs via
`AdapterRegistry`. `AgentRuntimeSupervisor.fromEnvironment()` (L252) consumes
registry-derived specs instead of `defaultAgentRuntimeSpecs()` literals.

**Dispatch:** unchanged at the protocol boundary — Theater/convene → supervised
adapter (or presence-only beacon) → `kovael-agent-inbox.mjs` inbox → reply via
`/api/v1/chairs/reply` with HMAC `replyProof`. Only the *resolution* of "which
adapter runs this chair" moves from a literal map to the registry.

---

## 6. Security model

**Preserved invariants (must not regress; covered by existing tests):**
loopback bind default; `KOVAEL_API_TOKEN` bearer gate on `/api/v1/*`,
`/metrics`, authenticated WS; AES-256-GCM dispatch envelopes
(`KOVAEL_CHAIR_DISPATCH_SECRET`, AAD-bound to requestId+timestamp); per-dispatch
HMAC `replyProof`; loopback-only inbox; `http(s)`-only SSRF scheme guard;
sovereignty — **no new external API dependencies**; protected-path boundary for
`.claude/`/`.gemini/`/`.codex/`.

**New surface — `CommandAdapter` — gated by default:** disabled unless
`KOVAEL_COMMAND_ADAPTER_ALLOW` lists the binary; per-manifest env allow-list;
array-args only (no shell); dispatch secrets stripped before spawn (existing
inbox behavior). Threat addressed: a compromised token already lets an attacker
claim chairs (open-admission, documented); the command adapter must not *widen*
that into arbitrary host code execution — hence allow-list + opt-in.

---

## 7. Error handling

- **Manifest invalid** → loader rejects that file with a precise error
  (`agent_cards_invalid`), skips it, keeps booting on the remainder + TS
  fallback; CI lint turns the same condition into a hard failure.
- **Unknown `runtime.kind`** → `AdapterRegistry.resolve` returns undefined →
  chair is treated as presence-only with a logged warning (no crash).
- **Command not allow-listed** → `CommandAdapter` refuses to start that chair,
  logs `command_adapter_blocked`; supervisor continues with the rest.
- **Adapter spawn failure** → existing supervisor retry/backoff + chair release
  path applies unchanged.

---

## 8. Lightweight / bloat remediation (Phase 3)

Net LOC must **drop** versus Phases 1–2 additions. Concrete targets:
- Split `AgentHubStore.ts` (1143 LOC) → `schema` / `crypto` / `outbox` /
  `memory` modules behind the same public surface (no behavior change; tests
  stay green).
- Confirm-then-cut `budgetTracker`/`routingPolicy`/`episodicMemory` (verify no
  `OrchestratorContext` consumer first).
- De-dup `readBoolean`/`readBooleanEnv` into one shared util.
- Make `backfillV2Columns()` idempotent + guarded (skip when schema version is
  current) to remove the O(N)-per-boot scan.
- Audit `@modelcontextprotocol/sdk` / `zod` placement; move to
  `devDependencies` if not on a production path (smaller runtime image).

---

## 9. Phasing

- **Phase 0 — Hygiene & truth (small).** Add `.gitattributes`
  (`*.sh text eol=lf`, `*.mjs text eol=lf`, sensible defaults); document the
  Node-22 target; add the Linux `tsc` build + Vitest run as a CI gate
  (`.github/workflows/ci.yml`).
- **Phase 1 — Registry foundation.** Manifest schema + `ChairManifestLoader` +
  `RuntimeAdapter`/`AdapterRegistry`; migrate the 3 existing supervised chairs
  onto built-in adapters with **zero behavior change**. Gate: all 555 root
  tests still green.
- **Phase 2 — Connect all.** Author `agent_cards/*.json` for all 9; implement
  typed adapters where dispatch is sensitive and `CommandAdapter` configs for
  the rest (ADK/Python, Antigravity, AGCLI, Cowork…). Gate: `validate:chairs`
  covers all 9; each new adapter unit-tested.
- **Phase 3 — Bloat/quality remediation.** Section 8.

---

## 10. Testing strategy

- **Unit:** manifest schema (valid/invalid/edge); `ChairManifestLoader`
  (fallback, persona pairing, bad file); `AdapterRegistry`
  (register/resolve/unknown); each adapter's `buildSpec`; `CommandAdapter`
  gating (disabled-by-default, allow-list, env allow-list, no-shell).
- **Regression:** the existing 555-test root suite must stay green at every
  phase boundary; supervisor behavior for the 3 current chairs is byte-for-byte
  preserved in Phase 1.
- **Linux gate:** the Phase-0 CI job runs `tsc` + Vitest on Node 22 Linux so
  cross-platform cleanliness is enforced, not assumed.

---

## 11. Acceptance criteria (the "done" bar)

1. Adding a **dispatch-capable** chair on an existing runtime kind requires
   **only** a new `agent_cards/<id>.json` + persona — **zero `src/` edits** —
   proven by adding a 10th chair in a test.
2. The closed `runtime` union (L29) and literal `byId` map (L707) are gone;
   resolution flows through `AdapterRegistry`.
3. All 9 chairs have manifests; `validate:chairs` exercises all 9.
4. `CommandAdapter` is disabled by default and refuses non-allow-listed
   binaries (tested).
5. All preserved security invariants (Section 6) still pass their tests.
6. Net `src/` LOC is **≤** the pre-goal count (lightweight proven, not claimed).
7. `tsc` + full Vitest green on Node 22 **Linux CI**; `.gitattributes` present.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Phase 1 migration changes existing dispatch behavior | Built-in adapters reproduce current `byId` specs exactly; 555-test gate at the boundary. |
| `CommandAdapter` becomes an RCE vector | Disabled by default; binary + env allow-lists; array-args; secret strip; opt-in env flag. |
| Cutting "dead" services breaks a hidden consumer | Confirm via `OrchestratorContext` grep + green suite before removal; do it in isolated Phase-3 commits. |
| Scope creep into distributed mesh | Explicit non-goals (Section 2). |

---

## 13. Open questions

None blocking. Two operator choices deferred to the plan, both with safe
defaults: (a) exact `agent_cards/` location (default: repo-root `agent_cards/`,
matching the existing loader's CWD read); (b) whether Phase 3 ships in the same
PR stack or a follow-up (default: same stack, isolated commits).
