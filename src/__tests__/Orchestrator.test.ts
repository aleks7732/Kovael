import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MeshOrchestrator, DEFAULT_HTTP_TIMEOUTS } from '../MeshOrchestrator.js';
import { WebSocket } from 'ws';
import net from 'node:net';

describe('MeshOrchestrator', () => {
    let orchestrator: MeshOrchestrator;
    const PORT = 8081;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(PORT);
        await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('hardens HTTP timeouts against slowloris (loop iter 03)', () => {
        const server = (orchestrator as any).server as import('http').Server;
        expect(server.headersTimeout).toBe(DEFAULT_HTTP_TIMEOUTS.headersTimeout);
        expect(server.requestTimeout).toBe(DEFAULT_HTTP_TIMEOUTS.requestTimeout);
        expect(server.keepAliveTimeout).toBe(DEFAULT_HTTP_TIMEOUTS.keepAliveTimeout);
        // Node's documented invariant — defaults must never violate it.
        expect(server.requestTimeout).toBeGreaterThan(server.headersTimeout);
        expect(server.keepAliveTimeout).toBeLessThan(server.headersTimeout);
    });

    it('rejects misconfigured httpTimeouts where requestTimeout <= headersTimeout', () => {
        expect(
            () =>
                new MeshOrchestrator(0, {
                    httpTimeouts: { headersTimeout: 20_000, requestTimeout: 10_000 },
                }),
        ).toThrow(/must be 0 or greater than headersTimeout/);
    });

    it('rejects misconfigured httpTimeouts where keepAliveTimeout >= headersTimeout', () => {
        expect(
            () =>
                new MeshOrchestrator(0, {
                    httpTimeouts: { headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 10_000 },
                }),
        ).toThrow(/keepAliveTimeout .* must be less than headersTimeout/);
    });

    it('drops incomplete-header connections near headersTimeout budget', async () => {
        const started = Date.now();
        await new Promise<void>((resolve, reject) => {
            const socket = net.createConnection({ host: '127.0.0.1', port: PORT });
            let closed = false;
            let ticker: NodeJS.Timeout | null = null;
            const kill = setTimeout(() => {
                if (closed) return;
                closed = true;
                if (ticker) clearInterval(ticker);
                socket.destroy();
                reject(new Error('slowloris socket was not closed within timeout budget'));
            }, DEFAULT_HTTP_TIMEOUTS.headersTimeout + 8_000);

            socket.on('connect', () => {
                socket.write('GET /api/v1/state HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');
                ticker = setInterval(() => {
                    socket.write('a');
                }, 1000);
            });

            socket.on('error', () => {});
            socket.on('close', () => {
                if (closed) return;
                closed = true;
                clearTimeout(kill);
                if (ticker) clearInterval(ticker);
                // Only assert the upper bound — slowloris correctness is
                // "closes within budget", not "stays open until budget".
                // Lower-bound checks add CI flakiness without value.
                const elapsed = Date.now() - started;
                if (elapsed > DEFAULT_HTTP_TIMEOUTS.headersTimeout + 8_000) {
                    reject(new Error(`connection closed too late: ${elapsed}ms`));
                    return;
                }
                resolve();
            });
        });
    }, 30_000);

    it('should allow WebSocket connections', async () => {
        const ws = new WebSocket(`ws://localhost:${PORT}?nodeId=test-node`);
        
        const isConnected = await new Promise((resolve) => {
            ws.on('open', () => {
                ws.close();
                resolve(true);
            });
            ws.on('error', () => resolve(false));
        });

        expect(isConnected).toBe(true);
    });

    it('should emit task_routed and return a VerificationReceipt when injectTask is called', async () => {
        const taskRoutedSpy = vi.fn();
        orchestrator.on('task_routed', taskRoutedSpy);

        const goal = 'Build a sovereign mesh';
        const receipt = await orchestrator.injectTask(goal);

        // injectTask returns a single VerificationReceipt, not an array
        expect(receipt).toMatchObject({
            id: expect.any(String),
            taskHash: expect.any(String),
            status: expect.stringMatching(/^(verified|failed)$/),
            architectId: expect.any(String),
            operatorId: expect.any(String),
            verifierId: expect.any(String),
        });

        // task_routed fires exactly once per injectTask call
        expect(taskRoutedSpy).toHaveBeenCalledTimes(1);
        expect(taskRoutedSpy).toHaveBeenCalledWith(expect.objectContaining({ goal, receipt }));
    });

    it('should inject compiled persona guidelines into the architect context', async () => {
        const mevBridge = (orchestrator as any).mevBridge;
        const architectSpy = vi.spyOn(mevBridge, 'architect');

        const goal = 'Synthesize graphics and telemetry';
        await orchestrator.injectTask(goal);

        expect(architectSpy).toHaveBeenCalled();
        const callArgs = architectSpy.mock.calls[0];
        const contextArg = callArgs[1] as any[]; // second parameter is context
        const systemMessage = contextArg.find((m: any) => m.role === 'system');

        expect(systemMessage).toBeDefined();
        expect(systemMessage.content).toContain('Your voice guidelines:');
        expect(systemMessage.content).toContain('Your disposition in the mesh:');

        architectSpy.mockRestore();
    });

    it('should support REST API endpoints for conversations', async () => {
        // 1. Create a conversation topic
        const createRes = await fetch(`http://localhost:${PORT}/api/v1/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'REST Banter Test',
                participants: ['nyx-antigravity', 'nyx-cli'],
            }),
        });
        expect(createRes.ok).toBe(true);
        const topic = await createRes.json() as any;
        expect(topic.id).toBeDefined();
        expect(topic.title).toBe('REST Banter Test');

        // 2. Post a message to the topic
        const postRes = await fetch(`http://localhost:${PORT}/api/v1/conversations/${topic.id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                senderId: 'nyx-antigravity',
                content: 'Hello over REST',
            }),
        });
        expect(postRes.ok).toBe(true);
        const msg = await postRes.json() as any;
        expect(msg.content).toBe('Hello over REST');

        // 3. Get history of the topic
        const historyRes = await fetch(`http://localhost:${PORT}/api/v1/conversations/${topic.id}/history`);
        expect(historyRes.ok).toBe(true);
        const history = await historyRes.json() as any[];
        expect(history.length).toBeGreaterThanOrEqual(1);
        expect(history[0].content).toBe('Hello over REST');

        // 4. Close the conversation
        const closeRes = await fetch(`http://localhost:${PORT}/api/v1/conversations/${topic.id}/close`, {
            method: 'POST',
        });
        expect(closeRes.ok).toBe(true);
        const closeResult = await closeRes.json() as any;
        expect(closeResult.success).toBe(true);
    });
});

