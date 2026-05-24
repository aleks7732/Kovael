# HTTP Router Split Delta Notes

Date: 2026-05-24
Branch: `test/coverage-gaps-qc`

## Scope

This note records the measured delta after splitting
`src/services/HttpApiRouter.ts` into a thin dispatcher plus route modules under
`src/services/http/`.

## Measured Delta

| Metric | Before split | After split | Delta |
| --- | ---: | ---: | ---: |
| `HttpApiRouter.ts` measured lines | 599 | 145 | -454 |
| `HttpApiRouter.ts` source-file graph edges | 266 | 59 | -207 |
| Repository graph nodes | 1,480 | 1,558 | +78 |
| Repository graph edges | 3,998 | 4,007 | +9 |
| Repository graph communities | 224 | 229 | +5 |
| Full test suite | 445 passed, 4 skipped | 445 passed, 4 skipped | unchanged |

Current measured line counts:

| File | Lines |
| --- | ---: |
| `src/services/HttpApiRouter.ts` | 145 |
| `src/services/http/HttpApiSupport.ts` | 107 |
| `src/services/http/StateRoutes.ts` | 52 |
| `src/services/http/ComfyRoutes.ts` | 99 |
| `src/services/http/TraceRoutes.ts` | 68 |
| `src/services/http/ChairRoutes.ts` | 95 |
| `src/services/http/ConversationRoutes.ts` | 118 |

Current HTTP route graph edge counts:

| File | Source-file edges |
| --- | ---: |
| `src/services/HttpApiRouter.ts` | 59 |
| `src/services/http/HttpApiSupport.ts` | 30 |
| `src/services/http/StateRoutes.ts` | 27 |
| `src/services/http/ComfyRoutes.ts` | 44 |
| `src/services/http/TraceRoutes.ts` | 33 |
| `src/services/http/ChairRoutes.ts` | 46 |
| `src/services/http/ConversationRoutes.ts` | 52 |

## Interpretation

The main win is blast-radius reduction. The router dispatcher is no longer the
top Graphify source-file hub, and no extracted route/support module crosses 120
measured lines.

The total HTTP route source-file edge count is 291 after the split, which is
slightly higher than the old single-file count. That is expected because
Graphify now sees explicit route-module imports and shared support boundaries.
The useful signal is that those edges are no longer concentrated in one
monolithic router file.

## Validation

The split was validated with:

```bash
npx tsc --noEmit
npx vitest run
node scripts/validate-pr.mjs
npx -y @nodesify/graphify run .
```

`validate-pr.mjs` completed the root build, root tests, spatial war-room
typechecks/build, and changed-file secret scan successfully.
