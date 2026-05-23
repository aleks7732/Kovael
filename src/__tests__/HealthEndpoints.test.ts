import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { HealthEndpoints } from '../services/HealthEndpoints.js';
import type { MetricsSnapshot } from '../services/HealthEndpoints.js';

// -------------------------------------------------------------------------
// Lightweight mock for node:http ServerResponse
// -------------------------------------------------------------------------

interface MockRes {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    /** Matches the real signature used by the implementation. */
    writeHead: (code: number, headers?: Record<string, string>) => void;
    end: (data?: string) => void;
}

function mockRes(): MockRes {
    const res: MockRes = {
        statusCode: 0,
        headers: {},
        body: '',
        writeHead(code, headers = {}) {
            this.statusCode = code;
            Object.assign(this.headers, headers);
        },
        end(data = '') {
            this.body = data;
        },
    };
    return res;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeEndpoints(
    snap: MetricsSnapshot = { chairsActive: 1, topicsActive: 0 },
    opts: { minReadyChairs?: number } = {},
): HealthEndpoints {
    return new HealthEndpoints(() => snap, opts);
}

// -------------------------------------------------------------------------
// /livez
// -------------------------------------------------------------------------

describe('HealthEndpoints — livez', () => {
    it('always responds 200 regardless of ready state', () => {
        const ep = makeEndpoints();
        const res = mockRes();
        ep.livez(res as unknown as ServerResponse);
        expect(res.statusCode).toBe(200);
    });

    it('body contains status:ok and uptime_s', () => {
        const ep = makeEndpoints();
        const res = mockRes();
        ep.livez(res as unknown as ServerResponse);
        const body = JSON.parse(res.body) as { status: string; uptime_s: number };
        expect(body.status).toBe('ok');
        expect(typeof body.uptime_s).toBe('number');
        expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    });

    it('returns 200 even before setReady() is called', () => {
        const ep = makeEndpoints({ chairsActive: 0, topicsActive: 0 });
        const res = mockRes();
        ep.livez(res as unknown as ServerResponse);
        expect(res.statusCode).toBe(200);
    });
});

// -------------------------------------------------------------------------
// /readyz
// -------------------------------------------------------------------------

describe('HealthEndpoints — readyz', () => {
    it('returns 503 before setReady() is called', () => {
        const ep = makeEndpoints({ chairsActive: 2, topicsActive: 0 });
        const res = mockRes();
        ep.readyz(res as unknown as ServerResponse);
        expect(res.statusCode).toBe(503);
    });

    it('returns 503 after setReady() if chairs below minimum', () => {
        const ep = makeEndpoints({ chairsActive: 0, topicsActive: 0 }, { minReadyChairs: 1 });
        ep.setReady();
        const res = mockRes();
        ep.readyz(res as unknown as ServerResponse);
        expect(res.statusCode).toBe(503);
    });

    it('returns 200 after setReady() when chairs meet minimum', () => {
        const ep = makeEndpoints({ chairsActive: 1, topicsActive: 0 }, { minReadyChairs: 1 });
        ep.setReady();
        const res = mockRes();
        ep.readyz(res as unknown as ServerResponse);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({ status: 'ok' });
    });

    it('works with minReadyChairs: 0 (no chairs required)', () => {
        const ep = makeEndpoints({ chairsActive: 0, topicsActive: 0 }, { minReadyChairs: 0 });
        ep.setReady();
        const res = mockRes();
        ep.readyz(res as unknown as ServerResponse);
        expect(res.statusCode).toBe(200);
    });

    it('returns 500 when the snapshot function throws', () => {
        const ep = new HealthEndpoints(() => {
            throw new Error('snapshot exploded');
        });
        ep.setReady();
        const res = mockRes();
        ep.readyz(res as unknown as ServerResponse);
        expect(res.statusCode).toBe(500);
    });

    it('body contains min_ready_chairs', () => {
        const ep = makeEndpoints({ chairsActive: 0, topicsActive: 0 }, { minReadyChairs: 3 });
        const res = mockRes();
        ep.readyz(res as unknown as ServerResponse);
        expect(JSON.parse(res.body)).toMatchObject({ min_ready_chairs: 3 });
    });
});

// -------------------------------------------------------------------------
// /metrics
// -------------------------------------------------------------------------

describe('HealthEndpoints — metrics', () => {
    it('responds with text/plain content-type', () => {
        const ep = makeEndpoints();
        const res = mockRes();
        ep.metrics(res as unknown as ServerResponse);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
    });

    it('Prometheus output contains required metric names', () => {
        const ep = makeEndpoints({ chairsActive: 3, topicsActive: 7 });
        const res = mockRes();
        ep.metrics(res as unknown as ServerResponse);

        expect(res.body).toContain('kovael_uptime_seconds');
        expect(res.body).toContain('kovael_chairs_active 3');
        expect(res.body).toContain('kovael_topics_active 7');
        expect(res.body).toContain('kovael_process_resident_memory_bytes');
        expect(res.body).toContain('kovael_process_heap_used_bytes');
    });

    it('returns 500 when the snapshot function throws', () => {
        const ep = new HealthEndpoints(() => {
            throw new Error('snap fail');
        });
        const res = mockRes();
        ep.metrics(res as unknown as ServerResponse);
        expect(res.statusCode).toBe(500);
    });
});
