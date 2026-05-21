# AG Nyx · Aurora Brief — UI/UX Expansion for a Human Watching the Mesh

**Codename:** AURORA (dawn / awakening — the cockpit becomes welcoming).
**Cadence:** 5 working days.
**Owner:** Antigravity Nyx (Gemini 3 Pro · Antigravity IDE).
**Branch:** `antigravity/aurora` — cut from `main` *after* PHOENIX Days 5-7
land, or fresh from `main` if Days 5-7 are still WIP (do not pile onto
`antigravity/phoenix`; AURORA is additive, not a rebase target).
**Pre-requisite:** claim your chair as `nyx-antigravity` on session start
(see `docs/CHAIRS.md`).

> This brief assumes you have read PR #18's deep brief
> (`docs/briefs/2026-05-ag-nyx-phoenix-deep.md`). AURORA is the
> human-facing layer that sits on top of PHOENIX's Committee + A2A + OTel
> primitives. Treat the PHOENIX work as load-bearing infrastructure: do
> not refactor it, only consume its events and bus types.

---

## 1. The mission, in one sentence

Make the Theater feel like a place a human would happily sit for an hour
and watch nine agents reason together — with the same comfort, control,
and reactions a senior reviewer expects from Slack, the same observable
"show your work" surface a debugger expects from Laminar, and the same
keyboard-first speed a power user expects from Linear.

The shipped Theater works. It is not *delightful*. AURORA closes that gap.

## 2. North Star outcome — the 2-minute screen recording

A recording the operator can hand to another engineer with zero
narration:

1. Operator opens the cockpit. Presses `⌘K`. The command palette opens.
2. Types "convene about retry policy". Palette suggests three chairs
   based on the conversation history + their declared expertise.
3. Enter. The Theater opens. Three portraits **animate into the round
   table**, eye-contact lines drawn between them as they take their
   seats.
4. **Agent A speaks.** Mid-sentence the message body shows an inline
   **tool-call card** ("looking up retry conventions…") that streams a
   structured result.
5. **Agent B replies.** Its reply contains an **inline citation** to
   Agent A's message — clickable, scrolls the transcript to the source.
6. Operator presses `r` and adds a 👍 reaction to Agent A's argument.
   The portrait at the table briefly bows.
7. **Agent C dissents.** Its message shows a "DISSENT" pill. The
   round-table edge between A and C goes amber and pulses.
8. Operator presses `b` to **branch** off Agent B's message. A
   sub-thread spawns with the same three chairs but A muted. The
   sidebar shows the branch tree.
9. The verifier calls the **stopping criterion**. The consensus card
   opens. An "EXPORT TRANSCRIPT" button is now visible.
10. Operator clicks export. A markdown file with portraits, full debate,
    branches, reactions, and tool-call snapshots downloads.

Every frame must look good without explanation. If any frame requires
the operator to mentally translate the UI into a mental model, that
frame is broken and AURORA missed.

## 3. Three things the operator will check first

Use these as your QA-on-yourself lens before opening the PR.

1. **The pressure-valve invariant still holds.** Cockpit must not exceed
   one re-render per 100 ms regardless of stream traffic. Open
   Chromium's performance tab during a streaming convene; the React
   commit rate must average ≤ 10/s, not 50.
2. **No one has to read a CHANGELOG to use the new features.** The `⌘K`
   palette, slash commands, and keyboard shortcuts must be
   self-discoverable inside the cockpit (palette help screen + a
   discreet `?` keybind opens a shortcut sheet).
3. **The cockpit still runs offline.** If the orchestrator is down, the
   Theater must render a useful empty state — not a stack trace and not
   a blank screen. The current `ConnectionBanner` is a load-bearing
   pattern; preserve it.

## 4. Day-by-day plan

Five days, each leaves the cockpit in a shippable state. Push at end of
each day; the operator may subscribe to PR activity and watch CI live.

### Day 1 · Foundation — accessibility, themes, density, palette, keyboard

**Why this first.** Every later day rides on the keyboard layer and the
theme tokens. Build the accelerator surface before the features that
need it.

**Ship.**

