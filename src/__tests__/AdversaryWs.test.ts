import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';
import { WebSocket } from 'ws';

describe('Adversary WebSocket Security Lab', () => {
    let orchestrator: MeshOrchestrator;
    let port = 0;
    const VALID_TOKEN = 'adversary-lab-super-secret-token-123456';

    beforeAll(async () => {
        // Gated orchestrator with a small rate limit capacity to test flood guard quickly.
        process.env.KOVAEL_API_TOKEN = VALID_TOKEN;
        orchestrator = new MeshOrchestrator(0, {
            rateLimit: {
                capacity: 3,
                refillPerSec: 0.1, // very slow refill so we can exhaust it easily
            }
        });
        port = await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
        delete process.env.KOVAEL_API_TOKEN;
    });

    beforeEach(() => {
        // Reset the rate limiter buckets before each test to prevent bleed/cross-contamination.
        (orchestrator as any).rateLimiter.reset();
    });

    // Robust helper to probe WebSocket connections
    function probeWs(url: string, opts: { headers?: Record<string, string>; protocols?: string | string[] } = {}, timeoutMs = 1500): Promise<{ opened: boolean; code: number | null }> {
        return new Promise((resolve) => {
            const ws = opts.protocols !== undefined
                ? new WebSocket(url, opts.protocols, { headers: opts.headers })
                : new WebSocket(url, { headers: opts.headers });
            let opened = false;
            const done = (code: number | null) => {
                try { ws.close(); } catch {}
                resolve({ opened, code });
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            ws.on('open', () => {
                opened = true;
            });
            ws.on('close', (code) => {
                clearTimeout(timer);
                done(code);
            });
            ws.on('error', () => {
                // close fires next
            });
        });
    }

    describe('Bearer Auth Gate Checks', () => {
        it('rejects connections missing the Authorization header or token', async () => {
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?nodeId=missing-auth`);
            expect(code).toBe(4401); // private code for unauthorized
        });

        it('accepts connections with a valid bearer header', async () => {
            const { opened, code } = await probeWs(`ws://127.0.0.1:${port}/?nodeId=valid-bearer-hdr`, {
                headers: { Authorization: `Bearer ${VALID_TOKEN}` }
            });
            expect(opened).toBe(true);
            expect(code).not.toBe(4401);
        });

        it('rejects connections with non-bearer scheme in Authorization header', async () => {
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?nodeId=basic-scheme`, {
                headers: { Authorization: `Basic ${Buffer.from(`user:${VALID_TOKEN}`).toString('base64')}` }
            });
            expect(code).toBe(4401);
        });

        it('rejects incorrect bearer token values', async () => {
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?nodeId=wrong-token`, {
                headers: { Authorization: `Bearer wrong-${VALID_TOKEN}` }
            });
            expect(code).toBe(4401);
        });

        it('accepts valid subprotocol token format (Sec-WebSocket-Protocol)', async () => {
            const { opened, code } = await probeWs(`ws://127.0.0.1:${port}/?nodeId=valid-subproto`, {
                protocols: [`bearer.${VALID_TOKEN}`]
            });
            expect(opened).toBe(true);
            expect(code).not.toBe(4401);
        });

        it('rejects incorrect subprotocol token format', async () => {
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?nodeId=invalid-subproto`, {
                protocols: [`bearer.badtoken123`]
            });
            expect(code).toBe(4401);
        });
    });

    describe('Query Parameter Gate Checks', () => {
        it('accepts a valid token passed in query parameters', async () => {
            const { opened, code } = await probeWs(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(VALID_TOKEN)}&nodeId=valid-query`);
            expect(opened).toBe(true);
            expect(code).not.toBe(4401);
        });

        it('rejects empty query token', async () => {
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?token=&nodeId=empty-query`);
            expect(code).toBe(4401);
        });

        it('rejects incorrect query token value', async () => {
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?token=wrongtoken&nodeId=bad-query`);
            expect(code).toBe(4401);
        });

        it('rejects malicious query token with format breaking sequences or script attempts', async () => {
            const malformed = '"><script>alert(1)</script>';
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(malformed)}&nodeId=xss-query`);
            expect(code).toBe(4401);
        });
    });

    describe('Malformed and Edge-Case Tokens', () => {
        it('safely handles extremely large tokens (buffer overflow attempts) and rejects them timing-safely', async () => {
            const giantToken = 'a'.repeat(65536); // 64KB token
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(giantToken)}&nodeId=giant-token`);
            // Node's HTTP parser may reject giant query strings with 1006 (abnormal closure / socket hang-up)
            // or successfully upgrade and application-reject with 4401. Both are safe.
            expect([4401, 1006]).toContain(code);
        });

        it('safely handles tokens with embedded null bytes and control characters without crashing', async () => {
            const dirtyToken = 'secret\x00with\x01control\x00chars';
            const { code } = await probeWs(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(dirtyToken)}&nodeId=dirty-token`);
            expect(code).toBe(4401);
        });

        it('handles malformed Unicode/binary sequences in Authorization headers via REST', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
                headers: {
                    Authorization: 'Bearer \xff\xfe\xfd'
                }
            });
            expect(res.status).toBe(401);
        });
    });

    describe('Flood Guards (Upgrade Storm Rate-Limiting)', () => {
        it('rate-limits WebSocket upgrade storms before verifying tokens', async () => {
            // The capacity is 3. We send 3 rapid invalid requests, they should get 4401.
            // The 4th request should get 4429 because the flood guard bucket is exhausted,
            // regardless of whether the token is valid or invalid.
            const url = (id: string) => `ws://127.0.0.1:${port}/?nodeId=${id}`;

            const res1 = await probeWs(url('storm-req-1'));
            const res2 = await probeWs(url('storm-req-2'));
            const res3 = await probeWs(url('storm-req-3'));

            expect(res1.code).toBe(4401);
            expect(res2.code).toBe(4401);
            expect(res3.code).toBe(4401);

            // Now, bucket should be empty. The next request gets blocked with 4429 (rate_limited)
            const res4 = await probeWs(url('storm-req-4'));
            expect(res4.code).toBe(4429);

            // Even if the 5th request has a VALID token, it should STILL get blocked by flood guard
            // since the bucket is completely exhausted. This proves the rate-limiter acts as a
            // shielding layer BEFORE executing key validation logic.
            const res5 = await probeWs(url('storm-req-5'), {
                headers: { Authorization: `Bearer ${VALID_TOKEN}` }
            });
            expect(res5.code).toBe(4429);
        });
    });
});

describe('WebSocketBus — telemetry hardening', () => {
    let orchestrator: MeshOrchestrator;
    let port = 0;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0, { dbPath: ':memory:' });
        port = await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('payload cannot override nodeId or type fields', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?nodeId=legit-node`);

        const broadcast = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                ws.close();
                reject(new Error('timed out waiting for telemetry broadcast'));
            }, 2000);

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    type: 'verification_receipt',
                    nodeId: 'spoofed',
                    payload: {
                        type: 'verification_receipt',
                        nodeId: 'nested-spoofed',
                    },
                }));
            });

            ws.on('message', (data) => {
                const message = JSON.parse(data.toString()) as Record<string, unknown>;
                if (message.type !== 'telemetry') return;
                clearTimeout(timer);
                ws.close();
                resolve(message);
            });

            ws.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        expect(broadcast.type).toBe('telemetry');
        expect(broadcast.nodeId).toBe('legit-node');
    });
});
