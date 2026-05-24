import * as http from 'node:http';
import type { Socket } from 'node:net';
import type { OrchestratorContext } from './OrchestratorContext.js';
import { sanitizeTraceparent, sanitizeTracestate } from './ConsensusEngine.js';
import { readJsonBody, writeJson, writeNoContent } from './http/HttpApiSupport.js';
import { handleStateSnapshot } from './http/StateRoutes.js';
import { handleComfyRequest } from './http/ComfyRoutes.js';
import { handleTracesRequest } from './http/TraceRoutes.js';
import { handleChairRequest } from './http/ChairRoutes.js';

export interface HttpTimeouts {
    headersTimeout: number;
    requestTimeout: number;
    keepAliveTimeout: number;
}

export const DEFAULT_HTTP_TIMEOUTS: HttpTimeouts = {
    headersTimeout: 12_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 10_000,
};

export class HttpApiRouter {
    private readonly context: OrchestratorContext;
    private readonly timeouts: HttpTimeouts;
    private readonly headerDeadlineTimers = new Map<Socket, NodeJS.Timeout>();

    constructor(context: OrchestratorContext, timeouts: HttpTimeouts = DEFAULT_HTTP_TIMEOUTS) {
        this.context = context;
        this.timeouts = timeouts;
    }

    public createServer(): http.Server {
        const server = http.createServer((req, res) => {
            const socket = req.socket as Socket;
            this.disarmHeaderDeadline(socket);
            res.on('finish', () => {
                if (!socket.destroyed) this.armHeaderDeadline(socket, this.timeouts.headersTimeout);
            });

            const url = req.url ?? '';
            // CORS preflight (H2) must run before auth/rate-limit and route dispatch.
            if (req.method === 'OPTIONS') {
                writeNoContent(res);
                return;
            }

            // Probe endpoints are always ungated so kubelet can call them.
            if (url === '/livez') {
                this.context.health.livez(res);
                return;
            }
            if (url === '/readyz') {
                this.context.health.readyz(res);
                return;
            }
            if (url === '/metrics') {
                if (!this.context.apiGate.verify(req)) {
                    const reason = req.headers['authorization'] ? 'invalid' : 'missing';
                    this.context.apiGate.respond401(res, reason);
                    return;
                }
                this.context.health.metrics(res);
                return;
            }

            if (url.startsWith('/api/v1/')) {
                // Rate limit BEFORE auth so a flood of unauthenticated
                // requests cannot burn the bearer-token comparison loop.
                const key = this.context.rateLimiter.clientKey(req);
                const decision = this.context.rateLimiter.consume(key);
                if (!decision.allowed) {
                    writeJson(
                        res,
                        429,
                        { error: 'rate_limited', retry_after_s: decision.retryAfterS },
                        { 'Retry-After': String(decision.retryAfterS) },
                    );
                    return;
                }
                if (!this.context.apiGate.verify(req)) {
                    const reason = req.headers['authorization'] ? 'invalid' : 'missing';
                    this.context.apiGate.respond401(res, reason);
                    return;
                }
            }

            if (url.startsWith('/api/v1/state')) {
                handleStateSnapshot(this.context, req, res);
                return;
            }
            if (url.startsWith('/api/v1/chairs')) {
                handleChairRequest(this.context, req, res, { readJsonBody, writeJson });
                return;
            }
            if (url.startsWith('/api/v1/conversations')) {
                this.handleConversationRequest(req, res);
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

            this.context.handshake.handleRequest(req, res);
        });

        if (this.timeouts.requestTimeout !== 0 && this.timeouts.requestTimeout <= this.timeouts.headersTimeout) {
            throw new Error(
                `HttpTimeouts.requestTimeout (${this.timeouts.requestTimeout}) ` +
                    `must be 0 or greater than headersTimeout (${this.timeouts.headersTimeout}). ` +
                    `Node will otherwise silently clamp requestTimeout to headersTimeout + 1ms.`,
            );
        }
        if (this.timeouts.keepAliveTimeout >= this.timeouts.headersTimeout) {
            throw new Error(
                `HttpTimeouts.keepAliveTimeout (${this.timeouts.keepAliveTimeout}) ` +
                    `must be less than headersTimeout (${this.timeouts.headersTimeout}).`,
            );
        }

        server.headersTimeout = this.timeouts.headersTimeout;
        server.requestTimeout = this.timeouts.requestTimeout;
        server.keepAliveTimeout = this.timeouts.keepAliveTimeout;

        server.on('connection', (socket) => {
            this.armHeaderDeadline(socket, this.timeouts.headersTimeout);
            socket.on('close', () => this.disarmHeaderDeadline(socket));
        });

        return server;
    }

    public close(): void {
        for (const timer of this.headerDeadlineTimers.values()) {
            clearTimeout(timer);
        }
        this.headerDeadlineTimers.clear();
    }

    private armHeaderDeadline(socket: Socket, timeoutMs: number): void {
        this.disarmHeaderDeadline(socket);
        const timer = setTimeout(() => {
            this.headerDeadlineTimers.delete(socket);
            if (!socket.destroyed) socket.destroy();
        }, timeoutMs);
        timer.unref();
        this.headerDeadlineTimers.set(socket, timer);
    }

    private disarmHeaderDeadline(socket: Socket): void {
        const timer = this.headerDeadlineTimers.get(socket);
        if (!timer) return;
        clearTimeout(timer);
        this.headerDeadlineTimers.delete(socket);
    }

    private async handleConversationRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Path regexes
        const topicMatch = pathname.match(/^\/api\/v1\/conversations\/?$/);
        const messageMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/message\/?$/);
        const committeeMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/committee\/?$/);
        const closeMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/close\/?$/);
        const historyMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/history\/?$/);

        if (req.method === 'GET' && historyMatch) {
            const topicId = historyMatch[1];
            try {
                const history = this.context.conversationBus.getHistory(topicId);
                writeJson(res, 200, history);
            } catch (err: any) {
                writeJson(res, 500, { error: 'failed_to_get_history', message: err.message });
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
            const title = typeof body.title === 'string' ? (body.title as string).trim() : '';
            const participants = Array.isArray(body.participants) ? body.participants : [];
            if (!title || participants.length === 0) {
                writeJson(res, 400, { error: 'missing_required_fields', need: ['title', 'participants'] });
                return;
            }
            try {
                const topic = this.context.conversationBus.createTopic(title, participants as string[]);
                writeJson(res, 200, topic);
            } catch (err: any) {
                writeJson(res, 500, { error: 'failed_to_create_topic', message: err.message });
            }
            return;
        }

        if (messageMatch) {
            const topicId = messageMatch[1];
            const senderId = typeof body.senderId === 'string' ? (body.senderId as string).trim() : '';
            const content = typeof body.content === 'string' ? (body.content as string).trim() : '';
            if (!senderId || !content) {
                writeJson(res, 400, { error: 'missing_required_fields', need: ['senderId', 'content'] });
                return;
            }
            try {
                const msg = this.context.conversationBus.postMessage(topicId, senderId, 'user', content);
                
                // Asynchronously trigger convene loop in background
                this.context.conversationBus.convene(topicId, content).catch((err) => {
                    this.context.log.error('convene_loop_failed', { topicId, error: err.message });
                });

                writeJson(res, 200, msg);
            } catch (err: any) {
                writeJson(res, 500, { error: 'failed_to_post_message', message: err.message });
            }
            return;
        }

        if (committeeMatch) {
            const topicId = committeeMatch[1];
            const goal = typeof body.goal === 'string' ? (body.goal as string).trim() : '';
            if (!goal) {
                writeJson(res, 400, { error: 'missing_required_fields', need: ['goal'] });
                return;
            }
            try {
                const quorumThreshold = safeConsensusThreshold(body.quorumThreshold, 0.85, 0.6, 1);
                const failureThreshold = safeConsensusThreshold(body.failureThreshold, 0.5, 0.5, quorumThreshold);
                const verdict = this.context.conversationBus.conveneCommittee(topicId, goal, {
                    quorumThreshold,
                    failureThreshold,
                    traceparent: sanitizeTraceparent(typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined),
                    tracestate: sanitizeTracestate(typeof req.headers.tracestate === 'string' ? req.headers.tracestate : undefined),
                });
                writeJson(res, 200, verdict);
            } catch (err: any) {
                const code = err?.code === 'committee_topic_not_active' ? 404 : 500;
                writeJson(res, code, {
                    error: code === 404 ? 'committee_topic_not_active' : 'failed_to_convene_committee',
                });
            }
            return;
        }

        if (closeMatch) {
            const topicId = closeMatch[1];
            try {
                this.context.conversationBus.closeTopic(topicId);
                writeJson(res, 200, { success: true });
            } catch (err: any) {
                writeJson(res, 500, { error: 'failed_to_close_topic', message: err.message });
            }
            return;
        }

        writeJson(res, 404, { error: 'unknown_conversation_action' });
    }

}

function safeConsensusThreshold(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}
