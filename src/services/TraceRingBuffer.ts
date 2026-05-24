import { boundTracePayload } from './TraceSanitizers.js';

export interface FinishedSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    startTimeUnixNano: number;
    endTimeUnixNano: number;
    durationMs: number;
    attributes: Record<string, unknown>;
    status: { code: number; message?: string };
    events: Array<{ name: string; timeUnixNano: number; attributes?: Record<string, unknown> }>;
}

export interface CycleTrace {
    cycleId: string;
    traceId: string;
    rootSpanId: string;
    startedAt: number;
    endedAt: number;
    spans: FinishedSpan[];
}

export interface RingBufferStats {
    capacity: number;
    size: number;
    inserted: number;
    evicted: number;
}

export const DEFAULT_CAPACITY = 1000;
export const DEFAULT_MAX_TRACE_BYTES = 256 * 1024;
export const DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH = 4096;
export const DEFAULT_MAX_EVENTS_PER_SPAN = 32;

export interface TraceRingBufferOptions {
    maxTraceBytes?: number;
    maxAttributeValueLength?: number;
    maxEventsPerSpan?: number;
}

/**
 * Per-cycle bounded ring buffer of finished span trees. Indexed by cycleId
 * for O(1) lookup and ordered by insertion for chronological listing.
 */
export class TraceRingBuffer {
    public readonly capacity: number;
    private readonly opts: Required<TraceRingBufferOptions>;
    private readonly order: string[] = [];
    private readonly byCycle = new Map<string, CycleTrace>();
    private insertedCount = 0;
    private evictedCount = 0;

    constructor(capacity: number = DEFAULT_CAPACITY, opts: TraceRingBufferOptions = {}) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new Error(`TraceRingBuffer capacity must be a positive integer (got ${capacity})`);
        }
        const maxTraceBytes = opts.maxTraceBytes ?? DEFAULT_MAX_TRACE_BYTES;
        const maxAttributeValueLength = opts.maxAttributeValueLength ?? DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH;
        const maxEventsPerSpan = opts.maxEventsPerSpan ?? DEFAULT_MAX_EVENTS_PER_SPAN;
        if (!Number.isInteger(maxTraceBytes) || maxTraceBytes < 1024) {
            throw new Error(`TraceRingBuffer maxTraceBytes must be an integer >= 1024 (got ${maxTraceBytes})`);
        }
        if (!Number.isInteger(maxAttributeValueLength) || maxAttributeValueLength < 16) {
            throw new Error(`TraceRingBuffer maxAttributeValueLength must be an integer >= 16 (got ${maxAttributeValueLength})`);
        }
        if (!Number.isInteger(maxEventsPerSpan) || maxEventsPerSpan < 0) {
            throw new Error(`TraceRingBuffer maxEventsPerSpan must be a non-negative integer (got ${maxEventsPerSpan})`);
        }
        this.capacity = capacity;
        this.opts = { maxTraceBytes, maxAttributeValueLength, maxEventsPerSpan };
    }

    public put(trace: CycleTrace): void {
        const bounded = boundTracePayload(trace, this.opts);
        if (this.byCycle.has(trace.cycleId)) {
            this.byCycle.set(trace.cycleId, bounded);
            return;
        }
        this.byCycle.set(trace.cycleId, bounded);
        this.order.push(trace.cycleId);
        this.insertedCount += 1;
        while (this.order.length > this.capacity) {
            const dropped = this.order.shift();
            if (dropped !== undefined) {
                this.byCycle.delete(dropped);
                this.evictedCount += 1;
            }
        }
    }

    public get(cycleId: string): CycleTrace | undefined {
        return this.byCycle.get(cycleId);
    }

    public list(limit: number = 20): CycleTrace[] {
        const slice = this.order.slice(-Math.max(0, limit));
        const out: CycleTrace[] = [];
        for (let i = slice.length - 1; i >= 0; i -= 1) {
            const c = this.byCycle.get(slice[i]);
            if (c) out.push(c);
        }
        return out;
    }

    public trimTo(retained: number): number {
        const limit = Math.max(0, Math.floor(retained));
        let droppedCount = 0;
        while (this.order.length > limit) {
            const dropped = this.order.shift();
            if (dropped !== undefined && this.byCycle.delete(dropped)) {
                this.evictedCount += 1;
                droppedCount += 1;
            }
        }
        return droppedCount;
    }

    public size(): number {
        return this.order.length;
    }

    public stats(): RingBufferStats {
        return {
            capacity: this.capacity,
            size: this.order.length,
            inserted: this.insertedCount,
            evicted: this.evictedCount,
        };
    }
}
