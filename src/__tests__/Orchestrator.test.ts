import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MeshOrchestrator, DEFAULT_HTTP_TIMEOUTS } from '../MeshOrchestrator.js';
import { WebSocket } from 'ws';

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
    });

    it('rejects misconfigured httpTimeouts where requestTimeout <= headersTimeout', () => {
        expect(
            () =>
                new MeshOrchestrator(0, {
                    httpTimeouts: { headersTimeout: 20_000, requestTimeout: 10_000 },
                }),
        ).toThrow(/must be 0 or greater than headersTimeout/);
    });

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

    it('GET /readyz returns 200 with status:ok once the orchestrator is ready', async () => {
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

    it('leaves /livez, /readyz, /metrics ungated even with KOVAEL_API_TOKEN set', async () => {
        const livez = await fetch(`http://localhost:${SECURED_PORT}/livez`);
        expect(livez.status).toBe(200);
        const readyz = await fetch(`http://localhost:${SECURED_PORT}/readyz`);
        expect(readyz.status).toBe(200);
        const metrics = await fetch(`http://localhost:${SECURED_PORT}/metrics`);
        expect(metrics.status).toBe(200);
    });

    it('leaves non-/api routes ungated (handshake / WS upgrade path)', async () => {
        // The handshake endpoint is hit through `this.handshake.handleRequest`
        // — it should respond regardless of token presence.
        const res = await fetch(`http://localhost:${SECURED_PORT}/`);
        // Whatever the handshake returns (likely 200 or 404 depending on impl),
        // it must not be the gate's 401 with unauthorized payload.
        expect(res.status).not.toBe(401);
    });
});
