import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { RateLimiter, DEFAULT_RATE_LIMITER_CONFIG } from '../services/RateLimiter.js';
import { MeshOrchestrator } from '../MeshOrchestrator.js';

/**
 * Build a minimal IncomingMessage-like object — only the fields the limiter
 * actually reads. Avoids spinning up a real net.Socket per call.
 */
function fakeReq(remoteAddress: string | undefined, xff?: string | string[]): IncomingMessage {
    const headers: Record<string, string | string[]> = {};
    if (xff !== undefined) headers['x-forwarded-for'] = xff;
    return {
        headers,
        socket: { remoteAddress } as unknown,
    } as unknown as IncomingMessage;
}

describe('RateLimiter · token-bucket semantics', () => {
    it('default config matches the iter-15 budget (60 cap, 1/sec refill, 10k LRU)', () => {
        expect(DEFAULT_RATE_LIMITER_CONFIG.capacity).toBe(60);
        expect(DEFAULT_RATE_LIMITER_CONFIG.refillPerSec).toBe(1);
        expect(DEFAULT_RATE_LIMITER_CONFIG.maxEntries).toBe(10_000);
    });

    it('burst of 60 succeeds, 61st is rejected (case a)', () => {
        const limiter = new RateLimiter({}, {} as NodeJS.ProcessEnv);
        const now = 1_000_000;
        const ip = '203.0.113.7';
        for (let i = 0; i < 60; i++) {
            const d = limiter.consume(ip, now);
            expect(d.allowed).toBe(true);
        }
        const denied = limiter.consume(ip, now);
        expect(denied.allowed).toBe(false);
        expect(denied.remaining).toBe(0);
    });

    it('Retry-After is the integer-ceil of seconds until 1 token is available (case b)', () => {
        const limiter = new RateLimiter({}, {} as NodeJS.ProcessEnv);
        const now = 1_000_000;
        const ip = '203.0.113.8';
        for (let i = 0; i < 60; i++) limiter.consume(ip, now);
        const denied = limiter.consume(ip, now);
        // empty bucket, deficit = 1 token, refill 1/sec → 1 second wait, ceil = 1
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterS).toBe(1);

        // Half a token has refilled (500ms at 1/sec) — still empty enough to
        // need another 500ms, which ceils up to 1s.
        const denied2 = limiter.consume(ip, now + 500);
        expect(denied2.allowed).toBe(false);
        expect(denied2.retryAfterS).toBe(1);

        // With a slower refill the wait grows proportionally.
        const slow = new RateLimiter({ capacity: 1, refillPerSec: 0.1 }, {} as NodeJS.ProcessEnv);
        slow.consume('a', now);
        const slowDenied = slow.consume('a', now);
        expect(slowDenied.allowed).toBe(false);
        // deficit = 1 token at 0.1/sec → 10s
        expect(slowDenied.retryAfterS).toBe(10);
    });

    it('bucket refills tokens after wall time advances (case c)', () => {
        const limiter = new RateLimiter({}, {} as NodeJS.ProcessEnv);
        const now = 1_000_000;
        const ip = '203.0.113.9';
        for (let i = 0; i < 60; i++) limiter.consume(ip, now);
        expect(limiter.consume(ip, now).allowed).toBe(false);

        // After 1 full second, refill = 1 token → exactly one more request.
        const afterOne = limiter.consume(ip, now + 1000);
        expect(afterOne.allowed).toBe(true);
        // Bucket is empty again immediately after.
        expect(limiter.consume(ip, now + 1000).allowed).toBe(false);

        // After 60 more seconds the bucket fully refills back to capacity.
        const fullyRefilled = limiter.consume(ip, now + 1000 + 60_000);
        expect(fullyRefilled.allowed).toBe(true);
        // remaining counted post-decrement; capacity-1 tokens still in bucket.
        expect(fullyRefilled.remaining).toBe(59);
    });

    it('refill saturates at capacity — long idle does not create extra burst', () => {
        const limiter = new RateLimiter({}, {} as NodeJS.ProcessEnv);
        const now = 1_000_000;
        const ip = '203.0.113.10';
        limiter.consume(ip, now);
        // Jump forward 24h. We should never be allowed more than `capacity`
        // in the very next burst.
        let allowed = 0;
        for (let i = 0; i < 1000; i++) {
            if (limiter.consume(ip, now + 86_400_000).allowed) allowed++;
            else break;
        }
        expect(allowed).toBe(60);
    });

    it('LRU evicts the oldest bucket when maxEntries is exceeded (case e)', () => {
        const limiter = new RateLimiter({ maxEntries: 3 }, {} as NodeJS.ProcessEnv);
        const now = 1_000_000;
        limiter.consume('ip-a', now);
        limiter.consume('ip-b', now);
        limiter.consume('ip-c', now);
        expect(limiter.size()).toBe(3);

        // Touch a and b so the LRU order is now c -> a -> b (oldest -> newest).
        limiter.consume('ip-a', now + 1);
        limiter.consume('ip-b', now + 2);

        // Insert d: bucket map is at cap, the oldest (ip-c) gets evicted.
        limiter.consume('ip-d', now + 3);
        expect(limiter.size()).toBe(3);

        // Sentinel: re-inserting ip-c with a freshly-empty bucket would require
        // the limiter to grant another full burst, which is the documented
        // behaviour for evicted entries — they rejoin with a full bucket.
        const reborn = limiter.consume('ip-c', now + 4);
        expect(reborn.allowed).toBe(true);
        expect(reborn.remaining).toBe(59);
    });

    it('clientKey ignores X-Forwarded-For by default (case f — untrusted)', () => {
        const limiter = new RateLimiter({}, { /* no KOVAEL_TRUST_PROXY */ } as NodeJS.ProcessEnv);
        const req = fakeReq('10.0.0.1', '198.51.100.50, 10.0.0.99');
        expect(limiter.clientKey(req)).toBe('10.0.0.1');
    });

    it('clientKey honors X-Forwarded-For when KOVAEL_TRUST_PROXY=true (case f — trusted)', () => {
        const limiter = new RateLimiter({}, { KOVAEL_TRUST_PROXY: 'true' } as NodeJS.ProcessEnv);
        const req = fakeReq('10.0.0.1', '198.51.100.50, 10.0.0.99');
        // RFC 7239: leftmost entry is the original client.
        expect(limiter.clientKey(req)).toBe('198.51.100.50');

        // Array form (Node delivers repeated headers as a string[]).
        const reqArr = fakeReq('10.0.0.1', ['198.51.100.51', '10.0.0.99']);
        expect(limiter.clientKey(reqArr)).toBe('198.51.100.51');

        // Missing header falls back to the socket address.
        const reqNoXff = fakeReq('10.0.0.1');
        expect(limiter.clientKey(reqNoXff)).toBe('10.0.0.1');
    });

    it('clientKey falls back to "unknown" when no remote address is exposed', () => {
        const limiter = new RateLimiter({}, {} as NodeJS.ProcessEnv);
        const req = fakeReq(undefined);
        expect(limiter.clientKey(req)).toBe('unknown');
    });
});

