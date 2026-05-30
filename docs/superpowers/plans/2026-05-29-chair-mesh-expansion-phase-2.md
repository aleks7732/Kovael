# Chair Mesh Expansion — Phase 2 Plan (Connect All Chairs)

> TDD implementation plan. Parent spec:
> [`../specs/2026-05-29-chair-mesh-expansion-design.md`](../specs/2026-05-29-chair-mesh-expansion-design.md).
> Builds on Phase 0+1 (merged, PR #62). The `RuntimeAdapter` interface is FROZEN —
> only data types get optional fields; no method-signature changes.

## Goal
Make a `command`-kind chair connectable by **manifest drop only** (zero `src/`
edits), gated and secure, while the 3 supervised chairs behave identically and the
roster is byte-for-byte preserved. Realizes acceptance criteria #1, #3, #4.

## Key design decisions
- **Manifest-driven supervision.** `defaultAgentRuntimeSpecs()` derives specs from
  loaded `agent_cards/*.json` + the registry (spec §4.3/§5), falling back to the
  literal `BUILTIN_AGENT_KINDS` map only when no manifest dir exists (parity for
  envs without manifests, e.g. tmp-cwd tests). Codex review of #62 flagged the
  missing wiring — this closes it.
- **Roster parity is load-bearing.** Shipping `agent_cards/` at repo root changes
  the default roster + spec path for the whole suite. So manifests mirror
  `AgentCards.ts` exactly, the schema + `manifestToCard()` carry every `AgentCard`
  field, and a parity test enforces `loadChairManifests(agent_cards).cards` ≡
  `AgentCards`. (Also addresses Codex P2: carry `description`.)
- **CommandAdapter is data-fed, not interface-reshaped.** `manifestToCard()` carries
  `runtime` onto the card; `CommandAdapter.buildSpec(card)` reads `card.runtime`.
  Built-ins ignore it. `RuntimeSpecDraft`/`AgentRuntimeSpec` gain optional
  `command?`/`args?`/`allowEnv?`. No frozen method signature changes.
- **Gating (defense in depth).** `KOVAEL_COMMAND_ADAPTER_ALLOW` (csv binary
  allow-list); unset/empty ⇒ disabled. Checked at the supervisor (non-allow-listed
  command chair ⇒ `enabled:false`, dropped) AND at the inbox spawn point
  (`command_adapter_blocked`). Per-manifest `allowEnv` adds only non-secret vars to
  the minimal `buildAgentRuntimeEnv` base; secret names are denied. Array args, no
  shell (reuse `spawnCapture` `shell:false`).

## 9 chairs → runtime.kind
- built-in supervised: `shaev`→`claude-shaev`, `nyx-codex`→`codex`,
  `nyx-openclaw`→`codex-openclaw` (elevated-gated).
- `command`: `nyx-adk`, `nyx-cw`.
- presence-only (omit `runtime`): `nyx-antigravity`, `nyx-claude-code`, `nyx-cli`,
  `nyx-agcli`.

## Steps (each ends green; commit per step)
1. **Schema + roster parity + manifests.** Extend `ChairManifestSchema` with optional
   `description`, `beaconHint`, `accentHex`. Extend `AgentCard` with optional
   `runtime?: ChairRuntime`. `manifestToCard()` carries every field + `runtime`.
   Author `agent_cards/<id>.json` for all 9 (mirror `AgentCards.ts`; runtime per
   table). Test: `loadChairManifests(repo agent_cards).cards` deep-equals
   `AgentCards` (sorted; runtime stripped for the 3+presence, asserted for command).
2. **CommandAdapter.** New `src/services/runtime/CommandAdapter.ts` implementing the
   frozen interface (`kind:'command'`, `supervised:true`, `buildSpec` reads
   `card.runtime`, `policy()` = locked-down default, `resolveExecutable` returns the
   command). Extend `RuntimeSpecDraft`/`AgentRuntimeSpec` with `command?/args?/allowEnv?`.
   Register on `defaultRuntimeRegistry()`. Tests: buildSpec maps runtime fields;
   disabled-by-default; allow-list pass/block; env allow-list; array-args.
3. **Supervisor wiring + nits.** `defaultAgentRuntimeSpecs(ids, {enableElevated, cwd})`
   becomes manifest-driven (fallback to BUILTIN map). `argsFor()` passes `--command`,
   `--command-args <json>`, `--allow-env <csv>` for command specs. Non-allow-listed
   command spec ⇒ `enabled:false`. Hoist `defaultRuntimeRegistry()` to a module
   singleton (Unit D). Drop the `as Pick<…>` cast in `runtimePolicyFor` (Unit D).
   Tests: 3-built-in spec parity; zero-`src`-edit 10th command chair yields a valid
   supervisable spec; non-allow-listed ⇒ disabled.
4. **Inbox command dispatch.** `kovael-agent-inbox.mjs`: parse `--command`,
   `--command-args`, `--allow-env`; add `runCommand(payload,cfg)` mirroring `runCodex`
   (gate on `KOVAEL_COMMAND_ADAPTER_ALLOW`, env = minimal base + non-secret allowEnv,
   array args + appended prompt, stdout = reply); wire into `runRuntime` switch.
5. **Validation.** Extend `scripts/validate-all-chairs.mjs` (or a pre-flight in it) to
   schema-validate every `agent_cards/*.json`, assert each `runtime.kind` resolves in
   `defaultRuntimeRegistry()`, and cross-check manifest `id` ↔ `personas/<id>.md`
   `agent_id`. A bad/orphaned manifest fails the gate.

## Verification
Targeted vitest per step; full **WSL Node-22 gate** before PR (build 0, test 0,
count ≥ 567 + new). Adversarial verification (security regression, frozen-interface,
roster parity, LOC) before opening the PR. Auto-merge on green.