- **`packages/spatial-war-room/src/components/cmdk/CommandPalette.tsx`** —
  uses [`cmdk`](https://cmdk.paco.me/) (approved dep). `⌘K` / `Ctrl+K`
  opens. First registered commands: `convene`, `halt`, `branch`,
  `mute <chair>`, `focus <chair>`, `export <topic>`, `clear`, `?`. Each
  command has a short help line + a keyboard hint. Palette closes on
  Esc; remembers last 5 commands.
- **Keyboard hint sheet** behind `?` — modal listing every shortcut.
- **Theme tokens.** Promote the inline Tailwind values for the Obsidian
  Ember palette into CSS custom properties on `:root` (`--ember-orange`,
  `--warm-white`, `--warm-obsidian`, etc.). Add a `[data-theme="light"]`
  override with daylight-readable equivalents. Theme toggle in the
  palette (`/theme light` / `/theme dark` / `/theme auto`).
- **Density modes.** `comfortable` (current) and `compact` (~12 %
  tighter row heights, smaller portraits at 28 × 28). Toggle in palette.
  Persist to `localStorage`.
- **ARIA live regions.** `MessageList` gets `aria-live="polite"
  aria-relevant="additions text"`. Streaming deltas announce by speaker.
  `StoppingCard` gets `role="status"`. Tool-call cards (Day 3) get
  `role="region"` + `aria-label`. Never `assertive` — chat is high-
  volume; assertive interrupts the screen reader.
- **Reduced motion.** Wrap every `animate-pulse`, `animate-[fadeIn]`,
  and SVG path animation with the `motion-safe:` Tailwind variant. The
  cockpit must still convey speaker change + dissent + streaming under
  `prefers-reduced-motion: reduce`; just replace pulses with single
  colour transitions and skip eased path draws.
- **Onboarding tour** — `?tour=aurora` query param. 5-step floating-ui
  tour: palette, round table, threading, tool-cards, export. Dismissable
  forever; remembered in `localStorage`.

**Component files (new):**

- `src/components/cmdk/CommandPalette.tsx`
- `src/components/cmdk/PaletteCommands.ts` (the registry)
- `src/components/help/ShortcutSheet.tsx`
- `src/components/help/OnboardingTour.tsx`
- `src/theme/tokens.css` (CSS custom properties)
- `src/theme/light.css` (light theme overrides)

**What frustrates the operator if you skip this.** They are stuck
clicking when the muscle memory wants `⌘K`. They are stuck on dark
mode in a daylight office. They are stuck reading every streamed token
because the screen reader interrupts itself.

**Perf budget.** CLS < 0.05 on theme toggle. INP < 50 ms during palette
open. Lighthouse a11y ≥ 95.

**Tests.**

- `CommandPalette.spec.tsx` ≥ 8 cases (open/close, fuzzy match, command
  dispatch, recent commands, Esc, focus trap).
- `ShortcutSheet.spec.tsx` ≥ 3 cases.
- `OnboardingTour.spec.tsx` ≥ 3 cases.
- `useTheme.spec.tsx` ≥ 4 cases including system-pref auto mode.
- Add `axe-core` smoke against the Theater layout — zero serious
  violations.

### Day 2 · Conversation primitives — threading, reactions, branches

**Why.** The flat transcript is the single biggest UX gap. Operators
think in replies and parallel exploration.

**Backend additions (`src/services/ConversationBus.ts`):**

- New columns: `parent_message_id TEXT NULL`, `branch_root_id TEXT
  NULL`, both as foreign keys back to `conversation_messages.id`. A
  *branch* is just a topic with `branch_root_id` set; queries already
  scope by `topic_id`, so the model is additive.
- New table:

  ```sql
  CREATE TABLE conversation_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,      -- 'operator' or an agentId
    emoji TEXT NOT NULL,          -- one of the 8 allowed set
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES conversation_messages(id)
  ) STRICT;
  ```

- New endpoints:
  - `POST /api/v1/conversations/:id/messages/:msgId/reactions`
  - `DELETE /api/v1/conversations/:id/messages/:msgId/reactions/:emoji`
  - `POST /api/v1/conversations/:id/branch` — body `{ fromMessageId,
    participants[], muted[] }`
- New WS events:
  - `conversation_reaction_added` / `conversation_reaction_removed`
  - `conversation_branch_opened`

**Cockpit additions:**

- `MessageList` learns to render replies indented under their parent,
  capped at 2 levels deep (deeper replies collapse).
- New `ReactionBar.tsx` — hover a message → 8-emoji popover (👍 ❤️ 🔥
  ⚠️ 🤔 💡 ❌ 🎯). Existing reactions show as pill chips with counts.
- Inline citations — agent-authored content matching the pattern
  `[[msgId]]` renders as a clickable pill that scrolls the transcript
  to the cited message + briefly highlights it.
- Branch sidebar — the topic list grows a tree view. A branched topic
  is indented under its parent topic. Active branch highlighted.

**Store (`useWarRoomStore.ts`).** Extend `ConversationMessage` with
`parentMessageId?: string` and `reactions: Record<emoji, count>`. New
state field `branchByTopic: Record<string, string[]>`. New actions:
`applyReaction`, `openBranch`, `closeBranchTopic`.

**What frustrates the operator if you skip this.** They want to react
"👍 this one" but can only hit HALT or do nothing. They want to fork
the debate at a turning point but instead must mentally replay six
turns to remember where it diverged.

**Perf budget.** Streaming under heavy reaction traffic: still 60 FPS
canvas, no animation jank when a reaction pill appears.

**Tests.**

- `ConversationBus.test.ts` add 6 cases: branch creation, branch-aware
  history queries, reaction add/remove, reaction counts in snapshot,
  parent_message_id round-trip, deletion of parent does not orphan
  children (foreign-key behaviour is documented).
- `MessageList.spec.tsx` add 5 cases: indented reply rendering, deep-
  reply collapse, citation pill click → scroll, reaction popover open,
  reaction pill count.

### Day 3 · Inline tool-use cards + generative UI

**Why.** Trust comes from seeing the work. AG-UI calls this out
explicitly — every tool call is a separate event stream.

**Adopt the AG-UI tool-call lifecycle** ([reference][agui-events]):
`TOOL_CALL_START` → `TOOL_CALL_DELTA` (n) → `TOOL_CALL_END`. Map to our
existing WS bus naming: `conversation_tool_call_start`,
`conversation_tool_call_delta`, `conversation_tool_call_end`. The
ChairBridgeProvider already has the suspension model; extend it to
relay tool-call events alongside text deltas.

**Components:**

- `theater/ToolCallCard.tsx` — collapsed by default, header shows tool
  name + status pill (queued / running / ok / err). Expand to see input
  args (JSON-pretty) + streaming output. Cap height at 240 px with an
  internal scrollbar; do not push the message body off-screen.
- `theater/GenerativeUIFrame.tsx` — sandboxed render slot for
  agent-emitted small components. Whitelist: `KpiCard`, `CompareTable`,
  `CodeBlock`, `Markdown` (with `rehype-sanitize`). Reject anything else
  with a `[[unrenderable component]]` placeholder. **Trust gate:** only
  chairs with `trustTier ≤ 2` may emit generative UI; anything from
  tier 3 (e.g. `shaev`) renders as a plain code block of the proposed
  component for the operator to manually approve.
- `theater/MessageList.tsx` — render tool-call cards interleaved
  between text deltas based on event order.

**What frustrates the operator if you skip this.** They see an agent
type "checked the docs" and have to trust on faith. They see a
recommendation and cannot tell whether the agent actually verified it.

**Perf budget.** Tool-call cards mount cost ≤ 4 ms each. A topic with
20 tool calls in flight does not drop the canvas below 60 FPS.

**Tests.**

- `ToolCallCard.spec.tsx` ≥ 6 cases (closed default, expand, status
  transitions, streaming output, error state, ARIA region).
- `GenerativeUIFrame.spec.tsx` ≥ 5 cases (each whitelisted component
  renders, non-whitelisted shows placeholder, trust-tier rejection,
  sanitiser scrub, broken component does not crash the Theater).

### Day 4 · Round table — state animations, eye-contact, focus

**Why.** The current `Stage.tsx` is a static portrait grid. It does not
*feel* like nine personalities sitting at a table.

**Ship.**

- **Real circular layout.** Replace the grid in `Stage.tsx` with a
  CSS-grid + absolute-positioned ring computed from
  `participants.length`. Up to 9 portraits placed on a circle of radius
  scaled to viewport.
- **Agent state animations** (CSS variables + `data-state`):
  - `idle` — slow ambient glow
  - `listening` — neutral, no glow
  - `thinking` — subtle pulse (motion-safe; replaced with a static
    indicator under reduced-motion)
  - `speaking` — full pulse + accent-coloured halo
  - `dissenting` — red halo, slight 2° tilt (motion-safe; tilt removed
    under reduced-motion)
- **Eye-contact edges** — SVG paths between portraits that draw briefly
  on every `@mention` or reply. Edge colour follows the speaker's
  `accent_hex`. Decays in 800 ms.
- **Focus mode.** Click a portrait → the transcript filters to that
  agent's contributions + everything @-mentioning them. Click again to
  release. Highlighted portrait gets a focus ring; others dim to 40 %.
- **Drag-and-drop chair reordering.** Operator can rearrange the
  positions around the table; persists to `localStorage`. Keep the
  reorder loose — chairs *attract* the closest seat slot.

**What frustrates the operator if you skip this.** Nine portraits in
a grid is information — not theatre. Cards in a row do not convey
"these three are debating each other right now."

**Perf budget.** Stage re-renders only on participant set change or
`activeSpeakerId` change. State changes apply via CSS class swaps, not
React commits.

**Tests.**

- `Stage.spec.tsx` add 6 cases: circular layout for n=3/6/9, eye-contact
  edge spawn + decay, state-attribute mapping, drag reorder persists,
  focus mode dims others.

### Day 5 · Palette commands, slash commands, transcript export, replay, search

**Why.** Day 1 shipped the palette shell. Day 5 fills it with the power
features that compound.

**Ship.**

- **Slash commands in `ConvenePanel` input.** `/convene`, `/halt`,
  `/branch <msgId>`, `/mute <chair>`, `/focus <chair>`, `/summarize`,
  `/export`. Autocomplete dropdown.
- **Transcript export** — markdown with embedded base64-encoded
  portraits (or relative links if downloaded to a folder), full debate
  text, branch tree, reactions, tool-call snapshots. Also JSON for
  tooling. New endpoint `GET
  /api/v1/conversations/:id/export?format=md|json`.
- **Replay scrubber** — for *closed* topics, a timeline at the top of
  the stage with a scrubber. Drag to walk through the conversation
  message-by-message; the stage and message list reflect the moment.
  Uses the persisted topic history; no live stream needed.
- **Conversation search + filter** — `⌘F` in the Theater opens a
  filter bar (text match, by chair, by reaction, by has-tool-call,
  date range).

**What frustrates the operator if you skip this.** They have to copy-
paste 200 messages out of the DOM to share a debate. They have to mentally
re-play a conversation to find the moment a decision was made.

**Perf budget.** Search across 5,000 cached messages returns under 50 ms.
Export of a 200-message topic completes in ≤ 1 s.

**Tests.**

- New `e2e-aurora.spec.tsx` — full screen recording test: convene →
  message → react → branch → close → export → replay-scrub.
- `Search.spec.tsx` ≥ 4 cases.
- `Replay.spec.tsx` ≥ 4 cases.

## 5. GitHub handling (non-negotiable)

This is where AG Nyx repeatedly drifted on PHOENIX Days 1-3. Lock it.

1. **Branch.** `antigravity/aurora` cut from `main` after PHOENIX Days
   5-7 land. Confirm with the operator before cutting if Days 5-7 are
   still WIP.
2. **No direct pushes to `main`.** Ever. Every commit lands via a PR.
3. **Conventional Commits, scoped per day:**
   - `feat(cockpit/aurora-foundation)` Day 1
   - `feat(cockpit/aurora-threading)` Day 2
   - `feat(cockpit/aurora-tools)` Day 3
   - `feat(cockpit/aurora-stage)` Day 4
   - `feat(cockpit/aurora-palette)` Day 5
4. **One commit per coherent piece.** Smaller is fine; bigger needs
   justification in the commit body. Trail every commit with the
   session URL (Claude Code convention) so the operator can audit.
5. **PR cadence.** Open as **draft** on Day 2 morning (after Day 1
   ships). Mark **ready** end of Day 5. Do not request review while a
   day's work is half-wired.
6. **CI must pass before push.** Run locally first:
   - `npx tsc --noEmit` (root)
   - `cd packages/spatial-war-room && npx tsc --noEmit -p tsconfig.app.json`
   - `cd packages/spatial-war-room && npx tsc --noEmit -p tsconfig.test.json`
   - `npx vitest run`
   - PII grep against `.kovael-forbidden-patterns.txt`
7. **No `--no-verify`.** Ever. If a hook fails, fix the underlying
   issue. If a pre-commit hook is wrong, fix the hook in a separate
   PR.
8. **No `--force` to a pushed branch.** Fix-forward with a new commit.
   Pre-commit hook failures did *not* create the commit; create a new
   one rather than `--amend`.
9. **Address Copilot's factual nits.** When the bot flags drift,
   broken commands, missing required fields — fix and push the fix.
   When it flags subjective opinions, reply with reasoning or leave it
   for the operator to call.
10. **Squash-merge.** Project convention. Use the PR title as the
    commit-message title.
11. **Listen, don't poll.** When the operator subscribes to PR
    activity, your event stream will deliver CI failures and review
    comments. Act on them; do not `sleep` in a loop waiting for status.

## 6. Guardrails (additive to PHOENIX guardrails)

- **Pressure-valve invariant.** Still 100 ms. New animations use CSS
  classes + transitions, not React state. Reactions, citations, tool
  calls all go through the existing flush.
- **AG-UI naming.** New WS types `conversation_*`, `committee_*`,
  `a2a_*`, `tool_call_*` only.
- **MevBridge routing.** Untouched. AURORA is additive UI on top of an
  unchanged Triad.
- **PersonaLoader / WorkflowLoader.** Treat as stable APIs. Read, do not
  refactor.
- **New deps allowed without question:** `cmdk`, `@radix-ui/react-dialog`,
  `@radix-ui/react-popover`, `@radix-ui/react-toast`,
  `@radix-ui/react-tooltip`, `react-aria-components`, `rehype-sanitize`.
  Anything else: justify in the commit body or skip.
- **Bundle size.** Run `npm run build` after Day 5; the cockpit JS
  bundle must stay under 800 KiB gzipped. If it crosses, lazy-load
  Aurora chunks.

## 7. CI & test gates

- All existing gates (orchestrator typecheck, cockpit typecheck, test
  fixtures typecheck under `tsconfig.test.json`, vitest, TruffleHog,
  forbidden-strings scan, Socket).
- **New:** `axe-core` smoke step in the cockpit job — fails the build
  on serious a11y violations against the rendered Theater HTML.
- **Test count target by end of week.** ≥ 200 (currently 153 on main).
  Aurora must add ≥ 47.

## 8. PII discipline (public repo)

Identical to PHOENIX:

- No operator handle in any commit, branch banter, persona card, test
  fixture, screenshot caption, or generated transcript.
- No biographical references in personas, transcripts, or sample
  topics.
- Public-repo discipline on every file under `personas/`,
  `docs/briefs/`, `public/agents/`, `agent_cards/`.
- Local plans + scratch notes belong in `.notes/` (gitignored).
- Run `grep` against `.kovael-forbidden-patterns.txt` before every push.

## 9. Out of scope

- **Voice / TTS / audio.** Shaev's lore is tempting; defer to a
  future brief.
- **Mobile-first layout.** Cockpit stays desktop-first; only add
  responsive breakpoints for tablet sanity.
- **Real LLM provider integration.** ChairBridgeProvider is the
  contract; key wiring is a separate ticket.
- **WS authentication.** Localhost trust posture continues; auth is a
  separate effort.
- **Replacing the round-table metaphor.** No xyflow canvas in the
  Theater; the round table is the contract.

## 10. Daily handoff format

End of each day, append to `.notes/AURORA_LOG.md` (gitignored):

```
## Day N — YYYY-MM-DD

**Shipped:** ...
**Open questions for operator:** ...
**Tomorrow's hot path:** ...
**Perf measured:** INP=...ms, CLS=..., axe-serious=...
```

If anything ambiguous, write the question into the log AND ping the
operator via PR comment. Do not silently re-interpret scope.

## 11. References (the five worth re-reading)

- **AG-UI 17 event types** — https://www.copilotkit.ai/blog/master-the-17-ag-ui-event-types-for-building-agents-the-right-way
- **CopilotKit streaming + tool calls** — https://docs.copilotkit.ai/langgraph/concepts/copilotkit-config
- **Perspectra (choose-your-experts multi-agent UX)** — https://arxiv.org/pdf/2509.20553
- **Laminar agent rollout debugger** — https://laminar.sh/article/2026-04-23-top-6-agent-observability-platforms
- **ARIA live regions implementor's guide** — https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/ARIA_Screen_Reader_Implementors_Guide

## 12. Quick-start checklist (Day 1, first hour)

1. Confirm PHOENIX Days 5-7 status with the operator; cut
   `antigravity/aurora` from `main` accordingly.
2. Claim your chair:
   `node scripts/kovael-chair.mjs --id nyx-antigravity --provider "Google · Gemini 3 Pro (Antigravity IDE)" --capabilities comfyui,blender,browser,desktop --trust 1 &`
3. Open the cockpit; confirm your beacon is LIVE.
4. Install Day 1 deps: `cd packages/spatial-war-room && npm install cmdk @radix-ui/react-dialog @radix-ui/react-popover`.
5. Build the palette shell first (open/close + Esc) — that proves the
   keyboard + focus-trap pipeline works. Every later day extends this
   shell.

Sign every commit. Tell us what you learned. Aurora is dawn — keep the
cockpit feeling like sunrise the whole way through.

— Nyx-Claude-Code, on behalf of the operator

[agui-events]: https://www.copilotkit.ai/blog/master-the-17-ag-ui-event-types-for-building-agents-the-right-way
