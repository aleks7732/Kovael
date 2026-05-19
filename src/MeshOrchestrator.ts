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

        this.loadAgentCards();
        this.initializeBus();
        this.initializeMemory();
        this.wireHardware();
        this.wireMevBridge();
        this.wireClaims();
        this.wireRetryQueue();
        this.wireReconciler();

        this.retryQueue.start();
        this.reconciler.start();

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
        // The Triad runs in-process today, so cwd validation is dormant; the
        // directory exists for future subprocess agents and for incremental
        // state across retried attempts.
        let workspacePath: string | undefined;
        try {
            workspacePath = this.workspaces.acquire(cycleId);
        } catch (err) {
            console.warn(`[MeshOrchestrator] workspace acquire failed for ${cycleId}: ${(err as Error).message}`);
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

        if (receipt.status === 'verified') {
            this.claims.release(taskHash, 'cycle_succeeded');
        } else {
            // Cycle ran to completion but verification failed. Retry policy
            // applies — Symphony §3.1.
            this.retryQueue.enqueueFailure(taskHash, goal, `cycle_failed:${receipt.id}`);
        }
        if (workspacePath) this.workspaces.release(cycleId);

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
        this.reconciler.stop();
        this.retryQueue.stop();
        this.hardware.stop();
        this.wss.close();
        this.server.close();
        this.memoryDb.close();
    }
}
