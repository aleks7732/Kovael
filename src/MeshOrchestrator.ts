import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { MevBridge, VerificationReceipt } from './MevBridge.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Nyx-Orchestrator v2: Central bus for the Sovereign Agentic Mesh.
 * Handles telemetry, task routing, and shared memory synchronization.
 */
export class MeshOrchestrator extends EventEmitter {
    private wss: WebSocketServer;
    private memoryDb: DatabaseSync;
    private mevBridge: MevBridge;
    private agentCards: any[] = [];

    constructor(port: number) {
        super();
        this.wss = new WebSocketServer({ port });
        // Native, zero-dependency, in-memory semantic storage
        this.memoryDb = new DatabaseSync(':memory:'); 
        this.mevBridge = new MevBridge(':memory:');
        this.loadAgentCards();
        this.initializeBus();
        this.initializeMemory();
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
            
            // Broadcast AgentCards to the new connection
            this.agentCards.forEach(card => {
                ws.send(JSON.stringify({
                    type: 'agent_card',
                    data: card
                }));
            });

            ws.on('message', async (data: string) => {
                const payload = JSON.parse(data);
                await this.handleTelemetry(nodeId, payload);
            });

            // Listen for MevBridge cycles and broadcast to telemetry
            this.mevBridge.on('cycle_complete', (receipt: VerificationReceipt) => {
                ws.send(JSON.stringify({
                    type: 'verification_receipt',
                    nodeId: receipt.verifierId,
                    data: receipt
                }));
            });
        });
    }

    private extractNodeId(request: any): string {
        const url = new URL(request.url || '', `http://${request.headers.host}`);
        return url.searchParams.get('nodeId') || 'unknown';
    }

    private async handleTelemetry(nodeId: string, payload: any) {
        this.emit('telemetry', { nodeId, ...payload });
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
    }
}
