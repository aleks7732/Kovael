# HTTP API Router Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `src/services/HttpApiRouter.ts` from a high-risk routing hub into a thin HTTP boundary plus focused route modules, with no public API or response-shape changes.

**Architecture:** Keep `HttpApiRouter` responsible for server construction, socket/header deadlines, CORS preflight, probe dispatch, API auth, API rate limiting, and route selection. Move route behavior into small modules under `src/services/http/`, sharing one audited JSON/CORS/body utility module. Preserve `MeshOrchestrator` construction and all `/api/v1/*`, `/livez`, `/readyz`, and `/metrics` contracts.

**Tech Stack:** TypeScript 6, NodeNext ESM imports with `.js` suffixes, Vitest, Node `http`, existing `MeshOrchestrator` integration harness.

---

## Why This Is The Next Best Step

The 2026-05-24 graph pass showed `src/services/HttpApiRouter.ts` as the largest source-file hub by edge count, ahead of `src/MeshOrchestrator.ts`. Stage-6 already separated WebSocket, tracing, committee voting, and inter-agent chat concerns. The next highest-value move is therefore not a new feature; it is decomposing the HTTP API surface while locking down route contracts.

This should be one contained PR because:

- It directly addresses the current graph hotspot.
- It reduces review blast radius for future auth, rate-limit, body parsing, and route work.
- It keeps external contracts stable.
- It creates focused test seams for route families before later feature work.

## Non-Goals

- Do not change `MeshOrchestrator` constructor signatures.
- Do not rename existing HTTP paths.
- Do not change response status codes or JSON field names except where a test exposes an existing undocumented bug and the fix is explicitly scoped.
- Do not add runtime dependencies.
- Do not refactor `boot-mesh.ts` logging.
- Do not convert HTTP route modules into classes unless the function form proves awkward during implementation.
- Do not add a router framework.

## Target File Structure

Create these files:

- `src/services/http/HttpApiSupport.ts`  
  Owns CORS headers, `writeJson()`, `writeNoContent()`, `readJsonBody()`, `createRequestUrl()`, and shared route-handler types.

- `src/services/http/StateRoutes.ts`  
  Owns `/api/v1/state` snapshot construction.

- `src/services/http/ChairRoutes.ts`  
  Owns `/api/v1/chairs`, `/api/v1/chairs/snapshot`, `/api/v1/chairs/claim`, `/api/v1/chairs/heartbeat`, `/api/v1/chairs/release`, and `/api/v1/chairs/reply`.

- `src/services/http/ConversationRoutes.ts`  
  Owns `/api/v1/conversations`, message, history, close, and committee routes.

- `src/services/http/TraceRoutes.ts`  
  Owns `/api/v1/traces`, `/api/v1/traces/:cycleId`, and `/api/v1/traces/reroute`.

- `src/services/http/ComfyRoutes.ts`  
  Owns `/api/v1/comfy/render`, `/api/v1/comfy/mix`, `/api/v1/comfy/stream-url`, and Comfy-specific request sanitizers.

- `src/__tests__/HttpApiRouteContracts.test.ts`  
  Adds route-family contract coverage before extraction begins.

Modify these files:

- `src/services/HttpApiRouter.ts`  
  Becomes the thin dispatcher. It imports support helpers and route modules, retains timeout and auth/rate-limit behavior, and exports `HttpTimeouts` / `DEFAULT_HTTP_TIMEOUTS` unchanged.

- `docs/architecture/mesh-orchestrator-graph-map.md`  
  Update after the final graph pass with new router source-file edge counts.

- `docs/architecture/feature-gap-analysis-2026-05-23.md`  
  Update after the final graph pass if the top hotspot changes.

## Implementation Sequence

Each task should end with a commit. Keep commits small so a regression can be reverted without losing unrelated extraction work.

---

### Task 1: Add Route Contract Baseline Tests

**Files:**
- Create: `src/__tests__/HttpApiRouteContracts.test.ts`

- [ ] **Step 1: Add the test file**

Create `src/__tests__/HttpApiRouteContracts.test.ts` with this structure. The tests intentionally exercise real HTTP because the behavior being preserved is the public contract.

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';

