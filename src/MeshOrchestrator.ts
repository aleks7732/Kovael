import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
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
import { Logger, rootLogger } from './services/Logger.js';
import crypto from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { AgentCards } from './AgentCards.js';


export interface OrchestratorConfig {
    retryQueue?: Partial<RetryConfig>;
    reconciler?: Partial<ReconcilerConfig>;
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
    private rateLimits: RateLimitTracker;
    private log: Logger = rootLogger;
    private agentCards: any[] = [];
    private nodeCache: Map<string, any> = new Map();
    private taskCache: any[] = [];
    private hardwareCache: VramMetrics | null = null;
    private receiptsIssued: number = 0;
    private activeCycles: Map<string, PhaseEvent> = new Map();
    private tokenTotals = { input: 0, output: 0, total: 0, runtimeMs: 0, cycles: 0 };

    constructor(port: number, cfg: OrchestratorConfig = {}) {
        super();
        this.handshake = new MevHandshake();

        // Host SSE Handshake + observability snapshot endpoint
        this.server = http.createServer((req, res) => {
            if (req.url && req.url.startsWith('/api/v1/state')) {
                this.handleStateSnapshot(req, res);
                return;
            }
            this.handshake.handleRequest(req, res);
        });

        this.wss = new WebSocketServer({ server: this.server });

        // Native, zero-dependency, in-memory semantic storage
        this.memoryDb = new DatabaseSync(':memory:');
        this.ingestor = new SemanticIngestor(this.memoryDb);
        this.mevBridge = new MevBridge(':memory:');
        this.hardware = new HardwareMonitor(2000);
        this.claims = new TaskClaimMachine();
        this.retryQueue = new RetryQueue(this.claims, cfg.retryQueue ?? {});
        this.retryQueue.bind((goal) => this.injectTask(goal));
        this.reconciler = new Reconciler(this.claims, cfg.reconciler ?? {});
        this.workspaces = new WorkspaceManager();
        this.hooks = new HookRunner();
        this.workflowLoader = new WorkflowLoader();
        this.rateLimits = new RateLimitTracker();
        this.mevBridge.setRateLimitTracker(this.rateLimits);

        this.loadAgentCards();
        this.initializeBus();
        this.wireHardware();
        this.wireMevBridge();
        this.wireClaims();
        this.wireRetryQueue();
        this.wireReconciler();
        this.wireHooks();

        this.retryQueue.start();
        this.reconciler.start();
        this.registerDefaultHooks();
        this.wireWorkflowLoader();
        this.wireRateLimits();
        this.workflowLoader.start();

        this.server.listen(port, () => {
            const addr = this.server.address();
            const boundPort = addr && typeof addr === 'object' ? addr.port : port;
            this.log.info('orchestrator_listening', { port: boundPort, surfaces: ['ws', 'sse', '/api/v1/state'] });
        });

        this.hardware.start();
        this.triggerIngest();
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
        };
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(snapshot));
    }

    private triggerIngest() {
        const rootPath = path.resolve(process.cwd(), '..');
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
        
        // Broadcast to all connected WS clients
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'new_task',
                    task: {
                        id: receipt.id,
                        name: goal,
                        status: receipt.status,
                        receipt: receipt
                    }
                }));
            }
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

    public close() {
        this.workflowLoader.stop();
        this.reconciler.stop();
        this.retryQueue.stop();
        this.hardware.stop();
        this.wss.close();
        this.server.close();
        this.memoryDb.close();
    }
}
