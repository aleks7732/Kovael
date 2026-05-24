import { describe, it, expect, afterEach } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
    predicate: () => boolean,
    message: string,
    timeoutMs: number = 1_000,
): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error(message);
}

describe('MeshOrchestrator resource mode', () => {
    let orchestrator: MeshOrchestrator | null = null;

    afterEach(() => {
        orchestrator?.close();
        orchestrator = null;
    });

    it('moves idle after a quiet window and wakes on interactive state requests', async () => {
        orchestrator = new MeshOrchestrator(0, {
            dbPath: ':memory:',
            resourceMode: { idleAfterMs: 50, sweepIntervalMs: 10 },
        });
        const port = await orchestrator.ready();

        await waitFor(
            () => orchestrator?.resourceGovernor.snapshot().mode === 'idle',
            'orchestrator did not enter idle mode',
        );

        const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`);
        expect(res.status).toBe(200);
        const body = await res.json() as { resourceMode: { mode: string; lastActivityReason: string } };
        expect(body.resourceMode.mode).toBe('active');
        expect(body.resourceMode.lastActivityReason).toBe('http:GET:/api/v1/state');
    });

    it('does not treat chair heartbeat traffic as interactive usage', async () => {
        orchestrator = new MeshOrchestrator(0, {
            dbPath: ':memory:',
            resourceMode: { idleAfterMs: 50, sweepIntervalMs: 10 },
        });
        const port = await orchestrator.ready();

        const claim = await fetch(`http://127.0.0.1:${port}/api/v1/chairs/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'resource-mode-chair', provider: 'vitest' }),
        });
        const chair = await claim.json() as { agentId: string; sessionId: string };

        await waitFor(
            () => orchestrator?.resourceGovernor.snapshot().mode === 'idle',
            'orchestrator did not enter idle mode after chair claim',
        );

        const heartbeat = await fetch(`http://127.0.0.1:${port}/api/v1/chairs/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: chair.agentId, sessionId: chair.sessionId }),
        });
        expect(heartbeat.status).toBe(200);
        expect(orchestrator.resourceGovernor.snapshot().mode).toBe('idle');
    });

    it('trims memory-heavy replay caches when entering idle mode', async () => {
        orchestrator = new MeshOrchestrator(0, {
            dbPath: ':memory:',
            resourceMode: {
                idleAfterMs: 50,
                sweepIntervalMs: 10,
                idleTaskCacheRetain: 2,
                idleTraceRetain: 1,
            },
        });
        await orchestrator.ready();

        orchestrator.nodeCache.set('node-a', { type: 'telemetry', nodeId: 'node-a' });
        orchestrator.nodeCache.set('node-b', { type: 'telemetry', nodeId: 'node-b' });
        orchestrator.taskCache = [
            { type: 'new_task', task: { id: 'task-a' } },
            { type: 'new_task', task: { id: 'task-b' } },
            { type: 'new_task', task: { id: 'task-c' } },
        ];
        orchestrator.hardwareCache = {
            status: 'ok',
            timestamp: Date.now(),
            freeMb: 10,
            usedMb: 20,
            totalMb: 30,
            utilizationPct: 40,
            devices: 1,
        };
        orchestrator.tracing?.ring.put({
            cycleId: 'cycle-a',
            traceId: 'trace-a',
            rootSpanId: 'span-a',
            startedAt: 1,
            endedAt: 2,
            spans: [],
        });
        orchestrator.tracing?.ring.put({
            cycleId: 'cycle-b',
            traceId: 'trace-b',
            rootSpanId: 'span-b',
            startedAt: 3,
            endedAt: 4,
            spans: [],
        });

        await waitFor(
            () => orchestrator?.resourceGovernor.snapshot().mode === 'idle',
            'orchestrator did not enter idle mode for trimming',
        );

        expect(orchestrator.nodeCache.size).toBe(0);
        expect(orchestrator.taskCache.map((entry) => entry.task.id)).toEqual(['task-b', 'task-c']);
        expect(orchestrator.hardwareCache).toBeNull();
        expect(orchestrator.tracing?.ring.list(10).map((trace) => trace.cycleId)).toEqual(['cycle-b']);
        expect(orchestrator.resourceGovernor.snapshot().trimCount).toBe(1);
    });
});
