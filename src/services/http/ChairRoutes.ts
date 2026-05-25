import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';
import { ChairDispatchSecurityError, openChairDispatchBody } from '../ChairDispatchSecurity.js';
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

    let body = await deps.readJsonBody(req, res, action === 'reply' ? 256 * 1024 : undefined);
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
            capabilities: stringItems(body.capabilities, 32),
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
        try {
            body = openChairDispatchBody(body);
        } catch (err) {
            if (err instanceof ChairDispatchSecurityError) {
                deps.writeJson(res, err.status, { error: err.code });
                return;
            }
            deps.writeJson(res, 401, { error: 'invalid_chair_dispatch_security' });
            return;
        }
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

function stringItems(value: unknown, maxItems: number): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string').slice(0, maxItems);
}