describe('MeshOrchestrator · /api/v1/* rate limit (iter 15)', () => {
    let orch: MeshOrchestrator;
    let port: number;

    beforeAll(async () => {
        // Small capacity for fast deterministic tests; the production default
        // (60 cap, 1/sec refill) is covered by the unit suite above.
        orch = new MeshOrchestrator(0, { rateLimit: { capacity: 3, refillPerSec: 1 } });
        port = await orch.ready();
    });

    afterAll(() => {
        orch.close();
    });

    it('rejects the (capacity+1)th /api/v1 request from one IP with 429 + Retry-After', async () => {
        const url = `http://127.0.0.1:${port}/api/v1/state`;
        for (let i = 0; i < 3; i++) {
            const ok = await fetch(url);
            expect(ok.status).toBe(200);
        }
        const denied = await fetch(url);
        expect(denied.status).toBe(429);
        expect(denied.headers.get('retry-after')).toBe('1');
        const body = await denied.json() as any;
        expect(body).toEqual({ error: 'rate_limited', retry_after_s: 1 });
        // The 429 body must not echo the client IP.
        expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1/);
    });

    it('probes (/livez, /readyz, /metrics) are never rate-limited (case d)', async () => {
        // The previous test exhausted this client's bucket. Probes must still
        // succeed regardless of how empty the bucket is.
        for (let i = 0; i < 20; i++) {
            const livez = await fetch(`http://127.0.0.1:${port}/livez`);
            expect(livez.status).toBe(200);
            const readyz = await fetch(`http://127.0.0.1:${port}/readyz`);
            // 200 or 503 depending on chair state — never 429.
            expect([200, 503]).toContain(readyz.status);
            const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
            // No KOVAEL_API_TOKEN set in this suite → metrics is ungated, 200.
            expect(metrics.status).toBe(200);
        }
    });
});
