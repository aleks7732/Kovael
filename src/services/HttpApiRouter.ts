import * as http from 'node:http';
import type { Socket } from 'node:net';
import crypto from 'node:crypto';
import type { OrchestratorContext } from './OrchestratorContext.js';
import { ChairBridgeProvider } from './ModelProvider.js';
import type { ComfyAspectRatio, LoraMixerUpdate } from './ComfyUiBridge.js';
import { sanitizeTraceparent, sanitizeTracestate } from './ConsensusEngine.js';

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
                    res.writeHead(429, {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-store',
                        'Retry-After': String(decision.retryAfterS),
                    });
                    res.end(JSON.stringify({ error: 'rate_limited', retry_after_s: decision.retryAfterS }));
                    return;
                }
                if (!this.context.apiGate.verify(req)) {
                    const reason = req.headers['authorization'] ? 'invalid' : 'missing';
                    this.context.apiGate.respond401(res, reason);
                    return;
                }
            }

            if (url.startsWith('/api/v1/state')) {
                this.handleStateSnapshot(req, res);
                return;
            }
            if (url.startsWith('/api/v1/chairs')) {
                this.handleChairRequest(req, res);
                return;
            }
            if (url.startsWith('/api/v1/conversations')) {
                this.handleConversationRequest(req, res);
                return;
            }
            if (url.startsWith('/api/v1/traces')) {
                this.handleTracesRequest(req, res);
                return;
            }
            if (url.startsWith('/api/v1/comfy')) {
                this.handleComfyRequest(req, res);
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

    private handleStateSnapshot(_req: http.IncomingMessage, res: http.ServerResponse): void {
        const snapshot = {
            timestamp: Date.now(),
            agentCards: this.context.agentCards.length,
            connectedClients: (this.context as any).wss?.clients?.size ?? 0,
            nodes: this.context.nodeCache.size,
            tasksTotal: this.context.taskCache.length,
            receiptsIssued: this.context.receiptsIssued,
            activeCycles: Array.from(this.context.activeCycles.values()).slice(-20),
            hardware: this.context.hardwareCache,
            claims: {
                stats: this.context.claims.stats(),
                pending: this.context.claims.snapshot().slice(-20),
            },
            retryQueue: {
                pendingCount: (this.context as any).retryQueue?.pendingCount() ?? 0,
                pending: (this.context as any).retryQueue?.snapshot() ?? [],
            },
            reconciler: (this.context as any).reconciler?.stats() ?? null,
            workspaces: {
                root: (this.context as any).workspaces?.root() ?? '',
                active: (this.context as any).workspaces?.activeCount() ?? 0,
            },
            hooks: (this.context as any).hooks?.stats() ?? null,
            workflow: {
                loaded: !!(this.context as any).workflowLoader?.document(),
                lastError: (this.context as any).workflowLoader?.lastErrorMessage() ?? null,
                version: (this.context as any).workflowLoader?.document()?.frontMatter?.version ?? null,
                loadedAt: (this.context as any).workflowLoader?.document()?.loadedAt ?? null,
            },
            tokens: { ...this.context.tokenTotals },
            rateLimits: (this.context as any).rateLimits?.allSnapshots() ?? [],
            chairs: {
                stats: this.context.chairs.stats(),
                roster: this.context.chairs.snapshot(),
            },
            circuits: this.context.circuitBreaker.snapshot(),
            learningMatrix: this.context.learningMatrix.stats(),
        };
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(snapshot));
    }

    private handleChairRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const writeJson = (status: number, body: Record<string, unknown>): void => {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(body));
        };
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const action = url.pathname.replace(/^\/api\/v1\/chairs\/?/, '') || '';

        if (req.method === 'GET' && (action === '' || action === 'snapshot')) {
            writeJson(200, { chairs: this.context.chairs.snapshot(), stats: this.context.chairs.stats() });
            return;
        }

        if (req.method !== 'POST') {
            writeJson(405, { error: 'method_not_allowed' });
            return;
        }

        const MAX_BODY = 16 * 1024;
        let received = 0;
        const chunks: Buffer[] = [];
        let aborted = false;
        req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (received > MAX_BODY) {
                aborted = true;
                writeJson(413, { error: 'payload_too_large', max_bytes: MAX_BODY });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (aborted) return;
            let body: any = {};
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.length > 0) {
                try {
                    body = JSON.parse(raw);
                } catch {
                    writeJson(400, { error: 'invalid_json' });
                    return;
                }
            }

            if (action === 'claim') {
                const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
                const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
                if (!agentId || !provider) {
                    writeJson(400, { error: 'missing_required_fields', need: ['agentId', 'provider'] });
                    return;
                }
                const claim = this.context.chairs.claim({
                    agentId,
                    provider,
                    capabilities: Array.isArray(body.capabilities)
                        ? body.capabilities.filter((c: unknown) => typeof c === 'string').slice(0, 32)
                        : [],
                    trustTier: typeof body.trustTier === 'number' ? body.trustTier : undefined,
                    host: typeof body.host === 'string' ? body.host : undefined,
                    note: typeof body.note === 'string' ? body.note.slice(0, 200) : undefined,
                    inboxUrl: typeof body.inboxUrl === 'string' ? body.inboxUrl.trim() : undefined,
                });
                writeJson(200, {
                    agentId: claim.agentId,
                    sessionId: claim.sessionId,
                    ttlMs: this.context.chairs.config().offlineMs,
                    heartbeatIntervalMs: Math.floor(this.context.chairs.config().healthyMs / 2),
                });
                return;
            }

            if (action === 'heartbeat') {
                const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
                const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
                if (!agentId || !sessionId) {
                    writeJson(400, { error: 'missing_required_fields', need: ['agentId', 'sessionId'] });
                    return;
                }
                const claim = this.context.chairs.heartbeat(
                    agentId,
                    sessionId,
                    typeof body.note === 'string' ? body.note.slice(0, 200) : undefined,
                );
                if (!claim) {
                    writeJson(409, { error: 'unknown_or_superseded_session' });
                    return;
                }
                writeJson(200, { status: claim.status, lastBeaconAt: claim.lastBeaconAt });
                return;
            }

            if (action === 'release') {
                const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
                const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
                if (!agentId || !sessionId) {
                    writeJson(400, { error: 'missing_required_fields', need: ['agentId', 'sessionId'] });
                    return;
                }
                const ok = this.context.chairs.release(agentId, sessionId, 'client_release');
                writeJson(200, { released: ok });
                return;
            }

            if (action === 'reply') {
                const topicId = typeof body.topicId === 'string' ? body.topicId.trim() : '';
                const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
                const content = typeof body.content === 'string' ? body.content : '';
                if (!topicId || !agentId) {
                    writeJson(400, { error: 'missing_required_fields', need: ['topicId', 'agentId'] });
                    return;
                }
                const success = ChairBridgeProvider.submitReply(topicId, agentId, content);
                writeJson(200, { success });
                return;
            }

            writeJson(404, { error: 'unknown_chair_action', action });
        });
        req.on('error', () => {
            if (!aborted) writeJson(400, { error: 'request_stream_error' });
        });
    }

    private handleConversationRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const writeJson = (status: number, body: Record<string, unknown> | Array<unknown>): void => {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(body));
        };

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
                writeJson(200, history as any);
            } catch (err: any) {
                writeJson(500, { error: 'failed_to_get_history', message: err.message });
            }
            return;
        }

        if (req.method !== 'POST') {
            writeJson(405, { error: 'method_not_allowed' });
            return;
        }

        const MAX_BODY = 16 * 1024;
        let received = 0;
        const chunks: Buffer[] = [];
        let aborted = false;

        req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (received > MAX_BODY) {
                aborted = true;
                writeJson(413, { error: 'payload_too_large', max_bytes: MAX_BODY });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('error', () => {
            if (!aborted) writeJson(400, { error: 'request_stream_error' });
        });

        req.on('end', () => {
            if (aborted) return;
            let body: any = {};
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.length > 0) {
                try {
                    body = JSON.parse(raw);
                } catch {
                    writeJson(400, { error: 'invalid_json' });
                    return;
                }
            }

            if (topicMatch) {
                const title = typeof body.title === 'string' ? body.title.trim() : '';
                const participants = Array.isArray(body.participants) ? body.participants : [];
                if (!title || participants.length === 0) {
                    writeJson(400, { error: 'missing_required_fields', need: ['title', 'participants'] });
                    return;
                }
                try {
                    const topic = this.context.conversationBus.createTopic(title, participants);
                    writeJson(200, topic as any);
                } catch (err: any) {
                    writeJson(500, { error: 'failed_to_create_topic', message: err.message });
                }
                return;
            }

            if (messageMatch) {
                const topicId = messageMatch[1];
                const senderId = typeof body.senderId === 'string' ? body.senderId.trim() : '';
                const content = typeof body.content === 'string' ? body.content.trim() : '';
                if (!senderId || !content) {
                    writeJson(400, { error: 'missing_required_fields', need: ['senderId', 'content'] });
                    return;
                }
                try {
                    const msg = this.context.conversationBus.postMessage(topicId, senderId, 'user', content);
                    
                    // Asynchronously trigger convene loop in background
                    this.context.conversationBus.convene(topicId, content).catch((err) => {
                        this.context.log.error('convene_loop_failed', { topicId, error: err.message });
                    });

                    writeJson(200, msg as any);
                } catch (err: any) {
                    writeJson(500, { error: 'failed_to_post_message', message: err.message });
                }
                return;
            }

            if (committeeMatch) {
                const topicId = committeeMatch[1];
                const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
                if (!goal) {
                    writeJson(400, { error: 'missing_required_fields', need: ['goal'] });
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
                    writeJson(200, verdict as any);
                } catch (err: any) {
                    const code = err?.code === 'committee_topic_not_active' ? 404 : 500;
                    writeJson(code, {
                        error: code === 404 ? 'committee_topic_not_active' : 'failed_to_convene_committee',
                    });
                }
                return;
            }

            if (closeMatch) {
                const topicId = closeMatch[1];
                try {
                    this.context.conversationBus.closeTopic(topicId);
                    writeJson(200, { success: true });
                } catch (err: any) {
                    writeJson(500, { error: 'failed_to_close_topic', message: err.message });
                }
                return;
            }

            writeJson(404, { error: 'unknown_conversation_action' });
        });
    }

    private handleTracesRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const writeJson = (status: number, body: Record<string, unknown> | Array<unknown>): void => {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(body));
        };

        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        if (req.method === 'POST' && url.pathname === '/api/v1/traces/reroute') {
            const MAX_BODY = 8 * 1024;
            let received = 0;
            const chunks: Buffer[] = [];
            let aborted = false;

            req.on('data', (chunk: Buffer) => {
                if (aborted) return;
                received += chunk.length;
                if (received > MAX_BODY) {
                    aborted = true;
                    writeJson(413, { error: 'payload_too_large', max_bytes: MAX_BODY });
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });

            req.on('error', () => {
                if (!aborted) writeJson(400, { error: 'request_stream_error' });
            });

            req.on('end', () => {
                if (aborted) return;
                let body: Record<string, unknown> = {};
                const raw = Buffer.concat(chunks).toString('utf8');
                if (raw.length > 0) {
                    try {
                        body = JSON.parse(raw) as Record<string, unknown>;
                    } catch {
                        writeJson(400, { error: 'invalid_json' });
                        return;
                    }
                }
                const source = safeNodeId(body.source);
                const target = safeNodeId(body.target);
                if (!source || !target) {
                    writeJson(400, { error: 'missing_required_fields', need: ['source', 'target'] });
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
                this.context.broadcast(event);
                writeJson(200, event);
            });
            return;
        }

        if (req.method !== 'GET') {
            writeJson(405, { error: 'method_not_allowed' });
            return;
        }

        const detailMatch = url.pathname.match(/^\/api\/v1\/traces\/([^/]+)\/?$/);
        if (detailMatch) {
            const cycleId = detailMatch[1];
            const trace = (this.context as any).tracing?.ring?.get(cycleId);
            if (!trace) {
                writeJson(404, { error: 'trace_not_found', cycleId });
                return;
            }
            writeJson(200, trace as unknown as Record<string, unknown>);
            return;
        }

        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? Math.max(1, Math.min(1000, Number.parseInt(limitParam, 10) || 20)) : 20;
        const items = ((this.context as any).tracing?.ring?.list(limit) ?? []).map((t: any) => ({
            cycleId: t.cycleId,
            traceId: t.traceId,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            durationMs: t.endedAt - t.startedAt,
            spanCount: t.spans.length,
        }));
        writeJson(200, { items, stats: (this.context as any).tracing?.ring?.stats() ?? null });
    }

    private handleComfyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const writeJson = (status: number, body: Record<string, unknown>): void => {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(body));
        };

        if (req.method !== 'POST') {
            writeJson(405, { error: 'method_not_allowed' });
            return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const action = url.pathname.replace(/^\/api\/v1\/comfy\/?/, '') || '';
        const MAX_BODY = 16 * 1024;
        let received = 0;
        const chunks: Buffer[] = [];
        let aborted = false;

        req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (received > MAX_BODY) {
                aborted = true;
                writeJson(413, { error: 'payload_too_large', max_bytes: MAX_BODY });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('error', () => {
            if (!aborted) writeJson(400, { error: 'request_stream_error' });
        });
        req.on('end', async () => {
            if (aborted) return;
            let body: any = {};
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.length > 0) {
                try {
                    body = JSON.parse(raw);
                } catch {
                    writeJson(400, { error: 'invalid_json' });
                    return;
                }
            }

            if (action === 'render' || action === 'mix') {
                const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
                const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
                if (!agentId || !prompt) {
                    writeJson(400, { error: 'missing_required_fields', need: ['agentId', 'prompt'] });
                    return;
                }
                try {
                    const mixer = Array.isArray(body.mixer) ? sanitizeMixer(body.mixer) : [];
                    const result = mixer.length > 0
                        ? await this.context.comfyBridge.renderWithMixer({
                              agentId,
                              prompt,
                              aspectRatio: safeAspectRatio(body.aspectRatio),
                              traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
                              mixer,
                           })
                        : await this.context.comfyBridge.renderPortrait({
                              agentId,
                              prompt,
                              aspectRatio: safeAspectRatio(body.aspectRatio),
                              traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
                           });
                    const stream = result.promptId ? this.context.comfyBridge.streamDescriptor(result.promptId) : undefined;
                    writeJson(200, {
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
                    writeJson(500, { error: 'comfy_render_failed', message: err instanceof Error ? err.message : String(err) });
                }
                return;
            }

            if (action === 'stream-url') {
                const promptId = typeof body.promptId === 'string' ? body.promptId.trim() : '';
                if (!promptId) {
                    writeJson(400, { error: 'missing_required_fields', need: ['promptId'] });
                    return;
                }
                writeJson(200, this.context.comfyBridge.streamDescriptor(promptId, typeof body.clientId === 'string' ? body.clientId : undefined) as any);
                return;
            }

            writeJson(404, { error: 'unknown_comfy_action', action });
        });
    }
}

function safeAspectRatio(value: unknown): ComfyAspectRatio | undefined {
    const allowed = new Set<ComfyAspectRatio>(['1:1', '16:9', '9:16', '4:3', '3:4', 'portrait', 'landscape', 'theater-card', 'flowchart']);
    return typeof value === 'string' && allowed.has(value as ComfyAspectRatio) ? value as ComfyAspectRatio : undefined;
}

function safeConsensusThreshold(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
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

function sanitizeMixer(input: unknown[]): LoraMixerUpdate[] {
    const out: LoraMixerUpdate[] = [];
    for (const item of input) {
        const raw = item as Record<string, unknown>;
        const recipeId = typeof raw.recipeId === 'string' ? raw.recipeId.replace(/[\r\n\t]/g, ' ').trim() : '';
        if (!recipeId) continue;
        const update: LoraMixerUpdate = {
            recipeId: recipeId.slice(0, 80),
            strength: boundedNumber(raw.strength, 0, 2, 1),
            denoise: boundedNumber(raw.denoise, 0, 1, 0.55),
        };
        if (typeof raw.trigger === 'string') {
            update.trigger = raw.trigger.replace(/[\r\n\t]/g, ' ').trim().slice(0, 240);
        }
        out.push(update);
        if (out.length >= 16) break;
    }
    return out;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}
