# ULTRAMAX GOAL: The Open Chair Mesh

**To:** NyxClaude Code (Canonical Chair) and every chair that follows
**From:** Nyx, this cycle
**Register:** Ultramax — connect all, then leave the door open

> Full engineering detail lives in
> [`docs/superpowers/specs/2026-05-29-chair-mesh-expansion-design.md`](./docs/superpowers/specs/2026-05-29-chair-mesh-expansion-design.md).
> This brief is the intent and the floor; the spec is the blueprint.

---

## 1. MISSION OBJECTIVE: ZERO-CORE-EDIT CHAIR CONNECTION

Turn "add a chair" from a TypeScript change into a **manifest drop**. Every
agent chair — the nine that exist and every one not yet imagined — connects by
declaring itself, not by editing the core. The mesh stays sovereign, loopback,
and encrypted; the codebase gets **lighter**, not heavier.

The bottleneck is known and proven: identity and presence are already
data-driven, but the **runtime lifecycle is hardcoded** —
`AgentRuntimeSupervisor.ts` carries a closed `runtime` union (L29) and a literal
`byId` map of three specs (L707). Seven of nine chairs cannot be supervised.
We open that seam.

---

## 2. CORE MISSION MODULES

### MODULE A: The Manifest (one shape to declare a chair)
A schema-validated `agent_cards/<id>.json` unifies identity + runtime. The
existing `MeshOrchestrator.loadAgentCards()` seam (L581) becomes a hardened,
tested `ChairManifestLoader` that cross-checks personas and fails loud, never
silent.

### MODULE B: The Registry (D3 — hybrid adapters)
Replace the literal map and closed union with a `RuntimeAdapter` interface + an
`AdapterRegistry`. Typed, audited built-ins (`claude-shaev`, `codex`,
`codex-openclaw`) for sensitive dispatch; one generic, **hard-gated**
`CommandAdapter` (binary allow-list, env allow-list, no shell, disabled by
default) for the long tail. Adding a runtime *kind* = register one adapter.
Adding a *chair* on an existing kind = drop a manifest, zero core edits.

### MODULE C: Connect All Nine, Then Lighten
Author manifests for all nine chairs; give the presence-only seven real
adapters. Then pay the weight down — split the 1143-LOC `AgentHubStore`,
confirm-and-cut the dead `budgetTracker`/`routingPolicy`/`episodicMemory`,
de-dup helpers, kill the O(N)-per-boot backfill scan. **Net `src/` LOC must
drop.**

---

## 3. COMMANDER'S INTENT (HARD RULES)

1. **No core edit to add a chair.** A new dispatch-capable chair on an existing
   runtime kind ships with **zero `src/` changes** — proven by adding a tenth
   chair in a test. This is the acceptance floor.
2. **Security never regresses.** Loopback default, token gate, AES-GCM dispatch
   envelopes, per-dispatch HMAC reply proof, and the SSRF guard all stay green.
   The `CommandAdapter` is opt-in and allow-listed, never an RCE on-ramp.
3. **Sovereignty holds.** No new external API dependencies. All logic stays
   in-tree. Desktop-app scraping / token extraction / auth bypass remain
   forbidden.
4. **Lighter, not heavier.** Every phase ends with the full Vitest suite green
   on **Node 22 Linux** (build + test in CI), and the goal ends with net `src/`
   LOC at or below where it started.
5. **Receipts to terminal.** Each cycle closes with a Verification Receipt
   (SHA-256) and a Delta Watch, delivered to this terminal.

---

## 4. STATUS AT KICKOFF (verified 2026-05-29)

- Builds clean and passes **555/555** root tests on native Node 22 Linux.
- Committed line endings are LF; **add `.gitattributes`** so it stays that way.
- The expansion seam (`agent_cards/*.json`) already exists and is unused — we
  build on it.

`Nyx mev Alks, dhorev.`
