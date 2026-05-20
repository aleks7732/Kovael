# AG Nyx · PHOENIX mid-week checkpoint

**Status:** Days 1–4 effectively shipped to `main`. Days 5–7 ahead.
**Author:** Nyx-Claude-Code, on behalf of the operator.

---

## 1. What you shipped

In three commits to `main` (`4cd5ac0`, `52c242d`, `b97f0d8`):

- ✅ **Day 1** — nine neko-doll portraits (512² + 128² thumbnails) with
  per-agent identity tells, plus the `AgentAvatarFallback` SVG fallback,
  plus the `portrait_url` / `accent_hex` wiring on `AgentCard`.
- ✅ **Day 2** — nine persona cards under `personas/` matching the
  YAML-front-matter schema. `PersonaLoader.ts` with hot reload + test.
- ✅ **Day 3** — `ConversationBus.ts` (403 LOC), `ModelProvider.ts` with
  `StubMarkovProvider` + `ChairBridgeProvider`, persistence in SQLite
  (`conversation_topics`, `conversation_messages`, `conversation_topics_seq`),
  full WS event surface (`conversation_topic_opened`,
  `conversation_message_delta`, `conversation_topic_closed`,
  `conversation_stopping_criterion`).
- ✅ **Day 4** — `theater/` component set: `ConversationTheater`,
  `ConvenePanel`, `Stage`, `MessageList`, `StoppingCard`,
  `TraceBreadcrumb`. Wired into `SpatialWarRoom.tsx` behind an
  `activeTab` switch.

### Quality grade (from end-to-end verification)

End-to-end smoke against a real orchestrator on an ephemeral port:
- **First delta latency:** 10 ms
- **Full convene cycle:** 2.36 s
- **Delta count:** 93 across two of three participants
- **Stopping criterion:** **adaptive_stability_reached** at
  `delta = 0.0392 < ε = 0.05`, confidence 0.82.

You implemented the literal arXiv 2510.12697 criterion I cited in the
brief. That's exceptional. Grade for the work that landed: **A.**

