# Spatial War Room

Spatial War Room is Kovael's React cockpit. It connects to the
orchestrator over HTTP and WebSocket, renders the chair roster and mesh
canvas, and provides the Conversation Theater, committee drawer, ComfyUI
mixer, and trace timeline surfaces.

## Stack

- React 19
- Vite 8
- TypeScript 6
- Tailwind CSS 4
- xyflow 12
- Zustand 5
- lucide-react
- Vitest, happy-dom, and Testing Library for component tests

## Development

From the repository root:

```bash
npm install
npm run dev --workspace=packages/spatial-war-room
```

Or use the root shortcut:

```bash
npm run showcase
```

The dev server uses Vite's default port, normally `5173`. It expects the
Kovael orchestrator to be available on `http://127.0.0.1:8080` for live
mesh data.

## Verification

```bash
npm run typecheck --workspace=packages/spatial-war-room
npm run typecheck:tests --workspace=packages/spatial-war-room
npm run build --workspace=packages/spatial-war-room
```

The root `node scripts/validate-pr.mjs` command also runs these cockpit
checks as part of the full PR gate.

## Layout

- `src/SpatialWarRoom.tsx` - main cockpit shell and WebSocket handling.
- `src/components/` - roster, canvas, console, status, and shared UI.
- `src/components/theater/` - Conversation Theater, traces, committee,
  ComfyUI mixer, and message surfaces.
- `src/store/useWarRoomStore.ts` - Zustand state model and orchestrator
  API calls.
- `public/agents/` - canonical chair portraits and thumbnails.
- `test/` - smoke and component tests.
