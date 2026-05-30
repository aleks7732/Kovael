import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';
import { sanitizeTraceparent, sanitizeTracestate } from '../ConsensusEngine.js';
import { readJsonBody, writeJson } from './HttpApiSupport.js';
import { createRequestUrl } from './HttpApiSupport.js';

export async function handleConversationRequest(
    context: OrchestratorContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
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
            writeJson(res, 200, history);
        } catch (err) {
            writeJson(res, 500, { error: 'failed_to_get_history', message: errorMessage(err) });
        }
        return;
    }

    if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method_not_allowed' });
        return;
    }

    const body = await readJsonBody(req, res);
    if (body === null) return;

    if (topicMatch) {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const participants = sanitizeParticipants(body.participants);
        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
        if (!title || participants.length === 0) {
            writeJson(res, 400, { error: 'missing_required_fields', need: ['title', 'participants'] });
            return;
        }
        try {
            const topic = context.conversationBus.createTopic(title, participants);
            if (goal) {
                context.conversationBus.convene(topic.id, goal).catch((err) => {
                    context.log.error('convene_loop_failed', { topicId: topic.id, error: errorMessage(err) });
                });
            }
            writeJson(res, 200, topic);
        } catch (err) {
            writeJson(res, 500, { error: 'failed_to_create_topic', message: errorMessage(err) });
        }
        return;
    }

    if (messageMatch) {
        const topicId = messageMatch[1];
        const senderId = typeof body.senderId === 'string' ? body.senderId.trim() : '';
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!senderId || !content) {
            writeJson(res, 400, { error: 'missing_required_fields', need: ['senderId', 'content'] });
            return;
        }
        try {
            const msg = context.conversationBus.postMessage(topicId, senderId, 'user', content);

            context.conversationBus.convene(topicId, content).catch((err) => {
                context.log.error('convene_loop_failed', { topicId, error: errorMessage(err) });
            });

            writeJson(res, 200, msg);
        } catch (err) {
            writeJson(res, 500, { error: 'failed_to_post_message', message: errorMessage(err) });
        }
        return;
    }

    if (committeeMatch) {
        const topicId = committeeMatch[1];
        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
        if (!goal) {
            writeJson(res, 400, { error: 'missing_required_fields', need: ['goal'] });
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
            writeJson(res, 200, verdict);
        } catch (err) {
            const code = errorCode(err) === 'committee_topic_not_active' ? 404 : 500;
            writeJson(res, code, {
                error: code === 404 ? 'committee_topic_not_active' : 'failed_to_convene_committee',
            });
        }
        return;
    }

    if (closeMatch) {
        const topicId = closeMatch[1];
        try {
            context.conversationBus.closeTopic(topicId);
            writeJson(res, 200, { success: true });
        } catch (err) {
            writeJson(res, 500, { error: 'failed_to_close_topic', message: errorMessage(err) });
        }
        return;
    }

    writeJson(res, 404, { error: 'unknown_conversation_action' });
}

function safeConsensusThreshold(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function sanitizeParticipants(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const participants = value
        .filter((participant): participant is string => typeof participant === 'string')
        .map((participant) => participant.trim())
        .filter((participant) => participant.length > 0);
    return Array.from(new Set(participants));
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const code = (err as Record<string, unknown>).code;
    return typeof code === 'string' ? code : undefined;
}