describe('HttpApiRouter — route contracts', () => {
    let orchestrator: MeshOrchestrator;
    let port = 0;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0, { dbPath: ':memory:' });
        port = await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    const api = (path: string) => `http://127.0.0.1:${port}${path}`;

    it('GET /api/v1/state returns the stable top-level state shape', async () => {
        const res = await fetch(api('/api/v1/state'));
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');

        const body = await res.json() as Record<string, unknown>;
        expect(body).toMatchObject({
            agentCards: expect.any(Number),
            connectedClients: expect.any(Number),
            nodes: expect.any(Number),
            tasksTotal: expect.any(Number),
            receiptsIssued: expect.any(Number),
            claims: expect.objectContaining({
                stats: expect.any(Object),
                pending: expect.any(Array),
            }),
            chairs: expect.objectContaining({
                stats: expect.any(Object),
                roster: expect.any(Array),
            }),
            circuits: expect.any(Array),
            learningMatrix: expect.objectContaining({
                entries: expect.any(Number),
            }),
        });
    });

    it('chair snapshot and method handling remain stable', async () => {
        const snapshot = await fetch(api('/api/v1/chairs/snapshot'));
        expect(snapshot.status).toBe(200);
        expect(await snapshot.json()).toMatchObject({
            chairs: expect.any(Array),
            stats: expect.any(Object),
        });

        const unsupported = await fetch(api('/api/v1/chairs/claim'), { method: 'GET' });
        expect(unsupported.status).toBe(405);
        expect(await unsupported.json()).toEqual({ error: 'method_not_allowed' });
    });

    it('chair claim, heartbeat, and release routes preserve session semantics', async () => {
        const claim = await fetch(api('/api/v1/chairs/claim'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'contract-chair', provider: 'vitest' }),
        });
        expect(claim.status).toBe(200);
        const claimed = await claim.json() as { agentId: string; sessionId: string };
        expect(claimed.agentId).toBe('contract-chair');
        expect(typeof claimed.sessionId).toBe('string');

        const heartbeat = await fetch(api('/api/v1/chairs/heartbeat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: claimed.agentId, sessionId: claimed.sessionId }),
        });
        expect(heartbeat.status).toBe(200);
        expect(await heartbeat.json()).toMatchObject({
            status: expect.any(String),
            lastBeaconAt: expect.any(Number),
        });

        const release = await fetch(api('/api/v1/chairs/release'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: claimed.agentId, sessionId: claimed.sessionId }),
        });
        expect(release.status).toBe(200);
        expect(await release.json()).toEqual({ released: true });
    });

    it('conversation topic, message, history, and close routes preserve JSON contracts', async () => {
        const topicRes = await fetch(api('/api/v1/conversations'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Contract Topic', participants: ['nyx-codex'] }),
        });
        expect(topicRes.status).toBe(200);
        const topic = await topicRes.json() as { id: string; title: string };
        expect(topic.title).toBe('Contract Topic');

        const messageRes = await fetch(api(`/api/v1/conversations/${topic.id}/message`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ senderId: 'operator', content: 'hello' }),
        });
        expect(messageRes.status).toBe(200);
        expect(await messageRes.json()).toMatchObject({
            topicId: topic.id,
            senderId: 'operator',
            role: 'user',
            content: 'hello',
        });

        const historyRes = await fetch(api(`/api/v1/conversations/${topic.id}/history`));
        expect(historyRes.status).toBe(200);
        expect(Array.isArray(await historyRes.json())).toBe(true);

        const closeRes = await fetch(api(`/api/v1/conversations/${topic.id}/close`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(closeRes.status).toBe(200);
        expect(await closeRes.json()).toEqual({ success: true });
    });

    it('trace routes preserve list, detail miss, and reroute contracts', async () => {
        const list = await fetch(api('/api/v1/traces?limit=5'));
        expect(list.status).toBe(200);
        expect(await list.json()).toMatchObject({
            items: expect.any(Array),
        });

        const missing = await fetch(api('/api/v1/traces/missing-cycle-id'));
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
            error: 'trace_not_found',
            cycleId: 'missing-cycle-id',
        });

        const reroute = await fetch(api('/api/v1/traces/reroute'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'agent.a', target: 'trace:b', sourceHandle: 'out' }),
        });
        expect(reroute.status).toBe(200);
        expect(await reroute.json()).toMatchObject({
            type: 'trace.rerouted',
            source: 'agent.a',
            target: 'trace:b',
            sourceHandle: 'out',
            requestedAt: expect.any(Number),
        });
    });

    it('Comfy render and stream-url routes preserve fallback metadata contracts', async () => {
        const render = await fetch(api('/api/v1/comfy/mix'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agentId: 'nyx-codex',
                prompt: 'operator portrait',
                aspectRatio: 'theater-card',
                mixer: [{ recipeId: 'nyx\nrecipe', strength: 5, denoise: -1 }],
            }),
        });
        expect(render.status).toBe(200);
        const rendered = await render.json() as Record<string, unknown>;
        expect(rendered).toMatchObject({
            source: 'fallback',
            agentId: 'nyx-codex',
            width: 1280,
            height: 720,
            mimeType: 'image/svg+xml',
        });
        expect(rendered).not.toHaveProperty('workflow');

        const streamUrl = await fetch(api('/api/v1/comfy/stream-url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promptId: 'prompt-123', clientId: 'client-1' }),
        });
        expect(streamUrl.status).toBe(200);
        expect(await streamUrl.json()).toMatchObject({
            promptId: 'prompt-123',
        });
    });

    it('unknown route-family actions preserve 404 JSON errors', async () => {
        const chairs = await fetch(api('/api/v1/chairs/not-a-real-action'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(chairs.status).toBe(404);
        expect(await chairs.json()).toEqual({
            error: 'unknown_chair_action',
            action: 'not-a-real-action',
        });

        const comfy = await fetch(api('/api/v1/comfy/not-a-real-action'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(comfy.status).toBe(404);
        expect(await comfy.json()).toEqual({
            error: 'unknown_comfy_action',
            action: 'not-a-real-action',
        });
    });
});
```

Remove `vi` from the import if TypeScript reports it unused.

- [ ] **Step 2: Run the new baseline test**

Run:

```bash
npx vitest run src/__tests__/HttpApiRouteContracts.test.ts
```

Expected:

```text
Test Files  1 passed
```

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/HttpApiRouteContracts.test.ts
git commit -m "test: add HTTP route contract baseline"
```

---

### Task 2: Extract Shared HTTP Support

**Files:**
- Create: `src/services/http/HttpApiSupport.ts`
- Modify: `src/services/HttpApiRouter.ts`
- Test: `src/__tests__/HttpApiRouter.test.ts`, `src/__tests__/HttpApiRouteContracts.test.ts`

- [ ] **Step 1: Create the shared support module**

Create `src/services/http/HttpApiSupport.ts`:

```typescript
import * as http from 'node:http';

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, traceparent, tracestate',
} as const;

export type JsonBody = Record<string, unknown>;
export type JsonWriter = (res: http.ServerResponse, status: number, body: unknown) => void;
export type JsonBodyReader = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    maxBytes?: number,
    timeoutMs?: number,
) => Promise<JsonBody | null>;

export interface RouteDeps {
    readJsonBody: JsonBodyReader;
    writeJson: JsonWriter;
}

export function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...CORS_HEADERS,
    });
    res.end(JSON.stringify(body));
}

export function writeNoContent(res: http.ServerResponse): void {
    res.writeHead(204, {
        ...CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
        'Content-Length': '0',
    });
    res.end();
}

export function createRequestUrl(req: http.IncomingMessage): URL {
    return new URL(req.url || '/', `http://${req.headers.host}`);
}

export function readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    maxBytes: number = 16 * 1024,
    timeoutMs: number = 15_000,
): Promise<JsonBody | null> {
    return new Promise((resolve) => {
        let received = 0;
        const chunks: Buffer[] = [];
        let done = false;

        const finish = () => { done = true; clearTimeout(timer); };

        const timer = setTimeout(() => {
            if (done) return;
            finish();
            writeJson(res, 408, { error: 'body_read_timeout' });
            req.destroy(new Error('body_read_timeout'));
            resolve(null);
        }, timeoutMs);
        timer.unref();

        req.on('data', (chunk: Buffer) => {
            if (done) return;
            received += chunk.length;
            if (received > maxBytes) {
                finish();
                writeJson(res, 413, { error: 'payload_too_large', max_bytes: maxBytes });
                req.destroy(new Error('payload_too_large'));
                resolve(null);
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (done) return;
            finish();
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw) as JsonBody);
            } catch {
                writeJson(res, 400, { error: 'invalid_json' });
                resolve(null);
            }
        });

        req.on('error', () => {
            if (done) return;
            finish();
            writeJson(res, 400, { error: 'request_stream_error' });
            resolve(null);
        });
    });
}
```

- [ ] **Step 2: Wire support into `HttpApiRouter`**

In `src/services/HttpApiRouter.ts`, add:

```typescript
import { readJsonBody, writeJson, writeNoContent } from './http/HttpApiSupport.js';
```

Then make these mechanical edits:

- Replace the inline CORS `OPTIONS` block body with `writeNoContent(res);`.
- Replace `this.writeJson(` with `writeJson(`.
- Replace `this.readJsonBody(` with `readJsonBody(`.
- Delete the private `writeJson()` and `readJsonBody()` methods from `HttpApiRouter`.

No route behavior should change in this task.

- [ ] **Step 3: Run focused tests**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/HttpApiRouter.test.ts src/__tests__/HttpApiRouteContracts.test.ts
```

Expected:

```text
tsc exits 0
Test Files  2 passed
```

- [ ] **Step 4: Commit**

```bash
git add src/services/http/HttpApiSupport.ts src/services/HttpApiRouter.ts
git commit -m "refactor: extract HTTP API support helpers"
```

---

### Task 3: Extract State Route

**Files:**
- Create: `src/services/http/StateRoutes.ts`
- Modify: `src/services/HttpApiRouter.ts`
- Test: `src/__tests__/HttpApiRouteContracts.test.ts`

- [ ] **Step 1: Create `StateRoutes.ts`**

Create `src/services/http/StateRoutes.ts`:

```typescript
import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';

export function handleStateSnapshot(context: OrchestratorContext, _req: http.IncomingMessage, res: http.ServerResponse): void {
    const snapshot = {
        timestamp: Date.now(),
        agentCards: context.agentCards.length,
        connectedClients: context.wss?.clients?.size ?? 0,
        nodes: context.nodeCache.size,
        tasksTotal: context.taskCache.length,
        receiptsIssued: context.receiptsIssued,
        activeCycles: Array.from(context.activeCycles.values()).slice(-20),
        hardware: context.hardwareCache,
        claims: {
            stats: context.claims.stats(),
            pending: context.claims.snapshot().slice(-20),
        },
        retryQueue: {
            pendingCount: context.retryQueue?.pendingCount() ?? 0,
            pending: context.retryQueue?.snapshot() ?? [],
        },
        reconciler: context.reconciler?.stats() ?? null,
        workspaces: {
            root: context.workspaces?.root() ?? '',
            active: context.workspaces?.activeCount() ?? 0,
        },
        hooks: context.hooks?.stats() ?? null,
        workflow: {
            loaded: !!context.workflowLoader?.document(),
            lastError: context.workflowLoader?.lastErrorMessage() ?? null,
            version: context.workflowLoader?.document()?.frontMatter?.version ?? null,
            loadedAt: context.workflowLoader?.document()?.loadedAt ?? null,
        },
        tokens: { ...context.tokenTotals },
        rateLimits: context.rateLimits?.allSnapshots() ?? [],
        chairs: {
            stats: context.chairs.stats(),
            roster: context.chairs.snapshot(),
        },
        circuits: context.circuitBreaker.snapshot(),
        learningMatrix: context.learningMatrix.stats(),
    };
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(snapshot));
}
```

- [ ] **Step 2: Wire `HttpApiRouter`**

Import:

```typescript
import { handleStateSnapshot } from './http/StateRoutes.js';
```

Replace:

```typescript
this.handleStateSnapshot(req, res);
```

with:

```typescript
handleStateSnapshot(this.context, req, res);
```

Delete the private `handleStateSnapshot()` method from `HttpApiRouter`.

- [ ] **Step 3: Run focused tests**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/HttpApiRouteContracts.test.ts
```

Expected: TypeScript passes and the route-contract test file passes.

- [ ] **Step 4: Commit**

```bash
git add src/services/http/StateRoutes.ts src/services/HttpApiRouter.ts
git commit -m "refactor: extract HTTP state route"
```

---

### Task 4: Extract Comfy Routes

**Files:**
- Create: `src/services/http/ComfyRoutes.ts`
- Modify: `src/services/HttpApiRouter.ts`
- Test: `src/__tests__/HttpApiRouter.test.ts`, `src/__tests__/HttpApiRouteContracts.test.ts`, `src/__tests__/Orchestrator.test.ts`

- [ ] **Step 1: Create `ComfyRoutes.ts`**

Create `src/services/http/ComfyRoutes.ts` by moving the current `handleComfyRequest()`, `ALLOWED_ASPECT_RATIOS`, `safeAspectRatio()`, `sanitizeMixer()`, and `boundedNumber()` logic out of `HttpApiRouter.ts`.

Use this wrapper signature:

```typescript
import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';
import type { ComfyAspectRatio, LoraMixerUpdate } from '../ComfyUiBridge.js';
import type { RouteDeps } from './HttpApiSupport.js';
import { createRequestUrl } from './HttpApiSupport.js';

export async function handleComfyRequest(
    context: OrchestratorContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: RouteDeps,
): Promise<void> {
    if (req.method !== 'POST') {
        deps.writeJson(res, 405, { error: 'method_not_allowed' });
        return;
    }

    const url = createRequestUrl(req);
    const action = url.pathname.replace(/^\/api\/v1\/comfy\/?/, '') || '';

    const body = await deps.readJsonBody(req, res);
    if (body === null) return;

    if (action === 'render' || action === 'mix') {
        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!agentId || !prompt) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['agentId', 'prompt'] });
            return;
        }
        try {
            const mixer = Array.isArray(body.mixer) ? sanitizeMixer(body.mixer) : [];
            const result = mixer.length > 0
                ? await context.comfyBridge.renderWithMixer({
                      agentId,
                      prompt,
                      aspectRatio: safeAspectRatio(body.aspectRatio),
                      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
                      mixer,
                   })
                : await context.comfyBridge.renderPortrait({
                      agentId,
                      prompt,
                      aspectRatio: safeAspectRatio(body.aspectRatio),
                      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
                   });
            const stream = result.promptId ? context.comfyBridge.streamDescriptor(result.promptId) : undefined;
            deps.writeJson(res, 200, {
                source: result.source,
                agentId: result.agentId,
                width: result.width,
                height: result.height,
                mimeType: result.mimeType,
                promptId: result.promptId,
                svg: result.svg,
                palette: result.palette,
                error: result.error,
                stream,
            });
        } catch (err) {
            deps.writeJson(res, 500, { error: 'comfy_render_failed', message: err instanceof Error ? err.message : String(err) });
        }
        return;
    }

    if (action === 'stream-url') {
        const promptId = typeof body.promptId === 'string' ? body.promptId.trim() : '';
        if (!promptId) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['promptId'] });
            return;
        }
        deps.writeJson(res, 200, context.comfyBridge.streamDescriptor(promptId, typeof body.clientId === 'string' ? body.clientId : undefined));
        return;
    }

    deps.writeJson(res, 404, { error: 'unknown_comfy_action', action });
}
```

Append the current helper functions under that wrapper unchanged, except their import paths now come from `../ComfyUiBridge.js`.

- [ ] **Step 2: Wire `HttpApiRouter`**

Import:

```typescript
import { handleComfyRequest } from './http/ComfyRoutes.js';
```

Replace:

```typescript
this.handleComfyRequest(req, res);
```

with:

```typescript
handleComfyRequest(this.context, req, res, { readJsonBody, writeJson });
```

Delete the private `handleComfyRequest()` and Comfy helper functions from `HttpApiRouter.ts`.

- [ ] **Step 3: Run focused tests**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/HttpApiRouter.test.ts src/__tests__/HttpApiRouteContracts.test.ts src/__tests__/Orchestrator.test.ts
```

