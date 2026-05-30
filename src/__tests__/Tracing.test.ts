import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TracingBridge, TraceRingBuffer, CycleTrace, FinishedSpan } from '../services/Tracing.js';
import { MevBridge } from '../MevBridge.js';
import { MeshOrchestrator } from '../MeshOrchestrator.js';
import { setTimeout as sleep } from 'node:timers/promises';

describe('TraceRingBuffer', () => {
    it('wraps at the configured capacity, evicting the oldest entries', () => {
        const ring = new TraceRingBuffer(3);
        for (let i = 0; i < 5; i += 1) {
            const trace: CycleTrace = {
                cycleId: `cycle-${i}`,
                traceId: `trace-${i}`,
                rootSpanId: `span-${i}`,
                startedAt: i,
                endedAt: i + 1,
                spans: [],
            };
            ring.put(trace);
        }
        expect(ring.size()).toBe(3);
        expect(ring.get('cycle-0')).toBeUndefined();
        expect(ring.get('cycle-1')).toBeUndefined();
        expect(ring.get('cycle-2')).toBeDefined();
        expect(ring.get('cycle-3')).toBeDefined();
        expect(ring.get('cycle-4')).toBeDefined();
        const stats = ring.stats();
        expect(stats.capacity).toBe(3);
        expect(stats.size).toBe(3);
        expect(stats.inserted).toBe(5);
        expect(stats.evicted).toBe(2);
    });

    it('defaults to a 1000-cycle capacity and evicts at the boundary', () => {
        const ring = new TraceRingBuffer(1000);
        for (let i = 0; i < 1001; i += 1) {
            ring.put({
                cycleId: `c-${i}`,
                traceId: `t-${i}`,
                rootSpanId: `s-${i}`,
                startedAt: i,
                endedAt: i + 1,
                spans: [],
            });
        }
        expect(ring.size()).toBe(1000);
        expect(ring.stats().evicted).toBe(1);
        expect(ring.get('c-0')).toBeUndefined();
        expect(ring.get('c-1000')).toBeDefined();
    });

    it('rejects an invalid capacity', () => {
        expect(() => new TraceRingBuffer(0)).toThrow();
        expect(() => new TraceRingBuffer(-1)).toThrow();
    });

    it('bounds oversized trace payloads before retaining them', () => {
        const ring = new TraceRingBuffer(2, {
            maxTraceBytes: 2400,
            maxAttributeValueLength: 80,
            maxEventsPerSpan: 2,
        });
        const span: FinishedSpan = {
            traceId: 'trace-huge',
            spanId: 'span-huge',
            parentSpanId: undefined,
            name: 'triad.operator',
            kind: 1,
            startTimeUnixNano: 1,
            endTimeUnixNano: 2,
            durationMs: 1,
            attributes: {
                'kovael.agent.id': 'shaev',
                giant: 'x'.repeat(20_000),
                nested: { a: { b: { c: 'y'.repeat(20_000) } } },
            },
            status: { code: 1 },
            events: Array.from({ length: 12 }, (_, i) => ({
                name: `event-${i}`,
                timeUnixNano: i,
                attributes: { payload: 'z'.repeat(1000) },
            })),
        };

        ring.put({
            cycleId: 'cycle-huge',
            traceId: 'trace-huge',
            rootSpanId: 'root',
            startedAt: 1,
            endedAt: 2,
            spans: Array.from({ length: 12 }, () => span),
        });

        const stored = ring.get('cycle-huge');
        expect(stored).toBeDefined();
        expect(JSON.stringify(stored).length).toBeLessThanOrEqual(2400);
        expect(stored!.spans[0].events.length).toBeLessThanOrEqual(2);
        expect(stored!.spans[0].attributes.giant).toMatch(/\[truncated/);
    });
});

describe('TracingBridge + MevBridge integration', () => {
    let bridge: MevBridge;
    let tracing: TracingBridge;

    beforeAll(async () => {
        tracing = new TracingBridge({ capacity: 16 });
        const ok = await tracing.start();
        expect(ok).toBe(true);
        bridge = new MevBridge(':memory:');
        bridge.setVramFree(16_000);
        bridge.setTracingBridge(tracing);
    });

    afterAll(async () => {
        await tracing.shutdown();
    });

    it('produces a cycle.run span with three sibling triad.* spans', async () => {
        const receipt = await bridge.execute('span-shape-task', [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'user' },
        ]);
        expect(receipt.status).toBe('verified');

        await sleep(10);

        const trace = tracing.ring.get(receipt.cycleId);
        expect(trace).toBeDefined();
        expect(trace!.spans).toHaveLength(4);

        const root = trace!.spans.find((s) => s.name === 'cycle.run');
        const arch = trace!.spans.find((s) => s.name === 'triad.architect');
        const op = trace!.spans.find((s) => s.name === 'triad.operator');
        const ver = trace!.spans.find((s) => s.name === 'triad.verifier');
        expect(root).toBeDefined();
        expect(arch).toBeDefined();
        expect(op).toBeDefined();
        expect(ver).toBeDefined();

        expect(root!.parentSpanId).toBeFalsy();
        expect(arch!.parentSpanId).toBe(root!.spanId);
        expect(op!.parentSpanId).toBe(root!.spanId);
        expect(ver!.parentSpanId).toBe(root!.spanId);

        for (const span of [arch!, op!, ver!]) {
            expect(span.attributes['gen_ai.system']).toBe('kovael-stub');
            expect(span.attributes['gen_ai.request.model']).toBe('stub-markov-v1');
            // Token counts are estimates (char/4) until ChairBridge reports
            // real values, so they live under the kovael.* namespace with an
            // explicit `estimated` flag. NOT the official gen_ai.response.*
            // names — that would mislead cost / dashboard pipelines.
            expect(span.attributes['kovael.gen_ai.response.estimated_input_tokens']).toBeTypeOf('number');
            expect(span.attributes['kovael.gen_ai.response.estimated_output_tokens']).toBeTypeOf('number');
            expect(span.attributes['kovael.gen_ai.token_count_estimated']).toBe(true);
            expect(span.attributes['gen_ai.response.input_tokens']).toBeUndefined();
            expect(span.attributes['gen_ai.response.output_tokens']).toBeUndefined();
            expect(span.attributes['kovael.cycle.id']).toBe(receipt.cycleId);
            expect(span.attributes['kovael.task.hash']).toBe(receipt.taskHash);
            expect(span.attributes['kovael.agent.id']).toBeTypeOf('string');
        }

        expect(root!.attributes['kovael.cycle.id']).toBe(receipt.cycleId);
        expect(root!.attributes['kovael.task.hash']).toBe(receipt.taskHash);
    });
});

