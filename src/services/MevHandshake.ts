import { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';

export interface Blueprint {
    id: string;
    schema: string;
    content: unknown;
    status: 'pending' | 'validated' | 'rejected';
}

/**
 * MevHandshake: SSE endpoint for real-time blueprint validation.
 * Enables synchronous verification cycles between Nyx and Shaev.
 */
export class MevHandshake extends EventEmitter {
    private clients: Set<ServerResponse> = new Set();

    /**
     * Handles SSE connection requests.
     */
    public handleRequest(req: IncomingMessage, res: ServerResponse) {
        if (req.url === '/mev/handshake') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });

            // Keep-alive heartbeat every 30 seconds
            const heartbeat = setInterval(() => {
                res.write(': heartbeat\n\n');
            }, 30000);

            res.write('event: open\ndata: {"status":"connected", "channel":"mev_handshake"}\n\n');

            this.clients.add(res);

            const cleanup = () => {
                clearInterval(heartbeat);
                this.clients.delete(res);
            };
            req.on('close', cleanup);
            req.on('error', cleanup);
        } else {
            // Return 404 so unmatched HTTP connections are not left hanging
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
        }
    }

    /**
     * Broadcasts a blueprint to all connected participants for validation.
     */
    public broadcastBlueprint(blueprint: Blueprint) {
        const payload = JSON.stringify({
            ...blueprint,
            timestamp: Date.now()
        });
        
        // Snapshot clients to avoid mutation during iteration.
        for (const client of [...this.clients]) {
            client.write(`event: blueprint_validation\ndata: ${payload}\n\n`);
        }
    }

    /**
     * @deprecated Stub — always returns `true`. Does NOT perform real validation.
     * Currently only triggers {@link broadcastBlueprint}. When real synchronous
     * validation is implemented, this should await a WS response event with a
     * timeout and return the actual validation result.
     */
    public async validateSynchronous(blueprint: Blueprint): Promise<boolean> {
        this.broadcastBlueprint(blueprint);
        return true;
    }
}
