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
    const items = (context.tracing?.ring?.list(limit) ?? []).map((trace) => ({
        cycleId: trace.cycleId,
        traceId: trace.traceId,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        durationMs: trace.endedAt - trace.startedAt,
        spanCount: trace.spans.length,
    }));
    deps.writeJson(res, 200, { items, stats: context.tracing?.ring?.stats() ?? null });
}

function safeNodeId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(trimmed)) return null;
    return trimmed;
}

function safeOptionalNodeId(value: unknown): string | undefined {
    return value === undefined ? undefined : safeNodeId(value) ?? undefined;
}
