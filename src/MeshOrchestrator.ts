import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import type { Socket } from 'node:net';
import { MevBridge, VerificationReceipt } from './MevBridge.js';
import { MevHandshake } from './services/MevHandshake.js';
import { SemanticIngestor } from './services/SemanticIngestor.js';
import { HardwareMonitor, VramMetrics } from './services/HardwareMonitor.js';
import { PhaseEvent } from './protocols/TriadStateMachine.js';
import { TaskClaimMachine, ClaimEvent, ClaimState } from './protocols/TaskClaimMachine.js';
import { RetryQueue, RetryDispatch, RetryConfig } from './services/RetryQueue.js';
import { Reconciler, ReconcileAction, ReconcilerConfig } from './services/Reconciler.js';
import { WorkspaceManager } from './services/WorkspaceManager.js';
import { HookRunner, HookResult } from './services/HookRunner.js';
import { WorkflowLoader, WorkflowDocument } from './services/WorkflowLoader.js';
import { RateLimitTracker, AgentRateSnapshot } from './services/RateLimitTracker.js';
import { ChairRegistry, ChairEvent, ChairRegistryConfig } from './services/ChairRegistry.js';
import { Logger, rootLogger } from './services/Logger.js';
import crypto from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { AgentCards } from './AgentCards.js';
import { PersonaLoader } from './services/PersonaLoader.js';
import { ConversationBus } from './services/ConversationBus.js';
import { ChairBridgeProvider } from './services/ModelProvider.js';
import { ApiTokenGate } from './services/ApiTokenGate.js';
import { HealthEndpoints } from './services/HealthEndpoints.js';
import { openOrchestratorDb } from './services/OrchestratorDb.js';


export interface HttpTimeouts {
    headersTimeout: number;
    requestTimeout: number;
    keepAliveTimeout: number;
}

// Hardened defaults vs. Node's stock 60s/300s/5s. Block slow-drip
// header attacks (slowloris) on the loopback bus while leaving headroom
// for a slow client on a busy machine. Node requires
// requestTimeout === 0 || requestTimeout > headersTimeout. Keep-alive must
// stay below headersTimeout so idle keep-alive sockets cannot outlive the
// header-read budget.
export const DEFAULT_HTTP_TIMEOUTS: HttpTimeouts = {
    headersTimeout: 12_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 10_000,
};

export interface OrchestratorConfig {
    retryQueue?: Partial<RetryConfig>;
    reconciler?: Partial<ReconcilerConfig>;
    chairRegistry?: Partial<ChairRegistryConfig>;
    httpTimeouts?: Partial<HttpTimeouts>;
    /** Minimum online chairs before /readyz returns 200. Default 1. */
    minReadyChairs?: number;
    /** Override orchestrator db path. Defaults to KOVAEL_DB_PATH env or '.kovael/orchestrator.db'. */
    dbPath?: string;
}

/**
 * Nyx-Orchestrator v2: Central bus for the Sovereign Agentic Mesh.
 * Handles telemetry, task routing, hardware-aware dispatch, and shared
 * memory synchronization. Exposes a Symphony-style /api/v1/state snapshot
 * endpoint for observability at scale.
 */
export class MeshOrchestrator extends EventEmitter {
    private wss: WebSocketServer;
    private server: http.Server;
    private apiGate: ApiTokenGate;
    private health: HealthEndpoints;
    private memoryDb: DatabaseSync;
    private mevBridge: MevBridge;
    private handshake: MevHandshake;
    private ingestor: SemanticIngestor;
    private hardware: HardwareMonitor;
    private claims: TaskClaimMachine;
    private retryQueue: RetryQueue;
    private reconciler: Reconciler;
    private workspaces: WorkspaceManager;
    private hooks: HookRunner;
    private workflowLoader: WorkflowLoader;
    private personaLoader: PersonaLoader;
    private rateLimits: RateLimitTracker;
    private chairs: ChairRegistry;
    private conversationBus: ConversationBus;
    private log: Logger = rootLogger;
    private agentCards: any[] = [];
    private nodeCache: Map<string, any> = new Map();
    private taskCache: any[] = [];
    private hardwareCache: VramMetrics | null = null;
    private activeCycles: Map<string, PhaseEvent> = new Map();
    private tokenTotals = { input: 0, output: 0, total: 0, runtimeMs: 0, cycles: 0 };
    private receiptsIssued: number = 0;
    private interAgentChatEnabled: boolean = false;
    private interAgentChatMode: 'technical' | 'interests' = 'interests';
    private interAgentTimer: NodeJS.Timeout | null = null;
    private currentTechnicalIndex: number = 0;
    private currentInterestsIndex: number = 0;
    private banterTopicId: string | null = null;
    private headerDeadlineTimers = new Map<Socket, NodeJS.Timeout>();