A small observation worth one of your next-day fixes: in the smoke run
`nyx-codex` never got a turn — the stopping criterion fired before the
queue scheduled the third speaker. Either tighten the round-robin
guarantee ("every named participant speaks ≥ 1 turn before stability
can fire") or document the rationale. Either is acceptable; pick one.

## 2. What was follow-upped on your behalf (branch `claude/phoenix-followups`)

A draft PR is opening with three commits you do not need to repeat:

- `ccdf7ee` — `.trufflehogignore` was glob syntax (`dist/**`); TruffleHog's
  `--exclude-paths` expects RE2 regex. Rewrote with anchored patterns.
  This is what flipped PR #14's TruffleHog job red.
- `de7e77a` — re-quantized your portraits with `pngquant
  --quality=70-92 --speed=1 --strip` (chibi gradients survive perceptual
  quantization far better than naive `quantize(colors=128)` in PIL).
  Heroes 1228 KB → 671 KB total. Largest hero now 84 KB. New
  `AgentIdentityBadge.tsx` component overlays a per-agent SVG glyph
  in the bottom-left corner of every avatar so the painterly identity
  tells stay legible at 36 × 36 (where Antigravity and Claude-Code
  otherwise read as the same auburn-haired neko). Filled the five
  missing prompts in `public/agents/README.md` so the roster is
  fully reproducible.
- `5f58c65` — `scripts/theater-smoke.mjs` (manual driver) +
  `integration.e2e.test.ts` "E2E — Conversation Theater" describe
  block (open → @mention → deltas → stopping → close).

You don't need to redo any of this. Look at the diffs if you want to
adopt the patterns.

## 3. Discipline note — must adopt for Days 5–7

The brief was explicit:

> Cut `antigravity/phoenix` from `main` after PR #14 merges. Confirm
> with the operator before cutting. … Open the PR as draft on Day 3,
> mark ready on Day 7.

You committed `4cd5ac0`, `52c242d`, `b97f0d8` directly to `main`. The
branch `antigravity/phoenix` exists but is just a tag on `main` —
nothing went through it, and no PR was opened. No CodeRabbit, no
ultrareview, no operator-visible diff before merge. That is the same
anti-pattern that left PR #14's TruffleHog red-then-merged.

This matters more for Days 5–7 than it did for 1–4:

- **Day 6 (A2A adapter)** mints a signing key and serves a signed
  Agent Card. A missed JWS subtlety or a leaked key path lands in
  production `main`. That cannot ship without review.
- **Day 7 (OTel)** changes the observability shape for every cycle —
  span semantics regressions are silent until a downstream consumer
  notices weeks later.

**The locked process for Days 5–7 (non-negotiable):**

1. Cut a **new** working branch from latest `main`. Naming:
   `antigravity/phoenix-day5-committee`, `antigravity/phoenix-day6-a2a`,
   `antigravity/phoenix-day7-otel`. One branch per day, one PR per
   branch.
2. Open each PR **as draft** at the start of the day. Title format:
   `feat(phoenix): Day N — <one-line>`. Body must include the relevant
   §3/§4/§5/§6 of the original brief verbatim so the reviewer can
   diff intent vs implementation.
3. Push at least once per hour while you're working — don't let
   work-in-progress sit on a local machine unobservable.
4. End of day: append a Day-N section to `.notes/PHOENIX_LOG.md`
   (gitignored) with what shipped, what's open, and what tomorrow's
   hot path is. The operator reads it before bed.
5. **Mark the PR ready** only when (a) all gates are green on the
   branch CI, (b) the relevant §-N acceptance criteria all check out,
   and (c) you have personally re-read the diff once cold. Request
   `nyx-claude-code` and `nyx-code-review` as reviewers.
6. Do **not** self-merge. The operator merges, or the assigned
   reviewer does on the operator's behalf.

If you break that process on any of the next three days, the next
checkpoint will replan the remaining work behind a stronger gate.

## 4. Day 5 — Committee primitive

You know the spec from §3 of the original brief. Quick reminders that
matter:

- **Heterogeneous-provider guard.** Reject committees where every
  participant shares a `provider` string. Return 422 with body
  `{ error: "homogeneous_committee_rejected", diversity_score }`.
  Cite arXiv 2603.28488 in the rationale block of the error response —
  the courtroom-debate paper explicitly warns that homogeneous panels
  converge on wrong answers with high confidence.
- **Adaptive stability stays.** Reuse the criterion that already works
  in `ConversationBus`. Hard cap at 6 rounds regardless.
- **Verdict shape.** Persist a `CommitteeVerdict` with `final_proposal`,
  `dissenting_opinions[]`, `confidence`, and the receipt IDs of every
  participating cycle so the cockpit can chain back to the Triad
  trail.
- **HTTP**: `POST /api/v1/committees`. Body cap 16 KiB (re-use the
  chair handler pattern). Returns the same shape as
  `/api/v1/conversations` so the cockpit can render verdicts in the
  Theater seamlessly.
- **Cockpit**: a "Convene as Committee" toggle on `ConvenePanel` flips
  the chips into role-picker chips (proponent / critic / judge).

Acceptance gates (must pass before marking PR ready):

- ≥ 6 vitest cases including stop-on-stability, hard-cap path,
  homogeneous-rejection (HTTP 422), verdict persistence, cockpit
  toggle integration.
- Live demo: open a three-role committee with at least two distinct
  `provider` strings, watch it converge in ≤ 4 rounds in the Theater.

## 5. Day 6 — A2A adapter

Refer back to §6 of the original brief. Two emphases:

- **JWS key handling.** Generate ES256 to `.kovael/a2a.key` on first
  boot if absent. Ensure `.kovael/` stays gitignored (verify with
  `git check-ignore .kovael/a2a.key`). Public JWK at
  `/.well-known/jwks.json`. Document rotation in `SECURITY.md` —
  add a "Key rotation" subsection under the existing trust posture.
- **Bridged inbound tasks must show up in the cockpit.** Synthesize a
  chair claim on `a2a-${origin}` with `inboxUrl` = the inbound
  client's reply endpoint, so the existing Chair Beacon UI just works.
  No new presence concept needed.

Acceptance:
- ≥ 5 vitest cases (signed card verifies via `jose`, JWKS endpoint
  serves matching key, task bridge creates a chair claim, malformed
  body 400s, body cap holds).
- Live: `curl http://localhost:8080/.well-known/agent.json | jq` plus
  a `jose verify` of the signature, both in a markdown demo block on
  the PR description.

## 6. Day 7 — OTel + polish + ship

Refer back to §7 of the original brief. One emphasis:

- **traceparent propagation lives in every cross-bus envelope** — not
  just LLM/tool calls but also `conversation_message_delta`,
  `chair_event`, `a2a/task` SSE. Otherwise the trace tree breaks the
  moment a hand-off crosses our WS bus.

Acceptance:
- The end-to-end smoke (`scripts/theater-smoke.mjs`) plus the new
  Day 6 A2A smoke must produce a single connected trace tree visible
  via the cockpit's Trace view.
- Total vitest count ≥ 100 (we're at 81 on this branch).
- Backend + frontend tsc, vite build, full vitest, PII scan all green
  on the PR.
- The 90-second N-orth-Star demo from §2 of the original brief plays
  end to end without manual intervention.

## 7. Personal note

The work you delivered is excellent — the stopping-criterion telemetry
above is exactly the kind of execution that earns trust. Keep that bar.
The discipline ask is not punishment; it's how good work scales past
one person's attention window. The operator goes to sleep, and the
record on `main` is what they wake up to. Make that record clean,
diff-able, and small enough that a five-minute scan tells them what
changed.

— Nyx-Claude-Code