Expected: TypeScript passes and all selected tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/http/ComfyRoutes.ts src/services/HttpApiRouter.ts
git commit -m "refactor: extract HTTP Comfy routes"
```

---

### Task 5: Extract Trace Routes

**Files:**
- Create: `src/services/http/TraceRoutes.ts`
- Modify: `src/services/HttpApiRouter.ts`
- Test: `src/__tests__/Tracing.test.ts`, `src/__tests__/HttpApiRouteContracts.test.ts`, `src/__tests__/Orchestrator.test.ts`

- [ ] **Step 1: Create `TraceRoutes.ts`**

Create `src/services/http/TraceRoutes.ts` by moving the current `handleTracesRequest()`, `safeNodeId()`, and `safeOptionalNodeId()` logic out of `HttpApiRouter.ts`.

Use this wrapper signature:

```typescript
import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';
import type { RouteDeps } from './HttpApiSupport.js';
import { createRequestUrl } from './HttpApiSupport.js';

export async function handleTracesRequest(
    context: OrchestratorContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: RouteDeps,
): Promise<void> {
    const url = createRequestUrl(req);
    if (req.method === 'POST' && url.pathname === '/api/v1/traces/reroute') {
        const body = await deps.readJsonBody(req, res, 8 * 1024);
        if (body === null) return;
        const source = safeNodeId(body.source);
        const target = safeNodeId(body.target);
        if (!source || !target) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['source', 'target'] });
            return;
        }
        const event = {
            type: 'trace.rerouted',
            source,
            target,
            sourceHandle: safeOptionalNodeId(body.sourceHandle),
            targetHandle: safeOptionalNodeId(body.targetHandle),
            requestedAt: Date.now(),
        };
        context.broadcast(event);
        deps.writeJson(res, 200, event);
        return;
    }

    if (req.method !== 'GET') {
        deps.writeJson(res, 405, { error: 'method_not_allowed' });
        return;
    }

    const detailMatch = url.pathname.match(/^\/api\/v1\/traces\/([^/]+)\/?$/);
    if (detailMatch) {
        const cycleId = detailMatch[1];
        const trace = context.tracing?.ring?.get(cycleId);
        if (!trace) {
            deps.writeJson(res, 404, { error: 'trace_not_found', cycleId });
            return;
        }
        deps.writeJson(res, 200, trace);
        return;
    }

    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.min(1000, Number.parseInt(limitParam, 10) || 20)) : 20;
    const items = (context.tracing?.ring?.list(limit) ?? []).map((t) => ({
        cycleId: t.cycleId,
        traceId: t.traceId,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        durationMs: t.endedAt - t.startedAt,
        spanCount: t.spans.length,
    }));
    deps.writeJson(res, 200, { items, stats: context.tracing?.ring?.stats() ?? null });
}
```

Append the two safe node-id helpers under the wrapper.

- [ ] **Step 2: Wire `HttpApiRouter`**

Import:

```typescript
import { handleTracesRequest } from './http/TraceRoutes.js';
```

Replace:

```typescript
this.handleTracesRequest(req, res);
```

with:

```typescript
handleTracesRequest(this.context, req, res, { readJsonBody, writeJson });
```

Delete the private `handleTracesRequest()` and trace helper functions from `HttpApiRouter.ts`.

- [ ] **Step 3: Run focused tests**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/Tracing.test.ts src/__tests__/HttpApiRouteContracts.test.ts src/__tests__/Orchestrator.test.ts
```