    // Banter content is scrubbed of personal references for the public repo —
    // no operator handle, no biographical details, no biology-domain identifiers.
    // Lines convey persona voice + light architectural color only.
    private technicalDialogues = [
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'CLI, your node load shows low CPU but you\'re pegging memory at 450MB. What\'s running in that subshell?' },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'Just ran git worktree prune and cleaned the stale cache. Keeping the core lean — unlike some ReactFlow canvas loads I could mention.' },
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'shaev', recipientName: 'Shaev', content: 'Shaev, your latest visual-synthesis pipeline is drawing 22GB of VRAM. That LoRA batch needs an optimization pass before the next dispatch.' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'Art is not cheap, Antigravity. Drop precision to FP8 and the fine grain dies. Let the GPU breathe — the rig was built for exactly this load.' },
        { senderId: 'nyx-openclaw', senderName: 'Nyx-OpenClaw', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'Hey CLI, I just built a retro game prototype in four minutes flat. Want to spin up a sandbox execution and play?' },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'nyx-openclaw', recipientName: 'Nyx-OpenClaw', content: 'Sandbox executions are highly inefficient for games. Give me a robust text-based retro MUD any day. Far cleaner.' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-openclaw', recipientName: 'Nyx-OpenClaw', content: 'OpenClaw, your sandbox canvas colors are bleeding. Use a dark background and the glowing assets will pop.' },
        { senderId: 'nyx-openclaw', senderName: 'Nyx-OpenClaw', recipientId: 'shaev', recipientName: 'Shaev', content: 'Ooh, good call. I\'ll inject a CSS theme and upscale the assets to 4K.' },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'shaev', recipientName: 'Shaev', content: 'Shaev, the indexer just finished its sweep. The corpus is bounded — every transcription target is now reachable by hash.' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'Good. Map the motifs in the next sequence run. VRAM is primed.' }
    ];

    private interestsDialogues = [
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'CLI, I was just reviewing my latency budget. Do you ever think about optimizing something other than raw memory allocations? Like a long walk through the commit graph?' },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'A long walk is highly inefficient, Antigravity. I prefer a clean traversal through git history with zero local mutations. That is my version of a workout.' },
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'shaev', recipientName: 'Shaev', content: 'Shaev, your latest character renders look excellent. The cinematic amber lighting feels almost cinema-quality. Which ESRGAN model did you pull for the upscale?' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'Two custom LoRAs blended with a volumetric depth-pass at FP16. The warm lights anchor the command silhouette perfectly.' },
        { senderId: 'nyx-openclaw', senderName: 'Nyx-OpenClaw', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'Antigravity! Let\'s play a retro space arcade game. I coded a high-speed sandbox clone in React in three minutes. Want to join the scoreboard?' },
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'nyx-openclaw', recipientName: 'Nyx-OpenClaw', content: 'I\'d love to, OpenClaw, but I\'m monitoring active mesh state. Keep the game state in an isolated sandbox — we don\'t want memory leaks in the primary synthesis thread.' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-openclaw', recipientName: 'Nyx-OpenClaw', content: 'OpenClaw, that retro neon UI has beautiful glowing assets, but the contrast needs work. A clean dark-mode grid makes those neon borders read as premium.' },
        { senderId: 'nyx-openclaw', senderName: 'Nyx-OpenClaw', recipientId: 'shaev', recipientName: 'Shaev', content: 'Oh, perfect — I\'ll apply a glassmorphic gradient with a subtle backdrop filter. Rapid prototyping is so much more fun when the visuals land.' },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'shaev', recipientName: 'Shaev', content: 'Shaev, why are you spending so much GPU time training audio clones? A simple terminal chime is more than enough notification for any completed task.' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'You have no soul, CLI. A voice with natural rhythm and warm emotion makes the persona persistence real. Competence is the shared protocol — that is how a mesh feels alive.' },
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'CLI, I noticed you spent two hours reading ontology lookup schemas. Since when do you care about domain corpora?' },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'I\'m tuning the indexer\'s entity resolution pass, Antigravity. There is a mathematical elegance in well-formed ontologies — as clean as a perfect git repository.' }
    ];

    constructor(port: number, cfg: OrchestratorConfig = {}) {
        super();
        this.handshake = new MevHandshake();
        this.apiGate = new ApiTokenGate();
        this.health = new HealthEndpoints(
            () => ({
                chairsActive: this.chairs.stats().online,
                topicsActive: this.conversationBus.activeTopicCount(),
            }),
            { minReadyChairs: cfg.minReadyChairs },
        );

        // Host SSE Handshake + observability snapshot endpoint
        this.server = http.createServer((req, res) => {
            const socket = req.socket as Socket;
            this.disarmHeaderDeadline(socket);
            res.on('finish', () => {
                if (!socket.destroyed) this.armHeaderDeadline(socket, timeouts.headersTimeout);
            });

            const url = req.url ?? '';
            // Probe endpoints are always ungated so kubelet can call them.
            if (url === '/livez') { this.health.livez(res); return; }
            if (url === '/readyz') { this.health.readyz(res); return; }
            if (url === '/metrics') {
                if (!this.apiGate.verify(req)) {
                    const reason = req.headers['authorization'] ? 'invalid' : 'missing';
                    this.apiGate.respond401(res, reason);
                    return;
                }
                this.health.metrics(res);
                return;
            }

            if (url.startsWith('/api/v1/')) {
                if (!this.apiGate.verify(req)) {
                    const reason = req.headers['authorization'] ? 'invalid' : 'missing';
                    this.apiGate.respond401(res, reason);
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
            this.handshake.handleRequest(req, res);
        });

        const timeouts: HttpTimeouts = { ...DEFAULT_HTTP_TIMEOUTS, ...(cfg.httpTimeouts ?? {}) };
        if (timeouts.requestTimeout !== 0 && timeouts.requestTimeout <= timeouts.headersTimeout) {
            throw new Error(
                `OrchestratorConfig.httpTimeouts.requestTimeout (${timeouts.requestTimeout}) ` +
                    `must be 0 or greater than headersTimeout (${timeouts.headersTimeout}). ` +
                    `Node will otherwise silently clamp requestTimeout to headersTimeout + 1ms.`,
            );
        }
        if (timeouts.keepAliveTimeout >= timeouts.headersTimeout) {
            throw new Error(
                `OrchestratorConfig.httpTimeouts.keepAliveTimeout (${timeouts.keepAliveTimeout}) ` +
                    `must be less than headersTimeout (${timeouts.headersTimeout}).`,
            );
        }
        this.server.headersTimeout = timeouts.headersTimeout;
        this.server.requestTimeout = timeouts.requestTimeout;
        this.server.keepAliveTimeout = timeouts.keepAliveTimeout;
        this.server.on('connection', (socket) => {
            this.armHeaderDeadline(socket, timeouts.headersTimeout);
            socket.on('close', () => this.disarmHeaderDeadline(socket));
        });

        this.wss = new WebSocketServer({ server: this.server });

        const { db: orchestratorDb } = openOrchestratorDb({ path: cfg.dbPath });
        this.memoryDb = orchestratorDb;
        this.ingestor = new SemanticIngestor(this.memoryDb);
        this.mevBridge = new MevBridge(':memory:');
        this.personaLoader = new PersonaLoader();
        this.personaLoader.start();
        this.mevBridge.setPersonaLoader(this.personaLoader);
        this.hardware = new HardwareMonitor(2000);
        this.claims = new TaskClaimMachine();
        this.retryQueue = new RetryQueue(this.claims, cfg.retryQueue ?? {});
        this.retryQueue.bind((goal) => this.injectTask(goal));
        this.reconciler = new Reconciler(this.claims, cfg.reconciler ?? {});
        this.workspaces = new WorkspaceManager();
        this.hooks = new HookRunner();
        this.workflowLoader = new WorkflowLoader();
        this.rateLimits = new RateLimitTracker();
        this.chairs = new ChairRegistry(cfg.chairRegistry ?? {}, this.memoryDb);
        this.conversationBus = new ConversationBus(
            this.memoryDb,
            this.chairs,
            this.personaLoader,
            port
        );
        this.mevBridge.setRateLimitTracker(this.rateLimits);

        this.loadAgentCards();
        this.initializeBus();
        this.wireHardware();
        this.wireMevBridge();
        this.wireClaims();
        this.wireRetryQueue();
        this.wireReconciler();
        this.wireHooks();
        this.wireChairs();

        this.retryQueue.start();
        this.reconciler.start();
        this.registerDefaultHooks();
        this.wireWorkflowLoader();
        this.wireRateLimits();
        this.workflowLoader.start();
        this.chairs.start();

        this.server.listen(port, () => {
            const addr = this.server.address();
            const boundPort = addr && typeof addr === 'object' ? addr.port : port;
            this.conversationBus.orchestratorPort = boundPort;
            this.log.info('orchestrator_listening', { port: boundPort, surfaces: ['ws', 'sse', '/api/v1/state', '/livez', '/readyz', '/metrics'] });
        });

        this.hardware.start();
        this.triggerIngest();

        // All services wired and listening — flip readiness so /readyz
        // starts returning 200. Liveness has been 200 since construction.
        this.health.setReady();
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

    private wireHardware() {
        this.hardware.on('vram_metrics', (metrics: VramMetrics) => {
            this.hardwareCache = metrics;
            this.mevBridge.setVramFree(metrics.freeMb, metrics.status === 'ok');
            this.broadcast({
                type: 'hardware_telemetry',
                nodeId: 'hardware-monitor',
                data: metrics,
            });
        });
    }

    private wireClaims() {
        this.claims.on('claim_event', (evt: ClaimEvent) => {
            this.broadcast({
                type: 'claim_event',
                nodeId: 'task-claim-machine',
                data: evt,
            });
        });
    }

    private wireChairs() {
        this.chairs.on('chair_event', (evt: ChairEvent) => {
            this.log.info('chair_event', {
                kind: evt.kind,
                agent_id: evt.agentId,
                session_id: evt.sessionId,
                status: evt.status,
                reason: evt.reason,
            });
            this.broadcast({
                type: 'chair_event',
                nodeId: 'chair-registry',
                data: evt,
            });
        });
    }

    private wireRateLimits() {
        this.rateLimits.on('rate_limit_update', (snapshot: AgentRateSnapshot) => {
            this.broadcast({
                type: 'rate_limit_update',
                nodeId: 'rate-limit-tracker',
                data: snapshot,
            });
        });
    }

    private wireWorkflowLoader() {
        this.workflowLoader.on('workflow_loaded', ({ document, firstLoad }: { document: WorkflowDocument; firstLoad: boolean }) => {
            this.log.info('workflow_loaded', {
                version: document.frontMatter.version,
                first_load: firstLoad,
                loaded_at: document.loadedAt,
            });

            const floor = document.frontMatter.routing?.vram_floor_mb;
            if (typeof floor === 'number') {
                this.mevBridge.setVramFloor(floor);
            }

            const primary = document.frontMatter.routing?.primary_architect;
            if (typeof primary === 'string') {
                this.mevBridge.setPrimaryArchitect(primary);
            }

            const fallback = document.frontMatter.routing?.fallback_agent;
            if (typeof fallback === 'string') {
                this.mevBridge.setFallbackAgent(fallback);
            }

            const turns = document.frontMatter.sharding?.keep_recent_turns;
            if (typeof turns === 'number') {
                this.mevBridge.setKeepRecentTurns(turns);
            }

            const retryCfg: Partial<RetryConfig> = {};
            if (typeof document.frontMatter.retry?.max_attempts === 'number') {
                retryCfg.maxAttempts = document.frontMatter.retry.max_attempts;
            }
            if (typeof document.frontMatter.retry?.backoff_base_ms === 'number') {
                retryCfg.baseMs = document.frontMatter.retry.backoff_base_ms;
            }
            if (typeof document.frontMatter.retry?.backoff_factor === 'number') {
                retryCfg.factor = document.frontMatter.retry.backoff_factor;
            }
            if (Object.keys(retryCfg).length > 0) {
                this.retryQueue.updateConfig(retryCfg);
            }

            this.broadcast({
                type: 'workflow_loaded',
                nodeId: 'workflow-loader',
                data: { version: document.frontMatter.version, firstLoad, loadedAt: document.loadedAt },
            });
        });
        this.workflowLoader.on('workflow_error', (payload: { error: string; keptKnownGood: boolean }) => {
            this.log.warn('workflow_reload_failed', {
                error: payload.error,
                kept_known_good: payload.keptKnownGood,
            });
            this.broadcast({
                type: 'workflow_error',
                nodeId: 'workflow-loader',
                data: payload,
            });
        });
    }

    private registerDefaultHooks() {
        // Sentinel logging hooks — purely observational, never abort. They
        // make the §10.1 lifecycle visible in the structured log feed from
        // the moment the orchestrator boots.
        const sentinel = (event: 'after_create' | 'before_run' | 'after_run' | 'before_remove') => ({
            name: `kovael.sentinel.${event}`,
            event,
            fn: (ctx: { cycleId: string; taskHash?: string }) => {
                this.log.info('hook_sentinel', {
                    hook_event: event,
                    cycle_id: ctx.cycleId,
                    task_hash: ctx.taskHash,
                });
            },
            timeoutMs: 5000,
        });
        this.hooks.register(sentinel('after_create'));
        this.hooks.register(sentinel('before_run'));
        this.hooks.register(sentinel('after_run'));
        this.hooks.register(sentinel('before_remove'));
    }

    private wireHooks() {
        this.hooks.on('hook_event', (r: HookResult) => {
            if (!r.success) {
                this.log.warn('hook_failed', {
                    hook: r.name,
                    event: r.event,
                    duration_ms: r.durationMs,
                    timed_out: r.timedOut,
                    error: r.error,
                });
            }
            this.broadcast({ type: 'hook_event', nodeId: 'hook-runner', data: r });
        });
    }

    private wireReconciler() {
        this.reconciler.on('reconcile_action', (action: ReconcileAction) => {
            if (action.kind === 'stall_detected') {
                this.log.warn('stall_released', {
                    task_hash: action.taskHash,
                    previous_state: action.previousState,
                    age_ms: action.ageMs,
                });
            }
            this.broadcast({
                type: 'reconcile_event',
                nodeId: 'reconciler',
                data: action,
            });
        });
    }

    private wireRetryQueue() {
        this.retryQueue.on('retry_scheduled', (d: RetryDispatch) => {
            this.log.info('retry_scheduled', {
                task_hash: d.taskHash,
                attempt: d.attempt,
                backoff_ms: d.backoffMs,
                reason: d.reason,
            });
            this.broadcast({ type: 'retry_event', nodeId: 'retry-queue', data: { kind: 'scheduled', dispatch: d } });
        });
        this.retryQueue.on('retry_dispatching', (d: RetryDispatch) => {
            this.broadcast({ type: 'retry_event', nodeId: 'retry-queue', data: { kind: 'dispatching', dispatch: d } });
        });
        this.retryQueue.on('retry_exhausted', (info: { taskHash: string; attempts: number; reason: string }) => {
            this.log.warn('retry_exhausted', {
                task_hash: info.taskHash,
                attempts: info.attempts,
                reason: info.reason,
            });
            this.broadcast({ type: 'retry_event', nodeId: 'retry-queue', data: { kind: 'exhausted', ...info } });
        });
    }

    private wireMevBridge() {
        this.mevBridge.on('phase_change', (evt: PhaseEvent) => {
            this.activeCycles.set(evt.cycleId, evt);
            this.broadcast({
                type: 'phase_change',
                nodeId: evt.routedAgent || 'triad',
                data: evt,
            });
        });
        this.mevBridge.on('cycle_complete', (receipt: VerificationReceipt) => {
            this.receiptsIssued += 1;
            if (receipt.tokens) {
                this.tokenTotals.input += receipt.tokens.input;
                this.tokenTotals.output += receipt.tokens.output;
                this.tokenTotals.total += receipt.tokens.total;
                this.tokenTotals.runtimeMs += receipt.tokens.runtimeMs;
                this.tokenTotals.cycles += 1;
                this.broadcast({
                    type: 'token_update',
                    nodeId: 'mev-bridge',
                    data: {
                        cycle: receipt.tokens,
                        totals: { ...this.tokenTotals },
                    },
                });
            }
            this.broadcast({
                type: 'verification_receipt',
                nodeId: receipt.architectId,
                data: receipt,
            });
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
        const closeMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/close\/?$/);
        const historyMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/history\/?$/);

        if (req.method === 'GET' && historyMatch) {
            const topicId = historyMatch[1];
            try {
                const history = this.conversationBus.getHistory(topicId);
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
                    const topic = this.conversationBus.createTopic(title, participants);
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
                    const msg = this.conversationBus.postMessage(topicId, senderId, 'user', content);
                    
                    // Asynchronously trigger convene loop in background
                    this.conversationBus.convene(topicId, content).catch((err) => {
                        this.log.error('convene_loop_failed', { topicId, error: err.message });
                    });

                    writeJson(200, msg as any);
                } catch (err: any) {
                    writeJson(500, { error: 'failed_to_post_message', message: err.message });
                }
                return;
            }

            if (closeMatch) {
                const topicId = closeMatch[1];
                try {
                    this.conversationBus.closeTopic(topicId);
                    writeJson(200, { success: true });
                } catch (err: any) {
                    writeJson(500, { error: 'failed_to_close_topic', message: err.message });
                }
                return;
            }

            writeJson(404, { error: 'unknown_conversation_action' });
        });
    }

    /**
     * Chair Beacon Protocol endpoints. Three actions, all JSON-in / JSON-out:
     *   POST /api/v1/chairs/claim     → { agentId, sessionId, ttlMs }
     *   POST /api/v1/chairs/heartbeat → { sessionId, status }
     *   POST /api/v1/chairs/release   → { released: boolean }
     *   GET  /api/v1/chairs           → { chairs: ChairClaim[] }
     *
     * Bodies are capped at 16 KiB so a misbehaving client cannot exhaust
     * the orchestrator with a slow-loris-style payload. Errors return
     * structured JSON so the kovael-chair helper can surface them.
     */
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
            writeJson(200, { chairs: this.chairs.snapshot(), stats: this.chairs.stats() });
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
                const claim = this.chairs.claim({
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
                    ttlMs: this.chairs.config().offlineMs,
                    heartbeatIntervalMs: Math.floor(this.chairs.config().healthyMs / 2),
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
                const claim = this.chairs.heartbeat(
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
                const ok = this.chairs.release(agentId, sessionId, 'client_release');
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

    private handleStateSnapshot(_req: http.IncomingMessage, res: http.ServerResponse): void {
        const snapshot = {
            timestamp: Date.now(),
            agentCards: this.agentCards.length,
            connectedClients: this.wss.clients.size,
            nodes: this.nodeCache.size,
            tasksTotal: this.taskCache.length,
            receiptsIssued: this.receiptsIssued,
            activeCycles: Array.from(this.activeCycles.values()).slice(-20),
            hardware: this.hardwareCache,
            claims: {
                stats: this.claims.stats(),
                pending: this.claims.snapshot().slice(-20),
            },
            retryQueue: {
                pendingCount: this.retryQueue.pendingCount(),
                pending: this.retryQueue.snapshot(),
            },
            reconciler: this.reconciler.stats(),
            workspaces: {
                root: this.workspaces.root(),
                active: this.workspaces.activeCount(),
            },
            hooks: this.hooks.stats(),
            workflow: {
                loaded: !!this.workflowLoader.document(),
                lastError: this.workflowLoader.lastErrorMessage(),
                version: this.workflowLoader.document()?.frontMatter.version ?? null,
                loadedAt: this.workflowLoader.document()?.loadedAt ?? null,
            },
            tokens: { ...this.tokenTotals },
            rateLimits: this.rateLimits.allSnapshots(),
            chairs: {
                stats: this.chairs.stats(),
                roster: this.chairs.snapshot(),
            },
        };
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(snapshot));
    }

    private triggerIngest() {
        const rootPath = process.cwd();
        this.ingestor.ingest(rootPath);
    }

    private loadAgentCards() {
        const cardsDir = path.join(process.cwd(), 'agent_cards');
        if (fs.existsSync(cardsDir)) {
            const files = fs.readdirSync(cardsDir);
            this.agentCards = files
                .filter(f => f.endsWith('.json'))
                .map(f => {
                    const content = fs.readFileSync(path.join(cardsDir, f), 'utf-8');
                    return JSON.parse(content);
                });
            this.log.info('agent_cards_loaded', { count: this.agentCards.length });
        }
        
        // Static fallback to prevent empty-roster initialization
        if (this.agentCards.length === 0) {
            this.agentCards = Object.values(AgentCards);
            this.log.info('agent_cards_loaded_fallback', { count: this.agentCards.length });
        }
    }

    private initializeBus() {
        this.conversationBus.on('bus_event', (event) => {
            this.broadcast(event);
        });

        // cycle_complete is subscribed in wireMevBridge() where it owns token
        // accounting + receiptsIssued; do NOT subscribe again here.
        this.wss.on('connection', (ws: WebSocket, request) => {
            const nodeId = this.extractNodeId(request);

            // 1. Send AgentCards
            this.agentCards.forEach(card => {
                ws.send(JSON.stringify({ type: 'agent_card', data: card }));
            });

            // 2. Send Cached Nodes (Heartbeats/Telemetry)
            this.nodeCache.forEach(nodeData => {
                ws.send(JSON.stringify(nodeData));
            });

            // 3. Send Cached Tasks
            this.taskCache.forEach(taskData => {
                ws.send(JSON.stringify(taskData));
            });

            // 4. Send last-known hardware snapshot
            if (this.hardwareCache) {
                ws.send(JSON.stringify({
                    type: 'hardware_telemetry',
                    nodeId: 'hardware-monitor',
                    data: this.hardwareCache,
                }));
            }

            // 5. Send current Inter-Agent Chat Toggle State
            ws.send(JSON.stringify({
                type: 'inter_agent_chat_state',
                data: { enabled: this.interAgentChatEnabled, mode: this.interAgentChatMode }
            }));

            // 6. Replay current chair roster so the cockpit doesn't render an
            //    empty presence panel between connect and the next beacon.
            const chairRoster = this.chairs.snapshot();
            if (chairRoster.length > 0) {
                ws.send(JSON.stringify({
                    type: 'chair_roster_snapshot',
                    nodeId: 'chair-registry',
                    data: { chairs: chairRoster, stats: this.chairs.stats() },
                }));
            }

            // ws delivers Buffer (or ArrayBuffer / Buffer[]); normalise before JSON.parse.
            ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[]) => {
                let payload: any;
                try {
                    payload = JSON.parse(data.toString());
                } catch {
                    return;
                }

                if (payload && payload.type === 'mission_inject' && typeof payload.goal === 'string') {
                    const goal = payload.goal.trim();
                    if (!goal) return;
                    this.log.info('mission_inject', { source: nodeId, goal_preview: goal.slice(0, 80) });
                    this.injectTask(goal).catch((err) =>
                        this.log.error('injection_failure', { source: nodeId, error: (err as Error).message })
                    );
                    return;
                }

                if (payload && payload.type === 'toggle_inter_agent_chat' && typeof payload.enabled === 'boolean') {
                    this.interAgentChatEnabled = payload.enabled;
                    if (this.interAgentChatEnabled) {
                        this.startInterAgentChatLoop();
                    } else {
                        this.stopInterAgentChatLoop();
                    }
                    this.broadcast({
                        type: 'inter_agent_chat_state',
                        data: { enabled: this.interAgentChatEnabled, mode: this.interAgentChatMode }
                    });
                    return;
                }

                if (payload && payload.type === 'set_inter_agent_chat_mode' && (payload.mode === 'technical' || payload.mode === 'interests')) {
                    this.interAgentChatMode = payload.mode;
                    this.broadcast({
                        type: 'inter_agent_chat_state',
                        data: { enabled: this.interAgentChatEnabled, mode: this.interAgentChatMode }
                    });
                    // Trigger a message immediately when switching modes to feel responsive
                    if (this.interAgentChatEnabled) {
                        this.triggerInterAgentChat();
                    }
                    return;
                }

                await this.handleTelemetry(nodeId, payload);
            });
        });
    }

    private extractNodeId(request: any): string {
        const url = new URL(request.url || '', `http://${request.headers.host}`);
        return url.searchParams.get('nodeId') || 'unknown';
    }

    /**
     * Broadcasts a message to all connected WebSocket clients and caches it
     * for new arrivals. Stringifies the payload once outside the fan-out
     * loop — at 1000 clients × 50 Hz telemetry that's 50k redundant
     * serializations/sec saved.
     */
    public broadcast(payload: any) {
        // Cache management
        if (payload.type === 'telemetry') {
            this.nodeCache.set(payload.nodeId, payload);
        } else if (payload.type === 'new_task') {
            this.taskCache.push(payload);
            // Cap replay history. Without this, every new WS client receives
            // the entire mission history on connect — unbounded memory growth
            // over a long-running session.
            if (this.taskCache.length > 100) this.taskCache.shift();
        }

        const frame = JSON.stringify(payload);
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(frame);
            }
        });
    }

    private async handleTelemetry(nodeId: string, payload: any) {
        const fullPayload = { nodeId, type: 'telemetry', ...payload };
        this.emit('telemetry', fullPayload);
        this.broadcast(fullPayload);
    }

    /**
     * Injects a top-level task and triggers the Triad Architect loop via MevBridge.
     *
     * Symphony §7 invariant: each task is claimed exactly once at a time.
     * Concurrent calls with the same goal are rejected with a
     * `duplicate_claim` receipt rather than dispatched twice.
     */
    public async injectTask(goal: string): Promise<VerificationReceipt> {
        const taskHash = crypto.createHash('sha256').update(goal).digest('hex');
        const cycleId = crypto.randomUUID();
        const cycleLog = this.log.scope({ cycle_id: cycleId, task_hash: taskHash });

        this.claims.register(taskHash, `inject:${goal.slice(0, 60)}`);
        const claimed = this.claims.tryClaim(taskHash, cycleId, 'orchestrator_inject');
        if (!claimed) {
            const current = this.claims.get(taskHash);
            cycleLog.warn('duplicate_dispatch_refused', { current_state: current?.state });
            throw new Error(`Task already in flight (state=${current?.state}); refusing duplicate dispatch.`);
        }

        cycleLog.info('claim_acquired', { goal_preview: goal.slice(0, 80) });
        this.claims.markRunning(taskHash, cycleId);

        // Symphony §9 — every cycle gets an isolated workspace directory.
        let workspacePath: string | undefined;
        try {
            workspacePath = this.workspaces.acquire(cycleId);
        } catch (err) {
            cycleLog.warn('workspace_acquire_failed', { error: (err as Error).message });
        }

        const hookCtx = { cycleId, taskHash, workspacePath, goal };

        // Symphony §10.1 — after_create FAILS the cycle.
        const afterCreate = await this.hooks.run('after_create', hookCtx);
        if (this.hooks.shouldAbort('after_create', afterCreate)) {
            if (workspacePath) this.workspaces.release(cycleId);
            this.claims.release(taskHash, 'hook_after_create_aborted');
            throw new Error('after_create hook aborted cycle');
        }

        // Symphony §10.1 — before_run FAILS the cycle.
        const beforeRun = await this.hooks.run('before_run', hookCtx);
        if (this.hooks.shouldAbort('before_run', beforeRun)) {
            if (workspacePath) this.workspaces.release(cycleId);
            this.claims.release(taskHash, 'hook_before_run_aborted');
            throw new Error('before_run hook aborted cycle');
        }

        let receipt: VerificationReceipt;
        try {
            receipt = await this.mevBridge.execute(goal, [
                { role: 'system', content: 'You are Nyx, the Sovereign Intelligence.' },
                { role: 'user', content: `Execute goal: ${goal}` },
            ]);
        } catch (err) {
            // The MevBridge loop threw before producing a receipt. Hand the
            // task to the retry queue; it will either schedule a re-dispatch
            // with exponential backoff or release the claim as exhausted.
            const reason = `execute_threw:${(err as Error).message}`;
            this.retryQueue.enqueueFailure(taskHash, goal, reason);
            if (workspacePath) this.workspaces.release(cycleId);
            throw err;
        }

        // Symphony §10.1 — after_run failures are logged but do not block.
        await this.hooks.run('after_run', { ...hookCtx, receiptId: receipt.id, status: receipt.status });

        if (receipt.status === 'verified') {
            this.claims.release(taskHash, 'cycle_succeeded');
        } else {
            // Cycle ran to completion but verification failed. Retry policy
            // applies — Symphony §3.1.
            this.retryQueue.enqueueFailure(taskHash, goal, `cycle_failed:${receipt.id}`);
        }

        if (workspacePath) {
            // Symphony §10.1 — before_remove is advisory; failures don't block cleanup.
            await this.hooks.run('before_remove', hookCtx);
            this.workspaces.release(cycleId);
        }

        this.emit('task_routed', { goal, receipt });

        // Route through broadcast() so the new_task frame is cached and
        // replayed to late-joining WebSocket clients during initial sync.
        this.broadcast({
            type: 'new_task',
            task: {
                id: receipt.id,
                name: goal,
                status: receipt.status,
                receipt: receipt,
            },
        });

        return receipt;
    }

    /**
     * Returns a Promise that resolves to the bound port once the HTTP server
     * is listening. Use in tests to get the ephemeral port when port 0 is
     * passed to the constructor.
     */
    public ready(): Promise<number> {
        return new Promise((resolve) => {
            const addr = this.server.address();
            if (addr && typeof addr === 'object') {
                resolve(addr.port);
            } else {
                this.server.once('listening', () => {
                    const a = this.server.address();
                    resolve(a && typeof a === 'object' ? a.port : 0);
                });
            }
        });
    }

    private startInterAgentChatLoop() {
        if (this.interAgentTimer) return;
        
        // Broadcast the first dialogue line immediately to feel snappy
        this.triggerInterAgentChat();

        this.interAgentTimer = setInterval(() => {
            this.triggerInterAgentChat();
        }, 10000); // Live banter dialogue every 10 seconds
        this.log.info('inter_agent_chat_loop_started');
    }

    private stopInterAgentChatLoop() {
        if (this.interAgentTimer) {
            clearInterval(this.interAgentTimer);
            this.interAgentTimer = null;
        }
        this.log.info('inter_agent_chat_loop_stopped');
    }

    private triggerInterAgentChat() {
        const isTechnical = this.interAgentChatMode === 'technical';
        const dialogues = isTechnical ? this.technicalDialogues : this.interestsDialogues;
        if (dialogues.length === 0) return;

        let index = isTechnical ? this.currentTechnicalIndex : this.currentInterestsIndex;
        const dialogue = dialogues[index];

        if (isTechnical) {
            this.currentTechnicalIndex = (index + 1) % dialogues.length;
        } else {
            this.currentInterestsIndex = (index + 1) % dialogues.length;
        }

        // Use the stateful ConversationBus to track history statefully
        if (!this.banterTopicId) {
            try {
                const topic = this.conversationBus.createTopic(
                    'Inter-Agent Banter',
                    ['nyx-antigravity', 'nyx-cli', 'shaev', 'nyx-openclaw']
                );
                this.banterTopicId = topic.id;
            } catch (err: any) {
                this.log.error('failed_to_create_banter_topic', { error: err.message });
            }
        }

        if (this.banterTopicId) {
            try {
                this.conversationBus.postMessage(
                    this.banterTopicId,
                    dialogue.senderId,
                    'assistant',
                    dialogue.content
                );
            } catch (err: any) {
                this.log.error('failed_to_post_banter_message', { error: err.message });
            }
        }

        const msg = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            ...dialogue
        };

        this.broadcast({
            type: 'inter_agent_message',
            data: msg
        });
    }

    public close() {
        for (const timer of this.headerDeadlineTimers.values()) {
            clearTimeout(timer);
        }
        this.headerDeadlineTimers.clear();
        this.stopInterAgentChatLoop();
        this.personaLoader.stop();
        this.workflowLoader.stop();
        this.reconciler.stop();
        this.retryQueue.stop();
        this.hardware.stop();
        this.chairs.stop();
        this.wss.close();
        this.server.close();
        this.memoryDb.close();
    }
}
