import { describe, it, expect } from 'vitest';
import { TraceRingBuffer, CycleTrace, FinishedSpan } from '../services/Tracing.js';
import crypto from 'node:crypto';

describe('TraceRingBuffer Security & Fuzzing Lab', () => {

    // Helper to generate a random string of a given length
    function randomString(length: number): string {
        return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    }

    // Helper to generate a randomized nested object
    function randomNestedObject(depth: number, width: number): any {
        if (depth <= 0) {
            return randomString(10);
        }
        const obj: Record<string, any> = {};
        for (let i = 0; i < width; i++) {
            const key = `key_${i}_${randomString(4)}`;
            obj[key] = Math.random() > 0.5 
                ? randomNestedObject(depth - 1, width) 
                : Math.random() > 0.5 
                    ? Math.floor(Math.random() * 10000)
                    : Math.random() > 0.5;
        }
        return obj;
    }

    // Helper to generate a randomized finished span
    function generateRandomSpan(opts: {
        maxAttrLength: number;
        eventsCount: number;
        depth: number;
    }): FinishedSpan {
        return {
            traceId: `trace-${crypto.randomUUID()}`,
            spanId: `span-${crypto.randomUUID()}`,
            parentSpanId: Math.random() > 0.3 ? `span-${crypto.randomUUID()}` : undefined,
            name: `span-name-${randomString(10)}`,
            kind: Math.floor(Math.random() * 5),
            startTimeUnixNano: Date.now() * 1_000_000,
            endTimeUnixNano: (Date.now() + 100) * 1_000_000,
            durationMs: Math.random() * 100,
            attributes: {
                'kovael.agent.id': Math.random() > 0.5 ? 'shaev' : 'nyx-antigravity',
                'custom.giant.attribute': randomString(opts.maxAttrLength),
                'custom.nested.attribute': randomNestedObject(opts.depth, 3),
                'circular_ref_payload': { a: 1 } // will add circular ref if needed
            },
            status: {
                code: Math.random() > 0.8 ? 2 : 1,
                message: Math.random() > 0.8 ? `error-${randomString(20)}` : undefined
            },
            events: Array.from({ length: opts.eventsCount }, (_, i) => ({
                name: `event-${i}-${randomString(5)}`,
                timeUnixNano: Date.now() * 1_000_000 + i * 1000,
                attributes: Math.random() > 0.5 ? { info: randomString(20) } : undefined
            }))
        };
    }

    // Helper to generate a complete CycleTrace with random spans
    function generateRandomTrace(spanCount: number, opts: {
        maxAttrLength: number;
        eventsCount: number;
        depth: number;
    }): CycleTrace {
        const cycleId = crypto.randomUUID();
        const traceId = crypto.randomUUID();
        const rootSpanId = crypto.randomUUID();
        return {
            cycleId,
            traceId,
            rootSpanId,
            startedAt: Date.now(),
            endedAt: Date.now() + 500,
            spans: Array.from({ length: spanCount }, () => generateRandomSpan(opts))
        };
    }

    describe('Bounded Size Checks (Capacity Limits)', () => {
        it('strictly maintains capacity boundary under continuous put operations', () => {
            const capacity = 43;
            const ring = new TraceRingBuffer(capacity);

            // Put more than capacity
            for (let i = 0; i < 200; i++) {
                const trace = generateRandomTrace(2, { maxAttrLength: 20, eventsCount: 1, depth: 1 });
                ring.put(trace);
                expect(ring.size()).toBeLessThanOrEqual(capacity);
            }

            expect(ring.size()).toBe(capacity);
            const stats = ring.stats();
            expect(stats.capacity).toBe(capacity);
            expect(stats.size).toBe(capacity);
            expect(stats.inserted).toBe(200);
            expect(stats.evicted).toBe(200 - capacity);
        });

        it('supports capacity of 1 (immediate evictions)', () => {
            const ring = new TraceRingBuffer(1);
            const t1 = generateRandomTrace(1, { maxAttrLength: 10, eventsCount: 0, depth: 0 });
            const t2 = generateRandomTrace(1, { maxAttrLength: 10, eventsCount: 0, depth: 0 });

            ring.put(t1);
            expect(ring.size()).toBe(1);
            expect(ring.get(t1.cycleId)).toBeDefined();

            ring.put(t2);
            expect(ring.size()).toBe(1);
            expect(ring.get(t1.cycleId)).toBeUndefined();
            expect(ring.get(t2.cycleId)).toBeDefined();
        });
    });

    describe('Byte Limit and Sanitization Controls', () => {
        it('strictly caps trace payload size below maxTraceBytes', () => {
            const maxTraceBytes = 3000;
            const ring = new TraceRingBuffer(5, {
                maxTraceBytes,
                maxAttributeValueLength: 50,
                maxEventsPerSpan: 3
            });

            // Put massive trace payloads
            for (let i = 0; i < 20; i++) {
                // Generate massive strings up to 50KB to force truncation and compaction
                const hugeTrace = generateRandomTrace(5, {
                    maxAttrLength: 50000,
                    eventsCount: 15,
                    depth: 4
                });

                ring.put(hugeTrace);
                const stored = ring.get(hugeTrace.cycleId);
                expect(stored).toBeDefined();

                // Serialize and measure byte length
                const serialized = JSON.stringify(stored);
                const byteLen = Buffer.byteLength(serialized, 'utf8');

                expect(byteLen).toBeLessThanOrEqual(maxTraceBytes);
            }
        });

        it('correctly handles circular references in attributes without crashing', () => {
            const ring = new TraceRingBuffer(2);
            const trace = generateRandomTrace(1, { maxAttrLength: 10, eventsCount: 0, depth: 0 });
            
            // Inject circular references
            const circularObj: any = { name: 'circular' };
            circularObj.self = circularObj;
            trace.spans[0].attributes['circular'] = circularObj;

            expect(() => ring.put(trace)).not.toThrow();
            const stored = ring.get(trace.cycleId);
            expect(stored).toBeDefined();
            expect(stored!.spans[0].attributes['circular']).toBeDefined();
            expect(JSON.stringify(stored)).toContain('[circular]');
        });

        it('clears all spans if even a single span cannot fit within maxTraceBytes', () => {
            const maxTraceBytes = 1024; // minimum allowed budget
            const ring = new TraceRingBuffer(2, {
                maxTraceBytes,
                maxAttributeValueLength: 1200,
            });

            // Single span with a giant reserved attribute that cannot be compacted away
            const massiveTrace = generateRandomTrace(1, {
                maxAttrLength: 10,
                eventsCount: 0,
                depth: 0
            });
            
            // Set a giant agent.id that survives compaction
            massiveTrace.spans[0].attributes['kovael.agent.id'] = 'a'.repeat(1500);

            ring.put(massiveTrace);
            const stored = ring.get(massiveTrace.cycleId);
            expect(stored).toBeDefined();
            expect(stored!.spans.length).toBe(0); // must clear all spans entirely to protect memory
        });
    });

    describe('Reference-Severing and Memory Integrity', () => {
        it('severs all internal references on eviction to prevent leaks', () => {
            const capacity = 5;
            const ring = new TraceRingBuffer(capacity);
            
            const ids: string[] = [];
            const traces: CycleTrace[] = [];

            for (let i = 0; i < 15; i++) {
                const t = generateRandomTrace(2, { maxAttrLength: 10, eventsCount: 1, depth: 1 });
                ids.push(t.cycleId);
                traces.push(t);
                ring.put(t);
            }

            // The first 10 should be evicted
            const evictedIds = ids.slice(0, 10);
            const remainingIds = ids.slice(10);

            // Assert they are completely gone from all lookups
            for (const evictedId of evictedIds) {
                expect(ring.get(evictedId)).toBeUndefined();
            }

            // Assert only remaining ones are present
            for (const remId of remainingIds) {
                expect(ring.get(remId)).toBeDefined();
            }

            // Get internal structures to verify no hidden references survive
            const internalMap = (ring as any).byCycle as Map<string, CycleTrace>;
            const internalOrder = (ring as any).order as string[];

            expect(internalMap.size).toBe(capacity);
            expect(internalOrder.length).toBe(capacity);

            // Ensure no evicted keys linger in the keys/values of the internal Map
            for (const evictedId of evictedIds) {
                expect(internalMap.has(evictedId)).toBe(false);
                expect(internalOrder.includes(evictedId)).toBe(false);
            }
        });

        it('retains memory stability under a heavy fuzzed insertion load (No Memory Leaks)', () => {
            const capacity = 10;
            const ring = new TraceRingBuffer(capacity, {
                maxTraceBytes: 4096,
                maxAttributeValueLength: 128,
                maxEventsPerSpan: 5
            });

            // Sustained high-load fuzzing insertion
            // Put 2000 large nested traces rapidly and ensure the size never deviates and no errors occur
            for (let i = 0; i < 2000; i++) {
                const heavyFuzzTrace = generateRandomTrace(
                    Math.floor(Math.random() * 5) + 1, // 1 to 5 spans
                    {
                        maxAttrLength: Math.floor(Math.random() * 1000) + 100, // heavy values
                        eventsCount: Math.floor(Math.random() * 10),
                        depth: Math.floor(Math.random() * 3) + 1
                    }
                );
                
                ring.put(heavyFuzzTrace);
            }

            expect(ring.size()).toBe(capacity);
            expect(ring.stats().inserted).toBe(2000);
            expect(ring.stats().evicted).toBe(2000 - capacity);

            // Verify the retained elements are well-formed and fully compliant
            const listed = ring.list(capacity);
            expect(listed.length).toBe(capacity);
            for (const stored of listed) {
                expect(stored.cycleId).toBeDefined();
                expect(stored.spans).toBeDefined();
                const byteLen = Buffer.byteLength(JSON.stringify(stored), 'utf8');
                expect(byteLen).toBeLessThanOrEqual(4096);
            }
        });
    });
});