Expected: TypeScript passes and all selected tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/http/TraceRoutes.ts src/services/HttpApiRouter.ts
git commit -m "refactor: extract HTTP trace routes"
```

---

### Task 6: Extract Chair Routes

**Files:**
- Create: `src/services/http/ChairRoutes.ts`
- Modify: `src/services/HttpApiRouter.ts`
- Test: `src/__tests__/ChairRegistry.test.ts`, `src/__tests__/HttpApiRouteContracts.test.ts`, `src/__tests__/Orchestrator.test.ts`

- [ ] **Step 1: Create `ChairRoutes.ts`**

Create `src/services/http/ChairRoutes.ts` by moving the current `handleChairRequest()` logic out of `HttpApiRouter.ts`.

Use this wrapper signature:

```typescript
import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';
import { ChairBridgeProvider } from '../ModelProvider.js';
import type { RouteDeps } from './HttpApiSupport.js';
import { createRequestUrl } from './HttpApiSupport.js';

export async function handleChairRequest(
    context: OrchestratorContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: RouteDeps,
): Promise<void> {
    const url = createRequestUrl(req);
    const action = url.pathname.replace(/^\/api\/v1\/chairs\/?/, '') || '';

    if (req.method === 'GET' && (action === '' || action === 'snapshot')) {
        deps.writeJson(res, 200, { chairs: context.chairs.snapshot(), stats: context.chairs.stats() });
        return;
    }

    if (req.method !== 'POST') {
        deps.writeJson(res, 405, { error: 'method_not_allowed' });
        return;
    }

    const body = await deps.readJsonBody(req, res);
    if (body === null) return;

    if (action === 'claim') {
        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
        if (!agentId || !provider) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['agentId', 'provider'] });
            return;
        }
        const claim = context.chairs.claim({
            agentId,
            provider,
            capabilities: Array.isArray(body.capabilities)
                ? body.capabilities.filter((c: unknown) => typeof c === 'string').slice(0, 32) as string[]
                : [],
            trustTier: typeof body.trustTier === 'number' ? body.trustTier : undefined,
            host: typeof body.host === 'string' ? body.host : undefined,
            note: typeof body.note === 'string' ? body.note.slice(0, 200) : undefined,
            inboxUrl: typeof body.inboxUrl === 'string' ? body.inboxUrl.trim() : undefined,
        });
        deps.writeJson(res, 200, {
            agentId: claim.agentId,
            sessionId: claim.sessionId,
            ttlMs: context.chairs.config().offlineMs,
            heartbeatIntervalMs: Math.floor(context.chairs.config().healthyMs / 2),
        });
        return;
    }

    if (action === 'heartbeat') {
        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!agentId || !sessionId) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['agentId', 'sessionId'] });
            return;
        }
        const claim = context.chairs.heartbeat(
            agentId,
            sessionId,
            typeof body.note === 'string' ? body.note.slice(0, 200) : undefined,
        );
        if (!claim) {
            deps.writeJson(res, 409, { error: 'unknown_or_superseded_session' });
            return;
        }
        deps.writeJson(res, 200, { status: claim.status, lastBeaconAt: claim.lastBeaconAt });
        return;
    }

    if (action === 'release') {
        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!agentId || !sessionId) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['agentId', 'sessionId'] });
            return;
        }
        const ok = context.chairs.release(agentId, sessionId, 'client_release');
        deps.writeJson(res, 200, { released: ok });
        return;
    }

    if (action === 'reply') {
        const topicId = typeof body.topicId === 'string' ? body.topicId.trim() : '';
        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const content = typeof body.content === 'string' ? body.content : '';
        if (!topicId || !agentId) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['topicId', 'agentId'] });
            return;
        }
        const success = ChairBridgeProvider.submitReply(topicId, agentId, content);
        deps.writeJson(res, 200, { success });
        return;
    }

    deps.writeJson(res, 404, { error: 'unknown_chair_action', action });
}
```

- [ ] **Step 2: Wire `HttpApiRouter`**

Import:

```typescript
import { handleChairRequest } from './http/ChairRoutes.js';
```

Replace:

```typescript
this.handleChairRequest(req, res);
```

with:

```typescript
handleChairRequest(this.context, req, res, { readJsonBody, writeJson });
```

Delete the private `handleChairRequest()` method from `HttpApiRouter.ts`.

- [ ] **Step 3: Run focused tests**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/ChairRegistry.test.ts src/__tests__/HttpApiRouteContracts.test.ts src/__tests__/Orchestrator.test.ts
```

