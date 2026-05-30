import { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';

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
}
