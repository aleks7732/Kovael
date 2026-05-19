import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { MevBridge, VerificationReceipt } from './MevBridge.js';
import { MevHandshake } from './services/MevHandshake.js';
import { SemanticIngestor } from './services/SemanticIngestor.js';
import { HardwareMonitor, VramMetrics } from './services/HardwareMonitor.js';
import { PhaseEvent } from './protocols/TriadStateMachine.js';
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

        this.loadAgentCards();
        this.initializeBus();
        this.initializeMemory();
        this.wireHardware();
        this.wireMevBridge();

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
     */
    public async injectTask(goal: string): Promise<VerificationReceipt> {
        console.log(`[MeshOrchestrator] Injecting Task: ${goal}`);
        
        // Execute the Triad Architect Loop (Architect -> Operator -> Verifier)
        const receipt = await this.mevBridge.execute(goal, [
            { role: 'system', content: 'You are Nyx, the Sovereign Intelligence.' },
            { role: 'user', content: `Execute goal: ${goal}` }
        ]);

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
        this.hardware.stop();
        this.wss.close();
        this.server.close();
        this.memoryDb.close();
    }
}
