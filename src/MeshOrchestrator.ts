import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { MevBridge, VerificationReceipt } from './MevBridge.js';
import { MevHandshake } from './services/MevHandshake.js';
import { SemanticIngestor } from './services/SemanticIngestor.js';
import { HardwareMonitor, VramMetrics } from './services/HardwareMonitor.js';
import { PhaseEvent } from './protocols/TriadStateMachine.js';
import { TaskClaimMachine, ClaimEvent, ClaimState } from './protocols/TaskClaimMachine.js';
import { RetryQueue, RetryDispatch } from './services/RetryQueue.js';
import { Reconciler, ReconcileAction } from './services/Reconciler.js';
import { WorkspaceManager } from './services/WorkspaceManager.js';
import { HookRunner, HookResult } from './services/HookRunner.js';
import { WorkflowLoader, WorkflowDocument } from './services/WorkflowLoader.js';
import crypto from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

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
    private agentCards: any[] = [];
    private nodeCache: Map<string, any> = new Map();
    private taskCache: any[] = [];
    private hardwareCache: VramMetrics | null = null;
    private receiptsIssued: number = 0;
    private activeCycles: Map<string, PhaseEvent> = new Map();

    constructor(port: number) {
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
        this.retryQueue = new RetryQueue(this.claims);
        this.retryQueue.bind((goal) => this.injectTask(goal));
        this.reconciler = new Reconciler(this.claims);
        this.workspaces = new WorkspaceManager();
        this.hooks = new HookRunner();
        this.workflowLoader = new WorkflowLoader();

        this.loadAgentCards();
        this.initializeBus();
        this.initializeMemory();
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
        this.workflowLoader.start();

        this.server.listen(port, () => {
            console.log(`[MeshOrchestrator] Server listening on port ${port} (WS + SSE + /api/v1/state)`);
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

    private wireWorkflowLoader() {
        this.workflowLoader.on('workflow_loaded', ({ document, firstLoad }: { document: WorkflowDocument; firstLoad: boolean }) => {
            console.log(`[WorkflowLoader] ${firstLoad ? 'loaded' : 'reloaded'} v${document.frontMatter.version}`);
            this.broadcast({
                type: 'workflow_loaded',
                nodeId: 'workflow-loader',
                data: { version: document.frontMatter.version, firstLoad, loadedAt: document.loadedAt },
            });
        });
        this.workflowLoader.on('workflow_error', (payload: { error: string; keptKnownGood: boolean }) => {
            console.warn(`[WorkflowLoader] reload error (kept_known_good=${payload.keptKnownGood}): ${payload.error}`);
            this.broadcast({
                type: 'workflow_error',
                nodeId: 'workflow-loader',
                data: payload,
            });
        });
    }

    private registerDefaultHooks() {
        // Sentinel logging hooks — purely observational, never abort. They
        // make the §10.1 lifecycle visible in the cockpit feed from the
        // moment the orchestrator boots, even before WORKFLOW.md adds more.
        const log = (event: 'after_create' | 'before_run' | 'after_run' | 'before_remove') => ({
            name: `kovael.sentinel.${event}`,
            event,
            fn: (ctx: { cycleId: string }) => {
                console.log(`[Hook ${event}] cycle=${ctx.cycleId.slice(0, 8)}`);
            },
            timeoutMs: 5000,
        });
        this.hooks.register(log('after_create'));
        this.hooks.register(log('before_run'));
        this.hooks.register(log('after_run'));
        this.hooks.register(log('before_remove'));
    }

    private wireHooks() {
        this.hooks.on('hook_event', (r: HookResult) => {
            if (!r.success) {
                console.warn(`[Hook ${r.event}/${r.name}] FAILED in ${r.durationMs}ms (${r.timedOut ? 'timeout' : 'error'}): ${r.error}`);
            }
            this.broadcast({ type: 'hook_event', nodeId: 'hook-runner', data: r });
        });
    }

    private wireReconciler() {
        this.reconciler.on('reconcile_action', (action: ReconcileAction) => {
            if (action.kind === 'stall_detected') {
                console.warn(`[Reconciler] stall released: ${action.taskHash.slice(0, 12)} was ${action.previousState} for ${action.ageMs}ms`);
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
            console.log(`[RetryQueue] scheduled attempt ${d.attempt} for ${d.taskHash.slice(0, 12)} in ${d.backoffMs}ms (reason: ${d.reason})`);
            this.broadcast({ type: 'retry_event', nodeId: 'retry-queue', data: { kind: 'scheduled', dispatch: d } });
        });
        this.retryQueue.on('retry_dispatching', (d: RetryDispatch) => {
            this.broadcast({ type: 'retry_event', nodeId: 'retry-queue', data: { kind: 'dispatching', dispatch: d } });
        });
        this.retryQueue.on('retry_exhausted', (info: { taskHash: string; attempts: number; reason: string }) => {
            console.warn(`[RetryQueue] exhausted ${info.taskHash.slice(0, 12)} after ${info.attempts} attempts (last: ${info.reason})`);
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
            console.log(`[MeshOrchestrator] Loaded ${this.agentCards.length} AgentCards.`);
        }
    }

    private initializeMemory() {
        this.memoryDb.exec(`
            CREATE TABLE semantic_memory(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vector_blob BLOB,
                relevance_weight REAL
            ) STRICT
        `);
    }

    private initializeBus() {
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

            ws.on('message', async (data: string) => {
                let payload: any;
                try { payload = JSON.parse(data); }
                catch { return; }

                if (payload && payload.type === 'mission_inject' && typeof payload.goal === 'string') {
                    const goal = payload.goal.trim();
                    if (!goal) return;
                    console.log(`[MeshOrchestrator] Mission injected from cockpit (${nodeId}): ${goal}`);
                    this.injectTask(goal).catch((err) =>
                        console.error('[MeshOrchestrator] Injection failure:', err)
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
     * Broadcasts a message to all connected WebSocket clients and caches it for new arrivals.
     */
    public broadcast(payload: any) {
        // Cache management
        if (payload.type === 'telemetry') {
            this.nodeCache.set(payload.nodeId, payload);
        } else if (payload.type === 'new_task') {
            this.taskCache.push(payload);
        }

        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
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

        this.claims.register(taskHash, `inject:${goal.slice(0, 60)}`);
        const claimed = this.claims.tryClaim(taskHash, cycleId, 'orchestrator_inject');
        if (!claimed) {
            const current = this.claims.get(taskHash);
            console.warn(`[MeshOrchestrator] Refusing duplicate dispatch (taskHash=${taskHash.slice(0, 12)} state=${current?.state})`);
            throw new Error(`Task already in flight (state=${current?.state}); refusing duplicate dispatch.`);
        }

        console.log(`[MeshOrchestrator] Claim acquired (taskHash=${taskHash.slice(0, 12)} cycle=${cycleId.slice(0, 8)}): ${goal}`);
        this.claims.markRunning(taskHash, cycleId);

        // Symphony §9 — every cycle gets an isolated workspace directory.
        let workspacePath: string | undefined;
        try {
            workspacePath = this.workspaces.acquire(cycleId);
        } catch (err) {
            console.warn(`[MeshOrchestrator] workspace acquire failed for ${cycleId}: ${(err as Error).message}`);
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
