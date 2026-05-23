# APEX Adversary Audit Report

Status: implementation branch
Date: 2026-05-23
Branch: `apex/adversary-audit`

## Controller Summary

### OBSERVE

- Source reconciliation found no local or visible remote APEX branch containing `Router.ts`,
  `ComfyUiBridge.ts`, `TraceComfyBridge.ts`, or `ShortcutSheet.tsx`.
- The active work was isolated in a separate worktree before edits so the dirty
  `main` checkout remains untouched.
- Existing HTTP and WebSocket contracts are still owned by `src/MeshOrchestrator.ts`;
  no route shape changes were introduced.
- Targeted adversary tests now cover rejected WebSocket upgrade storms, ComfyUI
  fallback behavior, subprocess safety expectations, bounded trace storage, and
  theater shortcut/modal behavior.

### DISTILL

- WebSocket upgrade authentication previously happened before a rate-limit debit,
  so malformed upgrade floods could churn gate state without hitting the existing
  limiter.
- ComfyUI support was missing, which meant the requested portrait pipeline had no
  safe integration boundary or deterministic disabled/offline behavior.
- Trace retention was count-bounded but not byte-bounded; very large attributes or
  event payloads could remain referenced inside the ring.
- The theater stage recalculated seat layout from high-churn roster objects even
  when render-relevant fields were unchanged.

### REUSE

- WebSocket upgrades now reuse `RateLimiter.clientKey()` and `consume()` before
  auth verification.
- `ComfyUiBridge` uses `fetch` for REST calls and keeps subprocess execution out
  of the bridge.
- `TraceRingBuffer` now sanitizes and bounds stored trace payloads before retention.
- `Stage` exports a memo comparator so equivalent roster snapshots can be reused
  without seat-layout churn.

### REFINE

- `node scripts/validate-pr.mjs` passed on 2026-05-23. It ran root build,
  root tests, cockpit typechecks, cockpit build, and the changed-file secret scan.
- Root tests passed with 32 files, 261 passed tests, and 2 skipped tests.
- Cockpit Vite build split `ShortcutSheet` into a 3.74 kB chunk; the main JS chunk
  was 472.70 kB, below the 800 KiB watch boundary.
- `node scripts/validate-all-chairs.mjs` passed on 2026-05-23: all 9 chairs
  claimed, every chair received dispatch traffic, replies were observed, bus
  convene completed, and the triad receipt was verified.
- `scripts/validate-pr.mjs` can include the all-chairs run with
  `KOVAEL_VALIDATE_ALL_CHAIRS=true`; the direct all-chairs command was also run
  for this signoff so it is no longer deferred.

## Subagent 1: ComfyUI Wave Expansion Specialist

### OBSERVE

- No bridge file existed before this branch.
- The requested ComfyUI surface can be covered with REST calls to port `8100`
  without invoking shell commands.
- Offline behavior is required because local ComfyUI availability is not guaranteed.

### DISTILL

- The bridge must default off and fail closed into deterministic metadata rather
  than blocking portrait generation on a local service.
- Prompt, LoRA, and aspect schema input should shape JSON payloads only; shell
  command interpolation is not needed for any bridge behavior.

### REUSE

- Added `src/services/ComfyUiBridge.ts` with aspect schemas, optional LoRA
  injection arrays, HSL palette metadata, and deterministic fallback SVG metadata.
- Added tests for disabled mode, unavailable ComfyUI fallback, LoRA/aspect request
  shaping, and absence of shell-interpreted child process APIs.

### REFINE

- Fallback output dimensions stay at or above 1024px on each rendered axis.
- The bridge returns explicit `source` values of `comfyui` or `fallback` so callers
  can audit whether a local render occurred.

## Subagent 2: Theater UI Performance Optimization Engineer

### OBSERVE

- `Stage.tsx` already owned the circular theater layout.
- No `ShortcutSheet.tsx` existed before this branch.
- Shortcut UI can be lazy-loaded because it is an occasional command surface.

### DISTILL

- Stage updates should react to active speaker and display-relevant roster fields,
  not object identity churn.
- Accent styling can be expressed through CSS custom properties on the seat root
  to keep the render path simple.

### REUSE

- Added `areStagePropsEqual()` and a roster signature helper.
- Added `ShortcutSheet.tsx` and dynamically imported it from `SpatialWarRoom`.
- Added tests for comparator stability and shortcut sheet dismissal.

### REFINE

- The component suite passes for targeted theater tests.
- Bundle analysis ran through the cockpit build in `scripts/validate-pr.mjs`; the
  main JS chunk is 472.70 kB and the lazy shortcut chunk is 3.74 kB.

## Subagent 3: Telemetry And Flowchart Renderer Specialist

### OBSERVE

- `TraceRingBuffer` enforced count capacity but not serialized payload size.
- Trace snapshots can contain nested attributes, event payloads, and exception
  values large enough to become retention pressure.
- The requested flowchart output did not exist before this branch.

### DISTILL

- The storage boundary needs to sever references to original span objects and
  compact payloads before putting them in the ring.
- Flowchart rendering must escape agent IDs, span names, and token metadata before
  inserting values into SVG or HTML.

### REUSE

- Added byte and field guards to `TraceRingBuffer`.
- Added `src/services/TraceComfyBridge.ts` with sanitized SVG and HTML renderers.
- Added tests for oversized trace payloads, escaped labels, token tooltip data,
  confidence, and active interval display.

### REFINE

- Targeted trace tests pass with massive attributes and event payloads.
- Generated SVG/HTML includes agent turn counts, token estimates, confidence, and
  active durations without retaining original trace object references.
