import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';

describe('HttpApiRouter — readJsonBody', () => {
    let orchestrator: MeshOrchestrator;
    let port = 0;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0, { dbPath: ':memory:' });
        port = await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('parses valid JSON body and returns 200', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/comfy/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'test', prompt: 'hello' }),
        });

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toMatchObject({
            agentId: 'test',
            source: 'fallback',
        });
    });

    it('rejects oversized body with 413', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/comfy/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: 'x'.repeat(20 * 1024) }),
        });

        expect(res.status).toBe(413);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toMatchObject({
            error: 'payload_too_large',
            max_bytes: 16 * 1024,
        });
    });

    it('rejects malformed JSON with 400', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/comfy/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not json at all',
        });

        expect(res.status).toBe(400);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toEqual({ error: 'invalid_json' });
    });

    it('accepts empty body as empty object', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/comfy/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': '0' },
            body: '',
        });

        expect(res.status).toBe(400);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toEqual({ error: 'missing_required_fields', need: ['agentId', 'prompt'] });
    });
});

describe('HttpApiRouter — CORS preflight', () => {
    let orchestrator: MeshOrchestrator;
    let port = 0;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0, { dbPath: ':memory:' });
        port = await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('OPTIONS request returns 204 with CORS headers', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
            method: 'OPTIONS',
        });

        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
        expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization, traceparent, tracestate');
        expect(res.headers.get('access-control-max-age')).toBe('86400');
    });

    it('non-OPTIONS requests include CORS origin header in JSON responses', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`);

        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
});
