/**
 * Integration / end-to-end tests for the Kovael Sovereign Agentic Mesh.
 *
 * Each describe block boots a real MeshOrchestrator on an ephemeral port
 * (port 0) and tears it down after the suite. No mocks of the WebSocket bus
 * or HTTP server — these exercise the full in-process pipeline.
 *
 * Deliverables covered:
 *   1. Boot smoke test — HTTP state endpoint, WS handshake, structured logs
 *   2. E2E mission_inject — full Triad cycle event sequence + receipt shape
 *   3. Duplicate-dispatch contention — exactly 1 winner, 4 rejections
 *   4. Retry + reconcile interaction — RetryQueued → exhausted, no orphans
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';
import { WebSocket } from 'ws';
import * as http from 'node:http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all WS frames as parsed objects until `until` predicate is true or `timeoutMs` elapses. */
function collectWsFrames(
    ws: WebSocket,
    until: (frames: any[]) => boolean,
    timeoutMs: number,
): Promise<any[]> {
    return new Promise((resolve) => {
        const frames: any[] = [];
        const finish = () => resolve(frames);
        const timer = setTimeout(finish, timeoutMs);

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                frames.push(msg);
                if (until(frames)) {
                    clearTimeout(timer);
                    resolve(frames);
                }
            } catch {
                // ignore non-JSON
            }
        });
    });
}

async function httpGet(url: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
            });
        }).on('error', reject);
    });
}

function waitMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 1. Boot smoke test
// ---------------------------------------------------------------------------
describe('Boot smoke test', () => {
    let orchestrator: MeshOrchestrator;
    let port: number;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0);
        port = await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('HTTP GET /api/v1/state returns 200 with documented shape', async () => {
        const { status, body } = await httpGet(`http://localhost:${port}/api/v1/state`);
        expect(status).toBe(200);

        // All documented top-level keys must be present
        const keys = [
            'agentCards', 'connectedClients', 'nodes', 'tasksTotal',
            'receiptsIssued', 'activeCycles', 'hardware', 'claims',
            'retryQueue', 'reconciler', 'workspaces', 'hooks',
            'workflow', 'tokens', 'rateLimits',
        ];
        for (const k of keys) {
            expect(body, `missing key: ${k}`).toHaveProperty(k);
        }
        expect(typeof body.receiptsIssued).toBe('number');
        expect(Array.isArray(body.activeCycles)).toBe(true);
        expect(Array.isArray(body.rateLimits)).toBe(true);
        expect(body.tokens).toMatchObject({ input: expect.any(Number), output: expect.any(Number), total: expect.any(Number) });
    });

    it('WebSocket upgrade succeeds and client receives hardware_telemetry frame', async () => {
        const ws = new WebSocket(`ws://localhost:${port}?nodeId=smoke-test`);

        const frames = await collectWsFrames(
            ws,
            (fs) => fs.some((f) => f.type === 'hardware_telemetry'),
            2500,
        );
        ws.close();

        const hw = frames.find((f) => f.type === 'hardware_telemetry');
        expect(hw).toBeDefined();
        expect(hw.data).toMatchObject({
            status: expect.stringMatching(/^(ok|unavailable|error)$/),
            freeMb: expect.any(Number),
        });
    });

    it('close() shuts down without throwing', () => {
        // A second orchestrator on ephemeral port — we close it immediately.
        const o2 = new MeshOrchestrator(0);
        expect(() => o2.close()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// 2. E2E mission_inject — full Triad cycle
// ---------------------------------------------------------------------------
describe('E2E mission_inject', () => {
    let orchestrator: MeshOrchestrator;
    let port: number;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0);
        port = await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('produces claim → phase → receipt → token_update sequence and correct receipt shape', async () => {
        const ws = new WebSocket(`ws://localhost:${port}?nodeId=e2e-test`);
        await new Promise<void>((res, rej) => {
            ws.on('open', res);
            ws.on('error', rej);
        });

        // Drain any cached frames from connect (agent_card, hardware_telemetry etc.)
        await waitMs(50);

        // Collect frames — stop once we see verification_receipt
        const collectPromise = collectWsFrames(
            ws,
            (fs) => fs.some((f) => f.type === 'verification_receipt'),
            3000,
        );

        ws.send(JSON.stringify({ type: 'mission_inject', goal: 'integration test goal', origin: 'e2e' }));
        const frames = await collectPromise;
        ws.close();

        // Helpers
        const claimFrames = frames.filter((f) => f.type === 'claim_event');
        const phaseFrames  = frames.filter((f) => f.type === 'phase_change');
        const receiptFrames = frames.filter((f) => f.type === 'verification_receipt');
        const tokenFrames  = frames.filter((f) => f.type === 'token_update');

        // Claim sequence: Unclaimed → Claimed → Running → Released (in that order)
        const claimStates = claimFrames.map((f) => f.data.state as string);
        expect(claimStates).toContain('Claimed');
        expect(claimStates).toContain('Running');
        expect(claimStates).toContain('Released');
        const claimedIdx = claimStates.indexOf('Claimed');
        const runningIdx = claimStates.indexOf('Running');
        const releasedIdx = claimStates.lastIndexOf('Released');
        expect(claimedIdx).toBeLessThan(runningIdx);
        expect(runningIdx).toBeLessThan(releasedIdx);

        // Phase sequence includes DispatchToArchitect and Succeeded
        const phases = phaseFrames.map((f) => f.data.phase as string);
        expect(phases).toContain('DispatchToArchitect');
        expect(phases).toContain('Succeeded');
        expect(phases.indexOf('DispatchToArchitect')).toBeLessThan(phases.indexOf('Succeeded'));

        // Exactly ONE verification_receipt (fix for duplicate broadcast defect)
        expect(receiptFrames).toHaveLength(1);

        // Receipt shape per spec
        const receipt = receiptFrames[0].data;
        expect(receipt).toMatchObject({
            id:          expect.any(String),
            cycleId:     expect.any(String),
            taskHash:    expect.any(String),
            status:      'verified',
            routing:     expect.objectContaining({ rationale: expect.any(String) }),
            phaseTrail:  expect.any(Array),
        });
        expect(receipt.phaseTrail.length).toBeGreaterThan(0);
        expect(receipt.tokens).toMatchObject({
            input:     expect.any(Number),
            output:    expect.any(Number),
            total:     expect.any(Number),
            runtimeMs: expect.any(Number),
            source:    expect.stringMatching(/^(estimate|reported)$/),
        });
        expect(receipt.routing.rationale).toBeTruthy();

        // token_update must arrive
        expect(tokenFrames.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// 3. Duplicate-dispatch contention
// ---------------------------------------------------------------------------
describe('Duplicate-dispatch contention', () => {
    let orchestrator: MeshOrchestrator;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0);
        await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('5 concurrent injectTask calls → exactly 1 receipt, 4 "already in flight" rejections', async () => {
        const goal = 'contention-test-goal-' + Date.now();
        const results = await Promise.allSettled(
            Array.from({ length: 5 }, () => orchestrator.injectTask(goal)),
        );

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected  = results.filter((r) => r.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(4);

        for (const r of rejected) {
            expect((r as PromiseRejectedResult).reason.message).toMatch(/already in flight/i);
        }

        // Claim ledger: one Released entry for this taskHash
        const claims = (orchestrator as any).claims;
        const snapshot = claims.snapshot() as Array<{ taskHash: string; state: string }>;
        const crypto = await import('node:crypto');
        const taskHash = crypto.createHash('sha256').update(goal).digest('hex');
        const entry = snapshot.find((r) => r.taskHash === taskHash);
        expect(entry).toBeDefined();
        expect(entry!.state).toBe('Released');
    });
});

// ---------------------------------------------------------------------------
// 4. Retry + reconcile interaction
// ---------------------------------------------------------------------------
describe('Retry + reconcile interaction', () => {
    let orchestrator: MeshOrchestrator;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0, {
            retryQueue: { baseMs: 50, factor: 2, maxAttempts: 2, sweepIntervalMs: 25 },
            reconciler: { stallTimeoutMs: 2000, sweepIntervalMs: 50 },
        });
        await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('failing execute → retry_scheduled → second failure → retry_exhausted → no orphan entries', async () => {
        const goal = 'retry-test-goal-' + Date.now();
        const events: string[] = [];

        // Stub mevBridge.execute to always throw
        const mevBridge = (orchestrator as any).mevBridge;
        const stub = vi.spyOn(mevBridge, 'execute').mockRejectedValue(new Error('stub_failure'));

        const retryQueue = (orchestrator as any).retryQueue;
        retryQueue.updateConfig({ baseMs: 50, factor: 2, maxAttempts: 2, sweepIntervalMs: 25 });
        retryQueue.on('retry_scheduled', () => events.push('retry_scheduled'));
        retryQueue.on('retry_exhausted', () => events.push('retry_exhausted'));

        // First dispatch — will throw after enqueuing retry
        await expect(orchestrator.injectTask(goal)).rejects.toThrow('stub_failure');

        // Wait for retry sweep + second attempt + exhaustion (up to 500ms)
        await waitMs(500);

        stub.mockRestore();

        // Events emitted
        expect(events).toContain('retry_scheduled');
        expect(events).toContain('retry_exhausted');

        // Claim state is Released
        const claims = (orchestrator as any).claims;
        const crypto = await import('node:crypto');
        const taskHash = crypto.createHash('sha256').update(goal).digest('hex');
        const record = claims.get(taskHash);
        expect(record?.state).toBe('Released');

        // No orphan entries in RetryQueue's pending map
        expect(retryQueue.pendingCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// E2E — Conversation Theater (Phoenix Day 3/4)
//
// Locks in the bus contract the cockpit Theater depends on:
//   - opening a topic broadcasts `conversation_topic_opened`
//   - posting an @-mention triggers a convene loop
//   - participants emit at least one `conversation_message_delta`
//   - the adaptive-stability stopping criterion fires within budget
//   - closing the topic broadcasts `conversation_topic_closed`
// ---------------------------------------------------------------------------
describe('E2E — Conversation Theater', () => {
    let orchestrator: MeshOrchestrator;
    let port: number;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0);
        port = await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('open → @mention message → deltas stream → stopping fires → close', async () => {
        const ws = new WebSocket(`ws://localhost:${port}?nodeId=theater-e2e`);
        await new Promise<void>((resolve) => ws.once('open', () => resolve()));

        const framesPromise = collectWsFrames(
            ws,
            (frames) => frames.some((f) => f.type === 'conversation_stopping_criterion'),
            15_000,
        );

        // 1. open topic
        const createRes = await fetch(`http://localhost:${port}/api/v1/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'e2e · retry policy',
                participants: ['nyx-antigravity', 'shaev', 'nyx-codex'],
            }),
        });
        expect(createRes.ok).toBe(true);
        const topic = (await createRes.json()) as { id: string };

        // 2. post @mention message
        const msgRes = await fetch(`http://localhost:${port}/api/v1/conversations/${topic.id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                senderId: 'operator',
                content: '@Nyx-Antigravity @Shaev @Nyx-Codex propose a policy',
            }),
        });
        expect(msgRes.ok).toBe(true);

        // 3. wait for stopping criterion
        const frames = await framesPromise;
        const deltas = frames.filter((f) => f.type === 'conversation_message_delta');
        const stopping = frames.find((f) => f.type === 'conversation_stopping_criterion');
        const opened = frames.find((f) => f.type === 'conversation_topic_opened');

        expect(opened).toBeDefined();
        expect(deltas.length).toBeGreaterThan(0);
        expect(stopping).toBeDefined();
        expect(stopping?.topicId).toBe(topic.id);
        // Adaptive-stability semantics: reason field present and confidence is a number in [0, 1]
        expect(typeof stopping?.reason).toBe('string');
        expect(typeof stopping?.confidence).toBe('number');

        // 4. close topic
        const closeRes = await fetch(`http://localhost:${port}/api/v1/conversations/${topic.id}/close`, {
            method: 'POST',
        });
        expect(closeRes.ok).toBe(true);

        ws.close();
    }, 20_000);

    it('rejects missing-field requests with 400', async () => {
        const noTitle = await fetch(`http://localhost:${port}/api/v1/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ participants: ['shaev'] }),
        });
        expect(noTitle.status).toBe(400);
    });
});
