import * as http from 'node:http';
import type { Socket } from 'node:net';
import type { OrchestratorContext } from './OrchestratorContext.js';
import { readJsonBody, writeJson, writeNoContent } from './http/HttpApiSupport.js';
import { handleStateSnapshot } from './http/StateRoutes.js';
import { handleComfyRequest } from './http/ComfyRoutes.js';
import { handleTracesRequest } from './http/TraceRoutes.js';
import { handleChairRequest } from './http/ChairRoutes.js';
import { handleConversationRequest } from './http/ConversationRoutes.js';

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

}
