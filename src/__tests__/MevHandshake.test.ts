import { describe, it, expect, vi } from 'vitest';
import { MevHandshake } from '../services/MevHandshake.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// -------------------------------------------------------------------------
// Mocks
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// handleRequest — the only wired surface (SSE keep-alive endpoint)
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

    it('clears the keep-alive heartbeat after the request closes', () => {
        vi.useFakeTimers();
        try {
            const hs = new MevHandshake();
            const req = mockReq('/mev/handshake');
            const res = mockRes();

            hs.handleRequest(req as IncomingMessage, res as unknown as ServerResponse);
            req.emit('close');
            const afterClose = res.chunks.length;

            // Past two heartbeat intervals — a cleared interval writes nothing more.
            vi.advanceTimersByTime(60_000);
            expect(res.chunks.length).toBe(afterClose);
        } finally {
            vi.useRealTimers();
        }
    });
});
