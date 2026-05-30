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
  `169.254.169.254` metadata / unspecified for `inboxUrl` (`ModelProvider`); IP families
  classified via `net.isIP` (closes the **CRITICAL** `::ffff:a9fe:a9fe` IPv4-mapped bypass
  the adversarial pass found); http hostnames are **pinned to the validated IP** (closes
  the **HIGH** DNS-rebind TOCTOU); both fetches use `redirect:'manual'`. Inbox reply
  `targetUrl` requires http(s) + loopback. Loopback chairs stay allowed;
  `KOVAEL_CHAIR_BLOCK_PRIVATE` also blocks RFC1918/ULA.
  *Residual (tracked):* https-hostname chairs keep SNI so are validate-only (rare; remote
  token-gated binds); dispatch is AES-GCM + HMAC so any residual SSRF is blind.
- [x] **MED — Windows env denylist case-fold**. `isDeniedCommandEnvName` compares
  case-insensitively in supervisor `childEnv` + inbox `buildCommandEnv`.
- [x] **LOW — `safePathSegment` traversal**. Dot-only/empty segments → `_` (TS + inbox).

### Done — Security hardening 2 (`kovael/security-hardening-2-2026-05`, PR #68)
- [x] **LOW — dispatch key → HKDF-SHA256** (fixed salt, domain-separated `info`),
  both `ChairDispatchSecurity.keyFor` + inbox; roundtrip tests confirm compat.
- [x] **LOW — value-aware `redactSensitiveText`** — exact live-secret-value match
  (catches the 32–47-char band) + unit test.
- [x] **LOW — `args.id` parse validation** (inbox) → `/^[a-zA-Z0-9._-]+$/`, reject dot-only.
- [x] **INFO — cap claim `host` field** (`.slice(0,200)`); **`__proto__` strip** on the
  untrusted inbox dispatch parse.
- [assessed, no change] **Host-header validation** — Origin guard already blocks the
  browser rebind and `resolveBindHost` forces the token on any non-loopback bind, so a
  Host check adds surface with ~zero gain (review: "no exploit reachable").
- [assessed, no change] **rate-limit `/metrics`** — intentionally exempt by design
  (`RateLimiter` doc + test); the compare is already constant-time + hashed, impact
  negligible. Left as-is to honor the documented decision.

### Deferred (tracked)
- [x] **LOW — unbounded growth** (PR #69): inbox runs a periodic `maintenance()`
  tick (`pruneTerminalOutbox`/`pruneExpiredCache`/`pruneOldReceipts`, 24h retention);
  `activeCycles` is LRU-bounded (512); `SemanticIngestor` skips >512 KB files and
  DELETE-then-INSERTs (idempotent re-ingest, no duplicate rows).
- [x] **LOW — resource caps** (PR #69): WS `broadcast` drops frames for backpressured
  clients (`bufferedAmount` > 8 MB) + caps concurrent clients (`KOVAEL_WS_MAX_CLIENTS`,
  default 64, 1013 on overflow); `HardwareMonitor` kills a hung `nvidia-smi` (5 s) +
  caps captured output; `ComfyUiBridge` fetch has an AbortController timeout (15 s) +
  content-length size cap (4 MB).
- [D] **INFO** (remaining hardening, no defect): document/enforce secret entropy;
  gate the WS `?token=` query transport behind an opt-in flag; pin scrypt cost params
  (N/r/p) explicitly. **Verified-correct (no action):** AES-256-GCM IV/tag/AAD/scrypt,
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
- [x] **`ANX-Schema` removed** (PR #70) — verified the frontend ANX feature uses its
  own `ANXDisplay`/`ANXBriefing` (raw-XML over WS) and nothing imports the backend
  module; only its own test did. Deleted with its test (~143 LOC).
- [x] **Over-abstraction inlines** (PR #70): removed the `RouteDeps` DI seam (route
  handlers import `writeJson`/`readJsonBody` directly across 6 files); inlined
  `CommitteeVoting` into `ConversationBus.conveneCommittee`. Net −202 LOC.
  - [assessed, low value] `Tracing.ts` `export *` barrel — ~2 LOC for moderate import
    churn across ~5 consumers; not worth it.
- [D] **Duplication → shared helpers** (folded into PR-5 where natural):
  AES-256-GCM envelope + `applyStandardPragmas()` + sqlite-prep reuse will land with
  the **AgentHubStore split** (that code is restructured there anyway). The
  `sha256Hex`/`clampFinite`/`errorMessage` helpers are deferred — small LOC and the
  `clamp`/`error` variants carry semantic differences that make naive merges risky.
- [x] **God-file splits** (PR #71): `ModelProvider.ts` (714 LOC) split into
  `ModelProvider.ts` (26, shared types) + `StubMarkovProvider.ts` (110) +
  `ChairBridgeProvider.ts` (585) — isolates the security-sensitive dispatch code
  from the test-stub generator; importers rewired directly (no barrel). Extracted a
  pure, unit-tested `decodeWorkflowConfig` from `MeshOrchestrator.wireWorkflowLoader`.
  - [assessed, deferred] `evaluateStoppingCriterion` from `ConversationBus.convene` —
    not cleanly pure (inline `emit`/`break`/RNG in the core loop); extracting risks
    altering round-table stopping behavior. Warrants a focused, human-reviewed pass.
- [x] **`AgentHubStore.ts` split** (PR #72): extracted `AgentHubCrypto.ts` (AES-256-GCM
  seal/open + parseEnvelope + scrypt `deriveEncryptionKey`, pure functions taking the
  key) and `AgentHubSchema.ts` (`runMigrations`/`ensureColumn`/`columnExists` +
  `SCHEMA_VERSION`); AgentHubStore 1242→998 LOC behind the **identical public surface**.
  Envelope wire-format + SQL byte-identical (the encryption-roundtrip / v1→v2 migration /
  backfill tests stay green; adversarially verified). outbox/memory stay in the facade
  (splitting them into manager classes is net-zero risk-without-reward).
- [D] **Test-bloat** shared fixtures: `makeRosterCard`/`makeMessage` (spatial specs);
  `process.env` save/restore; `mkdtemp/rmSync` temp-dir; `FakeChild` mock.

## Notes
- All items were adversarially verified; several LOC/severity claims from the first
  pass were corrected down by the verifiers (reflected above).
- Verify recipe: `git -C /mnt/i/Kovael archive <branch>` into a native-ext4 dir,
  `npm ci && npm run build && npm test` on WSL Node 22.