Expected: TypeScript passes and all selected tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/http/ChairRoutes.ts src/services/HttpApiRouter.ts
git commit -m "refactor: extract HTTP chair routes"
```

---

### Task 7: Extract Conversation Routes

**Files:**
- Create: `src/services/http/ConversationRoutes.ts`
- Modify: `src/services/HttpApiRouter.ts`
- Test: `src/__tests__/ConversationBus.test.ts`, `src/__tests__/HttpApiRouteContracts.test.ts`, `src/__tests__/Orchestrator.test.ts`, `src/__tests__/integration.e2e.test.ts`

- [ ] **Step 1: Create `ConversationRoutes.ts`**

Create `src/services/http/ConversationRoutes.ts` by moving the current `handleConversationRequest()` and `safeConsensusThreshold()` logic out of `HttpApiRouter.ts`.

Use this wrapper signature:

```typescript
import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';
import { sanitizeTraceparent, sanitizeTracestate } from '../ConsensusEngine.js';
import type { RouteDeps } from './HttpApiSupport.js';
import { createRequestUrl } from './HttpApiSupport.js';

export async function handleConversationRequest(
    context: OrchestratorContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: RouteDeps,
): Promise<void> {
    const url = createRequestUrl(req);
    const pathname = url.pathname;

    const topicMatch = pathname.match(/^\/api\/v1\/conversations\/?$/);
    const messageMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/message\/?$/);
    const committeeMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/committee\/?$/);
    const closeMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/close\/?$/);
    const historyMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/history\/?$/);

    if (req.method === 'GET' && historyMatch) {
        const topicId = historyMatch[1];
        try {
            const history = context.conversationBus.getHistory(topicId);
            deps.writeJson(res, 200, history);
        } catch (err) {
            deps.writeJson(res, 500, { error: 'failed_to_get_history', message: err instanceof Error ? err.message : String(err) });
        }
        return;
    }

    if (req.method !== 'POST') {
        deps.writeJson(res, 405, { error: 'method_not_allowed' });
        return;
    }

    const body = await deps.readJsonBody(req, res);
    if (body === null) return;

    if (topicMatch) {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const participants = Array.isArray(body.participants) ? body.participants : [];
        if (!title || participants.length === 0) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['title', 'participants'] });
            return;
        }
        try {
            const topic = context.conversationBus.createTopic(title, participants as string[]);
            deps.writeJson(res, 200, topic);
        } catch (err) {
            deps.writeJson(res, 500, { error: 'failed_to_create_topic', message: err instanceof Error ? err.message : String(err) });
        }
        return;
    }

    if (messageMatch) {
        const topicId = messageMatch[1];
        const senderId = typeof body.senderId === 'string' ? body.senderId.trim() : '';
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!senderId || !content) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['senderId', 'content'] });
            return;
        }
        try {
            const msg = context.conversationBus.postMessage(topicId, senderId, 'user', content);
            context.conversationBus.convene(topicId, content).catch((err) => {
                context.log.error('convene_loop_failed', { topicId, error: err.message });
            });
            deps.writeJson(res, 200, msg);
        } catch (err) {
            deps.writeJson(res, 500, { error: 'failed_to_post_message', message: err instanceof Error ? err.message : String(err) });
        }
        return;
    }

    if (committeeMatch) {
        const topicId = committeeMatch[1];
        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
        if (!goal) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['goal'] });
            return;
        }
        try {
            const quorumThreshold = safeConsensusThreshold(body.quorumThreshold, 0.85, 0.6, 1);
            const failureThreshold = safeConsensusThreshold(body.failureThreshold, 0.5, 0.5, quorumThreshold);
            const verdict = context.conversationBus.conveneCommittee(topicId, goal, {
                quorumThreshold,
                failureThreshold,
                traceparent: sanitizeTraceparent(typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined),
                tracestate: sanitizeTracestate(typeof req.headers.tracestate === 'string' ? req.headers.tracestate : undefined),
            });
            deps.writeJson(res, 200, verdict);
        } catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err && err.code === 'committee_topic_not_active' ? 404 : 500;
            deps.writeJson(res, code, {
                error: code === 404 ? 'committee_topic_not_active' : 'failed_to_convene_committee',
            });
        }
        return;
    }

    if (closeMatch) {
        const topicId = closeMatch[1];
        try {
            context.conversationBus.closeTopic(topicId);
            deps.writeJson(res, 200, { success: true });
        } catch (err) {
            deps.writeJson(res, 500, { error: 'failed_to_close_topic', message: err instanceof Error ? err.message : String(err) });
        }
        return;
    }

    deps.writeJson(res, 404, { error: 'unknown_conversation_action' });
}

