import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { MevBridge, VerificationReceipt } from './MevBridge.js';
import { MevHandshake } from './services/MevHandshake.js';
import { SemanticIngestor } from './services/SemanticIngestor.js';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

/**
 * Nyx-Orchestrator v2: Central bus for the Sovereign Agentic Mesh.
 * Handles telemetry, task routing, and shared memory synchronization.
 */
export class MeshOrchestrator extends EventEmitter {
    private wss: WebSocketServer;
    private server: http.Server;
    private memoryDb: DatabaseSync;
    private mevBridge: MevBridge;
    private handshake: MevHandshake;
    private ingestor: SemanticIngestor;
    private agentCards: any[] = [];
    private nodeCache: Map<string, any> = new Map();
    private taskCache: any[] = [];

    constructor(port: number) {
        super();
        this.handshake = new MevHandshake();
        
        // Host SSE Handshake endpoint on the same port as WS
        this.server = http.createServer((req, res) => {
            this.handshake.handleRequest(req, res);
        });

        this.wss = new WebSocketServer({ server: this.server });
        
        // Native, zero-dependency, in-memory semantic storage
        this.memoryDb = new DatabaseSync(':memory:'); 
        this.ingestor = new SemanticIngestor(this.memoryDb);
        this.mevBridge = new MevBridge(':memory:');
        
        this.loadAgentCards();
        this.initializeBus();
        this.initializeMemory();

        this.server.listen(port, () => {
            console.log(`[MeshOrchestrator] Server listening on port ${port} (WS + SSE Handshake)`);
        });

        this.triggerIngest();
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

            ws.on('message', async (data: string) => {
                const payload = JSON.parse(data);
                await this.handleTelemetry(nodeId, payload);
            });

            // Listen for MevBridge cycles and broadcast to telemetry
            this.mevBridge.on('cycle_complete', (receipt: VerificationReceipt) => {
                const payload = {
                    type: 'verification_receipt',
                    nodeId: receipt.verifierId,
                    data: receipt
                };
                ws.send(JSON.stringify(payload));
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
        this.wss.close();
        this.server.close();
        this.memoryDb.close();
    }
}