describe('/api/v1/traces endpoint', () => {
    it('requires a bearer token when KOVAEL_API_TOKEN is set', async () => {
        const token = 'iter14-test-token';
        const previous = process.env.KOVAEL_API_TOKEN;
        process.env.KOVAEL_API_TOKEN = token;
        try {
            const orch = new MeshOrchestrator(0);
            const port = await orch.ready();
            try {
                const unauth = await fetch(`http://127.0.0.1:${port}/api/v1/traces`);
                expect(unauth.status).toBe(401);

                const ok = await fetch(`http://127.0.0.1:${port}/api/v1/traces`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                expect(ok.status).toBe(200);
                const body = await ok.json();
                expect(body).toHaveProperty('items');
                expect(Array.isArray(body.items)).toBe(true);
            } finally {
                orch.close();
            }
        } finally {
            if (previous === undefined) {
                delete process.env.KOVAEL_API_TOKEN;
            } else {
                process.env.KOVAEL_API_TOKEN = previous;
            }
        }
    });

    it('returns 404 for an unknown cycleId', async () => {
        const orch = new MeshOrchestrator(0);
        const port = await orch.ready();
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/v1/traces/does-not-exist`);
            expect(res.status).toBe(404);
            const body = await res.json();
            expect(body.error).toBe('trace_not_found');
        } finally {
            orch.close();
        }
    });
});