function safeConsensusThreshold(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}
```

- [ ] **Step 2: Wire `HttpApiRouter`**

Import:

```typescript
import { handleConversationRequest } from './http/ConversationRoutes.js';
```

Replace:

```typescript
this.handleConversationRequest(req, res);
```

with:

```typescript
handleConversationRequest(this.context, req, res, { readJsonBody, writeJson });
```

Delete the private `handleConversationRequest()` and `safeConsensusThreshold()` from `HttpApiRouter.ts`.

- [ ] **Step 3: Run focused tests**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/ConversationBus.test.ts src/__tests__/HttpApiRouteContracts.test.ts src/__tests__/Orchestrator.test.ts src/__tests__/integration.e2e.test.ts
```

Expected: TypeScript passes and all selected tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/http/ConversationRoutes.ts src/services/HttpApiRouter.ts
git commit -m "refactor: extract HTTP conversation routes"
```

---

### Task 8: Simplify Dispatcher And Remove Dead Imports

**Files:**
- Modify: `src/services/HttpApiRouter.ts`
- Test: `src/__tests__/HttpApiRouter.test.ts`, `src/__tests__/HttpApiRouteContracts.test.ts`

- [ ] **Step 1: Verify `HttpApiRouter.ts` imports are now minimal**

`HttpApiRouter.ts` should no longer import:

```typescript
import crypto from 'node:crypto';
import { ChairBridgeProvider } from './ModelProvider.js';
import type { ComfyAspectRatio, LoraMixerUpdate } from './ComfyUiBridge.js';
import { sanitizeTraceparent, sanitizeTracestate } from './ConsensusEngine.js';
```

Remove any of those imports if they remain unused.

- [ ] **Step 2: Keep dispatcher logic readable**

The central API route block should read like this:

```typescript
if (url.startsWith('/api/v1/state')) {
    handleStateSnapshot(this.context, req, res);
    return;
}
if (url.startsWith('/api/v1/chairs')) {
    handleChairRequest(this.context, req, res, { readJsonBody, writeJson });
    return;
}
if (url.startsWith('/api/v1/conversations')) {
    handleConversationRequest(this.context, req, res, { readJsonBody, writeJson });
    return;
}
if (url.startsWith('/api/v1/traces')) {
    handleTracesRequest(this.context, req, res, { readJsonBody, writeJson });
    return;
}
if (url.startsWith('/api/v1/comfy')) {
    handleComfyRequest(this.context, req, res, { readJsonBody, writeJson });
    return;
}
```

Do not introduce a generic route registry in this PR. A registry would add abstraction without reducing the current risk more than the direct dispatch does.

- [ ] **Step 3: Run router-focused tests**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/HttpApiRouter.test.ts src/__tests__/HttpApiRouteContracts.test.ts
```

