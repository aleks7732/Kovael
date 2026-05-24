import { WebSocketServer, WebSocket } from 'ws';
import type * as http from 'node:http';
import type { Socket } from 'node:net';
import crypto from 'node:crypto';
import type { OrchestratorContext } from './OrchestratorContext.js';
import { enrichWithAgUi } from './AgUiEventStream.js';

/** Extended request carrying auth/rate-limit outcome through the WS upgrade pipeline. */
interface KovaelUpgradeRequest extends http.IncomingMessage {
    __kovaelGateRejected?: boolean;
    __kovaelRateLimitRejected?: boolean;
    __kovaelSelectedSubprotocol?: string;
}

export class WebSocketBus {
    public readonly wss: WebSocketServer;
    private readonly context: OrchestratorContext;

    constructor(context: OrchestratorContext, server: http.Server) {
        this.context = context;
        this.wss = new WebSocketServer({
            noServer: true,
            maxPayload: this.context.maxWsMessageBytes,
            handleProtocols: (offered: Set<string>, req: http.IncomingMessage) => {
                const kreq = req as KovaelUpgradeRequest;
                const picked = kreq.__kovaelSelectedSubprotocol;
                if (typeof picked === 'string') return picked;
                // Rejected-but-upgrading: echo any offered value so ws does not
                // abort the handshake before the client can receive our
                // application close frame. Returning the first offered value
                // is harmless — the socket closes immediately after.
                if (kreq.__kovaelGateRejected || kreq.__kovaelRateLimitRejected) {
                    const first = offered.values().next().value;
                    return typeof first === 'string' ? first : false;
                }
                return false;
            },
        });

        server.on('upgrade', (req, socket, head) => {
            const kreq = req as KovaelUpgradeRequest;
            const key = this.context.rateLimiter.clientKey(req);
            const decision = this.context.rateLimiter.consume(key);
            if (!decision.allowed) {
                kreq.__kovaelRateLimitRejected = true;
                this.wss.handleUpgrade(req, socket as Socket, head, (ws) => {
                    ws.close(4429, 'rate_limited');
                });
                return;
            }

            const outcome = this.context.apiGate.verifyWebSocketUpgrade(req);
            if (!outcome.allowed) {
                kreq.__kovaelGateRejected = true;
                this.wss.handleUpgrade(req, socket as Socket, head, (ws) => {
                    ws.close(4401, 'unauthorized');
                });
                return;
            }
            if (outcome.selectedSubprotocol) {
                kreq.__kovaelSelectedSubprotocol = outcome.selectedSubprotocol;
            }
            // Scrub the ?token= query param so the secret can't leak to
            // downstream handlers, access logs, or anything that reads req.url.
            if (req.url && req.url.includes('token=')) {
                const u = new URL(req.url, 'http://localhost');
                if (u.searchParams.has('token')) {
                    u.searchParams.delete('token');
                    req.url = u.pathname + (u.search ? u.search : '');
                }
            }
            this.wss.handleUpgrade(req, socket as Socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
        });

        this.initializeBus();
    }

    public broadcast(payload: any): void {
        // Cache management
        if (payload.type === 'telemetry') {
            this.context.nodeCache.set(payload.nodeId, payload);
        } else if (payload.type === 'new_task') {
            this.context.taskCache.push(payload);
            if (this.context.taskCache.length > 100) this.context.taskCache.shift();
        }

        const frame = JSON.stringify(payload);
        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(frame);
            }
        });
    }

    private initializeBus(): void {
        this.wss.on('connection', (ws: WebSocket, request) => {
            const nodeId = this.extractNodeId(request);
            ws.on('error', (err) => {
                this.context.log.warn('ws_client_error', {
                    node_id: nodeId,
                    error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
                });
            });

            // 1. Send AgentCards
            this.context.agentCards.forEach((card) => {
                ws.send(JSON.stringify({ type: 'agent_card', data: card }));
            });

            // 2. Send Cached Nodes (Heartbeats/Telemetry)
            this.context.nodeCache.forEach((nodeData) => {
                ws.send(JSON.stringify(nodeData));
            });

            // 3. Send Cached Tasks
            this.context.taskCache.forEach((taskData) => {
                ws.send(JSON.stringify(taskData));
            });

            // 4. Send last-known hardware snapshot
            if (this.context.hardwareCache) {
                ws.send(
                    JSON.stringify({
                        type: 'hardware_telemetry',
                        nodeId: 'hardware-monitor',
                        data: this.context.hardwareCache,
                    }),
                );
            }

            // 5. Send current Inter-Agent Chat Toggle State
            ws.send(
                JSON.stringify({
                    type: 'inter_agent_chat_state',
                    data: {
                        enabled: this.context.interAgentChatEnabled,
                        mode: this.context.interAgentChatMode,
                    },
                }),
            );

            // 6. Replay current chair roster
            const chairRoster = this.context.chairs.snapshot();
            if (chairRoster.length > 0) {
                ws.send(
                    JSON.stringify({
                        type: 'chair_roster_snapshot',
                        nodeId: 'chair-registry',
                        data: { chairs: chairRoster, stats: this.context.chairs.stats() },
                    }),
                );
            }

            ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[]) => {
                const messageBytes = wsMessageByteLength(data);
                if (messageBytes > this.context.maxWsMessageBytes) {
                    ws.close(1009, 'payload_too_large');
                    return;
                }
                let payload: any;
                try {
                    payload = JSON.parse(data.toString());
                } catch {
                    return;
                }

                if (payload && payload.type === 'mission_inject' && typeof payload.goal === 'string') {
                    const goal = payload.goal.trim();
                    if (!goal) return;
                    this.context.log.info('mission_inject', { source: nodeId, goal_preview: goal.slice(0, 80) });
                    this.context.injectTask(goal).catch((err) =>
                        this.context.log.error('injection_failure', { source: nodeId, error: (err as Error).message }),
                    );
                    return;
                }

                if (payload && payload.type === 'toggle_inter_agent_chat' && typeof payload.enabled === 'boolean') {
                    this.context.interAgentChatEnabled = payload.enabled;
                    if (this.context.interAgentChatEnabled) {
                        this.context.startInterAgentChatLoop();
                    } else {
                        this.context.stopInterAgentChatLoop();
                    }
                    this.broadcast({
                        type: 'inter_agent_chat_state',
                        data: {
                            enabled: this.context.interAgentChatEnabled,
                            mode: this.context.interAgentChatMode,
                        },
                    });
                    return;
                }

                if (
                    payload &&
                    payload.type === 'set_inter_agent_chat_mode' &&
                    (payload.mode === 'technical' || payload.mode === 'interests')
                ) {
                    this.context.interAgentChatMode = payload.mode;
                    this.broadcast({
                        type: 'inter_agent_chat_state',
                        data: {
                            enabled: this.context.interAgentChatEnabled,
                            mode: this.context.interAgentChatMode,
                        },
                    });
                    if (this.context.interAgentChatEnabled) {
                        this.context.triggerInterAgentChat();
                    }
                    return;
                }

                await this.handleTelemetry(nodeId, payload);
            });
        });
    }

    private extractNodeId(request: any): string {
        const url = new URL(request.url || '', `http://${request.headers.host}`);
        const raw = url.searchParams.get('nodeId') || 'unknown';
        // Validate: cap length, strip control chars to prevent log injection
        // and broadcast payload bloat (M3).
        return raw.replace(/[\x00-\x1f]/g, '').slice(0, 128);
    }

    private async handleTelemetry(nodeId: string, payload: any) {
        // Spread payload FIRST, then override with trusted values so a
        // malicious client cannot forge `type` or `nodeId` (H5 security fix).
        const fullPayload = { ...payload, nodeId, type: 'telemetry' };
        this.context.emit('telemetry', fullPayload);
        this.broadcast(fullPayload);
    }

    public close(): void {
        this.wss.close();
    }
}

function wsMessageByteLength(data: Buffer | ArrayBuffer | Buffer[]): number {
    if (Buffer.isBuffer(data)) return data.length;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.length, 0);
    return Buffer.byteLength(String(data));
}
