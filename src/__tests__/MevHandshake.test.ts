import { describe, it, expect, vi } from 'vitest';
import { MevHandshake } from '../services/MevHandshake.js';
import type { Blueprint } from '../services/MevHandshake.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// -------------------------------------------------------------------------
// Mocks
// -------------------------------------------------------------------------

interface WrittenChunk {
    data: string;
}

function mockReq(url: string): IncomingMessage {
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as unknown as { url: string }).url = url;
    return emitter;
}

interface MockRes {
    statusCode: number;
    headers: Record<string, string>;
    chunks: string[];
    ended: boolean;
    body: string;
    writeHead(code: number, headers?: Record<string, string>): void;
    write(data: string): void;
    end(data?: string): void;
}

function mockRes(): MockRes {
    const res: MockRes = {
        statusCode: 0,
        headers: {},
        chunks: [],
        ended: false,
        body: '',
        writeHead(code, headers = {}) {
            this.statusCode = code;
            Object.assign(this.headers, headers);
        },
        write(data) {
            this.chunks.push(data);
        },
        end(data = '') {
            this.body = data;
            this.ended = true;
        },
    };
    return res;
}

const BLUEPRINT: Blueprint = {
    id: 'bp-001',
    schema: 'anx-v1',
    content: { objective: 'test' },
    status: 'pending',
};

// -------------------------------------------------------------------------
// handleRequest
// -------------------------------------------------------------------------

describe('MevHandshake — handleRequest', () => {
    it('responds with SSE headers on /mev/handshake', () => {
        const hs = new MevHandshake();
        const req = mockReq('/mev/handshake');
        const res = mockRes();

        hs.handleRequest(req as IncomingMessage, res as unknown as ServerResponse);

        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe('text/event-stream');
        expect(res.headers['Cache-Control']).toBe('no-cache');
        expect(res.headers['Connection']).toBe('keep-alive');
    });

    it('sends the open event immediately on connect', () => {
        const hs = new MevHandshake();
        const req = mockReq('/mev/handshake');
        const res = mockRes();

        hs.handleRequest(req as IncomingMessage, res as unknown as ServerResponse);

        const openChunk = res.chunks.join('');
        expect(openChunk).toContain('event: open');
        expect(openChunk).toContain('"status":"connected"');
        expect(openChunk).toContain('"channel":"mev_handshake"');
    });

    it('returns 404 for non-handshake routes', () => {
        const hs = new MevHandshake();
        const req = mockReq('/unknown/route');
        const res = mockRes();

        hs.handleRequest(req as IncomingMessage, res as unknown as ServerResponse);

        expect(res.statusCode).toBe(404);
        expect(res.ended).toBe(true);
    });

    it('removes client from set when request closes', () => {
        const hs = new MevHandshake();
        const req = mockReq('/mev/handshake');
        const res = mockRes();

        hs.handleRequest(req as IncomingMessage, res as unknown as ServerResponse);
        const chunksBefore = res.chunks.length;

        // Simulate client disconnect
        req.emit('close');

        // broadcast should no longer reach this client
        hs.broadcastBlueprint(BLUEPRINT);
        expect(res.chunks.length).toBe(chunksBefore);
    });
});

// -------------------------------------------------------------------------
// broadcastBlueprint
// -------------------------------------------------------------------------

describe('MevHandshake — broadcastBlueprint', () => {
    it('sends blueprint_validation event to all connected clients', () => {
        const hs = new MevHandshake();

        const req1 = mockReq('/mev/handshake');
        const res1 = mockRes();
        const req2 = mockReq('/mev/handshake');
        const res2 = mockRes();

        hs.handleRequest(req1 as IncomingMessage, res1 as unknown as ServerResponse);
        hs.handleRequest(req2 as IncomingMessage, res2 as unknown as ServerResponse);

        const before1 = res1.chunks.length;
        const before2 = res2.chunks.length;

        hs.broadcastBlueprint(BLUEPRINT);

        const new1 = res1.chunks.slice(before1).join('');
        const new2 = res2.chunks.slice(before2).join('');

        for (const chunk of [new1, new2]) {
            expect(chunk).toContain('event: blueprint_validation');
            expect(chunk).toContain('"id":"bp-001"');
            expect(chunk).toContain('"status":"pending"');
            expect(chunk).toContain('timestamp');
        }
    });

    it('does not throw when there are no connected clients', () => {
        const hs = new MevHandshake();
        expect(() => hs.broadcastBlueprint(BLUEPRINT)).not.toThrow();
    });

    it('includes a timestamp field injected by the broadcaster', () => {
        const hs = new MevHandshake();
        const req = mockReq('/mev/handshake');
        const res = mockRes();
        hs.handleRequest(req as IncomingMessage, res as unknown as ServerResponse);

        const before = res.chunks.length;
        hs.broadcastBlueprint(BLUEPRINT);

        const chunk = res.chunks.slice(before).join('');
        const match = chunk.match(/"timestamp":(\d+)/);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeGreaterThan(0);
    });
});

// -------------------------------------------------------------------------
// validateSynchronous
// -------------------------------------------------------------------------

describe('MevHandshake — validateSynchronous', () => {
    it('returns true', async () => {
        const hs = new MevHandshake();
        const result = await hs.validateSynchronous(BLUEPRINT);
        expect(result).toBe(true);
    });

    it('broadcasts the blueprint as part of validation', async () => {
        const hs = new MevHandshake();
        const req = mockReq('/mev/handshake');
        const res = mockRes();
        hs.handleRequest(req as IncomingMessage, res as unknown as ServerResponse);

        const before = res.chunks.length;
        await hs.validateSynchronous({ ...BLUEPRINT, id: 'bp-validate' });

        const chunk = res.chunks.slice(before).join('');
        expect(chunk).toContain('"id":"bp-validate"');
    });
});