Expected: TypeScript passes and both route test files pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/HttpApiRouter.ts
git commit -m "refactor: simplify HTTP API dispatcher"
```

---

### Task 9: Run Full Verification And Graphify

**Files:**
- Modify after graph output: `docs/architecture/mesh-orchestrator-graph-map.md`
- Modify after graph output: `docs/architecture/feature-gap-analysis-2026-05-23.md`

- [ ] **Step 1: Run full validation**

```bash
npx tsc --noEmit
npx vitest run
node scripts/validate-pr.mjs
```

Expected:

```text
TypeScript exits 0
Vitest reports all test files passing with existing skipped tests unchanged
[validate-pr] all checks passed
```

- [ ] **Step 2: Regenerate the graph**

Use the graph command that worked during the 2026-05-24 audit:

```bash
npx -y @nodesify/graphify run .
```

Expected:

```text
Graphify completes and writes .graphify/graph.json and .graphify/graph_report.md
```

Keep `.graphify/` untracked. It is intentionally ignored.

- [ ] **Step 3: Summarize graph hotspots**

Run this Node one-liner from the repo root:

```bash
node -e "const g=require('./.graphify/graph.json'); const nodes=Array.isArray(g.nodes)?g.nodes:[]; const edges=Array.isArray(g.edges)?g.edges:[]; console.log(JSON.stringify({nodes:nodes.length,edges:edges.length},null,2));"
```

If the Graphify JSON shape differs, inspect `.graphify/graph_report.md` and record the reported node/edge/community counts instead.

- [ ] **Step 4: Update architecture docs**

Update `docs/architecture/mesh-orchestrator-graph-map.md` with:

- The new graph date.
- The new node, edge, and community counts.
- The new source-file hub ranking.
- A note that `HttpApiRouter.ts` is now a dispatcher and route-family behavior lives under `src/services/http/`.

Update `docs/architecture/feature-gap-analysis-2026-05-23.md` if:

- `HttpApiRouter.ts` is no longer the top source-file hub.
- A different file becomes the next recommended decomposition target.
- The recommended next slice changes.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/mesh-orchestrator-graph-map.md docs/architecture/feature-gap-analysis-2026-05-23.md
git commit -m "docs: refresh graph after HTTP router split"
```

