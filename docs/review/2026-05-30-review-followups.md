# Review Follow-ups — Bloat + Security (2026-05-30)

> **Durable tracker** for the whole-codebase bloat + security review (each finding
> was produced by a dimension specialist and independently refuted/confirmed by a
> separate skeptic). This file is the source of truth so any IDE/session can pick
> up the backlog. Update the status boxes as items land.
>
> Status: `[x]` done · `[~]` in progress · `[ ]` planned · `[D]` deferred (needs a
> decision or a focused, higher-risk pass).

## Security

### Done — Security PR (`kovael/security-hardening-2026-05`, PR #67)
- [x] **HIGH — WS upgrade Origin validation**. `isAllowedWsOrigin` rejects remote
  browser origins (CSWSH / DNS-rebind) on every upgrade, independent of the bearer
  gate; loopback origins (any port) + `KOVAEL_WS_ALLOWED_ORIGINS` allowed; header-less
  non-browser clients allowed. `WebSocketBus.ts`.
- [x] **MED — Chair URL SSRF egress guard**. New `UrlEgressGuard` blocks link-local /
  `169.254.169.254` metadata / unspecified for `inboxUrl` (`ModelProvider`, resolves +
  re-checks every DNS answer); inbox reply `targetUrl` now requires http(s) + loopback.
  Loopback chairs stay allowed; `KOVAEL_CHAIR_BLOCK_PRIVATE` also blocks RFC1918/ULA.
- [x] **MED — Windows env denylist case-fold**. `isDeniedCommandEnvName` compares
  case-insensitively in supervisor `childEnv` + inbox `buildCommandEnv`.
- [x] **LOW — `safePathSegment` traversal**. Dot-only/empty segments → `_` (TS + inbox).

### Deferred (tracked)
- [D] **LOW — dispatch key = single-pass unsalted SHA-256** (not a KDF).
  `ChairDispatchSecurity.keyFor`, `kovael-agent-inbox.mjs`. Use HKDF/scrypt + salt
  or enforce 32-byte random secrets. (Reachable only under non-default conditions.)
- [D] **LOW — `redactSensitiveText` misses 32–47-char secret values** (shape-only).
  `RuntimeSecurity.ts`. Make value-aware. (No current call site interpolates a raw
  secret value, so latent.)
- [D] **LOW — unbounded growth**: hub `prune*` never scheduled; `activeCycles` map;
  `SemanticIngestor` re-indexes whole files each boot (no cap/dedup). Wire a
  maintenance tick + per-file caps + UPSERT.
- [D] **LOW — no resource caps**: WS `broadcast` no `bufferedAmount` backpressure +
  no max-connections; `HardwareMonitor` `nvidia-smi` no timeout/output-cap (hang
  latches polls); `ComfyUiBridge` fetch no timeout/size-cap.
- [D] **INFO** (hardening, no defect): rate-limit `/metrics` before bearer compare;
  cap claim `host` field length; `__proto__` strip on JSON loaders (defense-in-depth);
  document/enforce secret entropy; gate the WS `?token=` query transport; pin scrypt
  cost params. **Verified-correct (no action):** AES-256-GCM IV/tag/AAD/scrypt,
  constant-time bearer + HMAC reply-proof, loopback bind default.

## Bloat

### Done — this PR (`kovael/bloat-cleanup-2026-05`) — net −540 LOC (−210 non-test src)
- [x] Delete **`TraceComfyBridge`** (dead trace-flowchart renderer) + its test +
  the flowchart `describe` block in `Tracing.test.ts`.
- [x] Remove dead `AgentPathProtection` exports (`isProtectedAgentPath`,
  `findProtectedAgentPathPresence`, `ProtectedAgentPathPresence`).
- [x] Remove dead `ChairDispatchSecurity.chairDispatchSecurityEnabled`.
- [x] Remove dead `MevHandshake` Blueprint cluster (`validateSynchronous`,
  `broadcastBlueprint`, `Blueprint`); keep the wired `handleRequest` SSE endpoint
  (its cleanup is now covered by a heartbeat-clear test).
- [x] Remove dead `TraceSanitizers.__TRACING_INTERNALS__` test-hook export.

### Deferred (tracked)
- [D] **`ANX-Schema` (`src/protocols/ANX-Schema.ts`, ~143 LOC)** — code-dead (zero
  refs), but it is a **named protocol/SOP spec**. Confirm it is not an intentional
  contract artifact before deleting. *Decision needed.*
- [D] **Duplication → shared helpers** (medium net value, some harden security):
  AES-256-GCM envelope (`AgentHubStore` + `ChairDispatchSecurity`) → `src/common/aes-gcm-envelope.ts`;
  secure-sqlite-file-prep reuse (closes an orchestrator-DB UNC-guard gap);
  `applyStandardPragmas()` (also hardens `MevBridge` DB); `sha256Hex`, `clampFinite`,
  `errorMessage` helpers; unify the 3 redaction variants.
- [D] **Over-abstraction inlines** (mechanical, multi-file): remove the `RouteDeps`
  DI seam (7 files); inline `CommitteeVoting` into `ConversationBus`; drop the
  `Tracing.ts` `export *` barrel.
- [D] **God-file splits** (net ~0 LOC; clarity/security isolation): split
  `ModelProvider.ts` (StubMarkov vs ChairBridge); extract a pure
  `evaluateStoppingCriterion` from `ConversationBus.convene`; extract the
  frontmatter→config decode from `MeshOrchestrator.wireWorkflowLoader`.
- [D] **`AgentHubStore.ts` (1234 LOC) module split** — `schema`/`crypto`/`outbox`/
  `memory` behind the same public surface. (Already deferred from chair-mesh Phase 3:
  high-risk AES-GCM/SQLite extraction; do as a focused, human-reviewed refactor.)
- [D] **Test-bloat** shared fixtures: `makeRosterCard`/`makeMessage` (spatial specs);
  `process.env` save/restore; `mkdtemp/rmSync` temp-dir; `FakeChild` mock.

## Notes
- All items were adversarially verified; several LOC/severity claims from the first
  pass were corrected down by the verifiers (reflected above).
- Verify recipe: `git -C /mnt/i/Kovael archive <branch>` into a native-ext4 dir,
  `npm ci && npm run build && npm test` on WSL Node 22.