describe('MeshOrchestrator · health & metrics (loop iter 05)', () => {
    let orch: MeshOrchestrator;
    const HEALTH_PORT = 8083;

    beforeAll(async () => {
        orch = new MeshOrchestrator(HEALTH_PORT);
        await orch.ready();
    });

    afterAll(() => {
        orch.close();
    });

    it('GET /livez returns 200 with status:ok', async () => {
        const res = await fetch(`http://localhost:${HEALTH_PORT}/livez`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = await res.json() as any;
        expect(body.status).toBe('ok');
        expect(typeof body.uptime_s).toBe('number');
    });

    it('GET /readyz returns 503 while no chairs are online', async () => {
        const res = await fetch(`http://localhost:${HEALTH_PORT}/readyz`);
        expect(res.status).toBe(503);
        const body = await res.json() as any;
        expect(body.status).toBe('pending');
    });

    it('GET /readyz returns 200 after at least one chair is online', async () => {
        const claim = await fetch(`http://localhost:${HEALTH_PORT}/api/v1/chairs/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'readiness-agent', provider: 'stub' }),
        });
        expect(claim.status).toBe(200);

        const res = await fetch(`http://localhost:${HEALTH_PORT}/readyz`);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.status).toBe('ok');
    });

    it('GET /metrics returns Prometheus text exposition format', async () => {
        const res = await fetch(`http://localhost:${HEALTH_PORT}/metrics`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/plain');
        const text = await res.text();
        expect(text).toContain('# HELP kovael_uptime_seconds');
        expect(text).toContain('# TYPE kovael_uptime_seconds counter');
        expect(text).toMatch(/^kovael_uptime_seconds \d+$/m);
        expect(text).toMatch(/^kovael_chairs_active \d+$/m);
        expect(text).toMatch(/^kovael_topics_active \d+$/m);
        expect(text).toMatch(/^kovael_process_resident_memory_bytes \d+$/m);
    });
});

describe('MeshOrchestrator · ApiTokenGate (loop iter 04)', () => {
    let secured: MeshOrchestrator;
    const SECURED_PORT = 8082;
    const TOKEN = 'kovael-test-token-DO-NOT-USE-IN-PROD';

    beforeAll(async () => {
        process.env.KOVAEL_API_TOKEN = TOKEN;
        secured = new MeshOrchestrator(SECURED_PORT);
        await secured.ready();
    });

    afterAll(() => {
        secured.close();
        delete process.env.KOVAEL_API_TOKEN;
    });

    it('rejects /api/v1/state without a bearer header', async () => {
        const res = await fetch(`http://localhost:${SECURED_PORT}/api/v1/state`);
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
        const body = await res.json() as any;
        expect(body).toEqual({ error: 'unauthorized', reason: 'missing' });
    });

    it('rejects /api/v1/state with a wrong token (and wrong length — does not 500)', async () => {
        const res = await fetch(`http://localhost:${SECURED_PORT}/api/v1/state`, {
            headers: { Authorization: 'Bearer this-is-definitely-not-the-right-token' },
        });
        expect(res.status).toBe(401);
        const body = await res.json() as any;
        expect(body).toEqual({ error: 'unauthorized', reason: 'invalid' });
    });

    it('rejects /api/v1/state with a non-Bearer scheme', async () => {
        const res = await fetch(`http://localhost:${SECURED_PORT}/api/v1/state`, {
            headers: { Authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString('base64')}` },
        });
        expect(res.status).toBe(401);
    });

    it('accepts /api/v1/state with the correct bearer token', async () => {
        const res = await fetch(`http://localhost:${SECURED_PORT}/api/v1/state`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(res.ok).toBe(true);
    });

    it('leaves /livez and /readyz ungated even with KOVAEL_API_TOKEN set', async () => {
        const livez = await fetch(`http://localhost:${SECURED_PORT}/livez`);
        expect(livez.status).toBe(200);
        const readyz = await fetch(`http://localhost:${SECURED_PORT}/readyz`);
        expect(readyz.status).toBe(503);
    });

    it('/metrics requires bearer token when KOVAEL_API_TOKEN is set (missing/invalid/valid)', async () => {
        const metrics = await fetch(`http://localhost:${SECURED_PORT}/metrics`);
        expect(metrics.status).toBe(401);

        const invalid = await fetch(`http://localhost:${SECURED_PORT}/metrics`, {
            headers: { Authorization: 'Bearer wrong-token' },
        });
        expect(invalid.status).toBe(401);

        const valid = await fetch(`http://localhost:${SECURED_PORT}/metrics`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(valid.status).toBe(200);
    });

    it('leaves non-/api HTTP routes ungated (handshake)', async () => {
        const res = await fetch(`http://localhost:${SECURED_PORT}/`);
        expect(res.status).not.toBe(401);
    });
});

describe('MeshOrchestrator · WebSocket gate (loop iter 09)', () => {
    let gated: MeshOrchestrator;
    let open: MeshOrchestrator;
    const GATED_PORT = 8084;
    const OPEN_PORT = 8085;
    const WS_TOKEN = 'ws-gate-test-token-DO-NOT-USE-IN-PROD';

    beforeAll(async () => {
        process.env.KOVAEL_API_TOKEN = WS_TOKEN;
        gated = new MeshOrchestrator(GATED_PORT);
        await gated.ready();
        delete process.env.KOVAEL_API_TOKEN;
        open = new MeshOrchestrator(OPEN_PORT);
        await open.ready();
    });

    afterAll(() => {
        gated.close();
        open.close();
    });

    // Resolves to { opened, code } so each test can assert without
    // worrying about cleanup or hanging sockets.
    function probe(url: string, opts: { protocols?: string | string[] } = {}, timeoutMs = 2000): Promise<{ opened: boolean; code: number | null }> {
        return new Promise((resolve) => {
            const ws = opts.protocols !== undefined
                ? new WebSocket(url, opts.protocols)
                : new WebSocket(url);
            let opened = false;
            const done = (code: number | null) => {
                try { ws.close(); } catch { /* already closed */ }
                resolve({ opened, code });
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            ws.on('open', () => { opened = true; });
            ws.on('close', (code) => { clearTimeout(timer); done(code); });
            ws.on('error', () => { /* close fires next */ });
        });
    }

    it('rejects WS upgrade with no token (gate enabled) — close code 4401', async () => {
        const { code } = await probe(`ws://localhost:${GATED_PORT}/?nodeId=no-token`);
        expect(code).toBe(4401);
    });

    it('accepts WS upgrade with valid query-param token', async () => {
        const { opened, code } = await probe(`ws://localhost:${GATED_PORT}/?token=${encodeURIComponent(WS_TOKEN)}&nodeId=q`);
        expect(opened).toBe(true);
        expect(code).not.toBe(4401);
    });

    it('rejects WS upgrade with invalid subprotocol token — close code 4401', async () => {
        const { code } = await probe(`ws://localhost:${GATED_PORT}/?nodeId=bad-proto`, {
            protocols: 'bearer.not-the-real-token',
        });
        expect(code).toBe(4401);
    });

    it('accepts WS upgrade via valid Sec-WebSocket-Protocol subprotocol', async () => {
        const ws = new WebSocket(`ws://localhost:${GATED_PORT}/?nodeId=proto-ok`, [`bearer.${WS_TOKEN}`]);
        const result = await new Promise<{ opened: boolean; selected: string }>((resolve) => {
            const t = setTimeout(() => resolve({ opened: false, selected: '' }), 2000);
            ws.on('open', () => {
                clearTimeout(t);
                const selected = ws.protocol;
                ws.close();
                resolve({ opened: true, selected });
            });
            ws.on('error', () => { clearTimeout(t); resolve({ opened: false, selected: '' }); });
        });
        expect(result.opened).toBe(true);
        expect(result.selected).toBe(`bearer.${WS_TOKEN}`);
    });

    it('accepts WS upgrade with gate disabled regardless of token presence', async () => {
        const { opened: noToken } = await probe(`ws://localhost:${OPEN_PORT}/?nodeId=open-1`);
        expect(noToken).toBe(true);
        const { opened: bogus } = await probe(`ws://localhost:${OPEN_PORT}/?token=bogus&nodeId=open-2`);
        expect(bogus).toBe(true);
    });

    it('accepts WS upgrade via valid Authorization: Bearer header', async () => {
        const ws = new WebSocket(`ws://localhost:${GATED_PORT}/?nodeId=hdr`, {
            headers: { Authorization: `Bearer ${WS_TOKEN}` },
        });
        const opened = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(false), 2000);
            ws.on('open', () => { clearTimeout(t); ws.close(); resolve(true); });
            ws.on('error', () => { clearTimeout(t); resolve(false); });
        });
        expect(opened).toBe(true);
    });
});