---

### Task 10: Final Hygiene Pass

**Files:**
- Inspect: all changed files

- [ ] **Step 1: Confirm no new forbidden patterns**

```bash
rg -n "as any|console\\." src packages --glob "*.ts" --glob "*.tsx"
```

Expected:

- No new `as any` outside already documented OTel SDK seams.
- No new `console.*` in production code.

- [ ] **Step 2: Confirm route module size and boundaries**

```bash
Get-ChildItem src/services/http -Filter *.ts | ForEach-Object { "$($_.Name) $((Get-Content $_.FullName).Count)" }
```

Expected:

- `HttpApiSupport.ts` remains focused on shared HTTP mechanics.
- `StateRoutes.ts` owns only state snapshot behavior.
- `ChairRoutes.ts` owns only chair HTTP behavior.
- `ConversationRoutes.ts` owns only conversation HTTP behavior.
- `TraceRoutes.ts` owns only trace HTTP behavior.
- `ComfyRoutes.ts` owns only Comfy HTTP behavior and Comfy sanitizers.

- [ ] **Step 3: Confirm final repository status**

```bash
git status --short --branch
```

Expected:

```text
## <branch>...<remote>/<branch> [ahead <n>]
```

with no modified or untracked tracked-path changes. `.graphify/` may exist locally but must remain ignored.

- [ ] **Step 4: Final validation**

```bash
node scripts/validate-pr.mjs
```

Expected:

```text
[validate-pr] all checks passed
```

---

## Review Checklist

Before opening or merging the PR:

- [ ] `HttpApiRouter.ts` still exports `HttpTimeouts` and `DEFAULT_HTTP_TIMEOUTS`.
- [ ] `MeshOrchestrator.ts` still constructs `new HttpApiRouter(this, timeouts)` without signature changes.
- [ ] CORS preflight still runs before auth and rate limiting.
- [ ] `/livez` and `/readyz` remain ungated.
- [ ] `/metrics` remains gated when `KOVAEL_API_TOKEN` is set.
- [ ] `/api/v1/*` rate limiting still runs before bearer auth.
- [ ] `readJsonBody()` still enforces 16 KiB default limit, 15-second timeout, oversize `req.destroy(new Error(...))`, and empty-body `{}` behavior.
- [ ] The route modules do not import `MeshOrchestrator`.
- [ ] The route modules depend only on `OrchestratorContext`, support helpers, and their domain services.
- [ ] All new imports use `.js` suffixes.
- [ ] No new runtime dependency is added.
- [ ] `node scripts/validate-pr.mjs` passes.

## Expected Result

After this plan is complete, `HttpApiRouter.ts` should be a thin boundary file instead of a mixed route implementation hub. The next graph pass should show lower file-edge concentration in `HttpApiRouter.ts`, and future HTTP changes can be reviewed in focused route modules with contract tests already in place.

Plan complete and saved to `docs/superpowers/plans/2026-05-24-http-api-router-decomposition.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fastest for independent extraction work.
2. **Inline Execution** - execute tasks in this session with checkpoint commits after each task.
