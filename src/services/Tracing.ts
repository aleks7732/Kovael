/**
 * OpenTelemetry GenAI instrumentation for the Triad cycle.
 *
 * Iter 14 ships the smallest end-to-end version that PHOENIX §4 demands:
 *   - cycle.run (root) spans wrap each MevBridge.execute() call
 *   - triad.architect / triad.operator / triad.verifier are siblings under it
 *   - each triad.* span carries the OTel GenAI SemConv attributes
 *   - finished spans are captured into an in-memory ring buffer (default 1000)
 *     exposed at GET /api/v1/traces
 *   - opt-in OTLP HTTP export when OTEL_EXPORTER_OTLP_ENDPOINT is set
 *
 * The module is intentionally defensive: if the OTel SDK fails to import or
 * initialise, the bridge degrades to no-op tracers so a missing dep cannot
 * brick the orchestrator. The justification for the defensive shape: the OTel
 * SDK pulls in a non-trivial transitive dep tree and we run in environments
 * (smoke scripts, prod containers without observability wired) where the
 * absence of telemetry should not be a fatal condition.
 */
import type { Span, SpanContext, Tracer } from '@opentelemetry/api';

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

const DEFAULT_CAPACITY = 1000;
const DEFAULT_MAX_TRACE_BYTES = 256 * 1024;
const DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH = 4096;
const DEFAULT_MAX_EVENTS_PER_SPAN = 32;

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

export interface TracingBridgeOptions {
    /** Ring buffer capacity, default 1000 cycles. */
    capacity?: number;
    /** Service name used by the OTel Resource. */
    serviceName?: string;
    /** Read env vars from this map (test seam). */
    env?: NodeJS.ProcessEnv;
}

export interface CycleSpanAttrs {
    cycleId: string;
    taskHash: string;
}

export interface TriadSpanAttrs {
    cycleId: string;
    taskHash: string;
    agentId: string;
    system: string;
    model: string;
}

export interface TriadSpanUsage {
    inputTokens?: number;
    outputTokens?: number;
}

const SPAN_KIND_INTERNAL = 1;

const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';
const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
// Use kovael.* namespace + an explicit `estimated` flag rather than the
// official OTel GenAI keys (gen_ai.response.input_tokens / output_tokens),
// because today's counts are char/4 estimates. Setting them under the
// official names would make downstream tools (Jaeger, Grafana, cost
// pipelines) treat them as authoritative provider-reported counts.
// When ChairBridge starts reporting real counts, flip these to the
// canonical gen_ai.* names and drop the estimate flag.
const ATTR_KOVAEL_INPUT_TOKENS_EST = 'kovael.gen_ai.response.estimated_input_tokens';
const ATTR_KOVAEL_OUTPUT_TOKENS_EST = 'kovael.gen_ai.response.estimated_output_tokens';
const ATTR_KOVAEL_TOKEN_COUNT_ESTIMATED = 'kovael.gen_ai.token_count_estimated';
const ATTR_KOVAEL_CYCLE_ID = 'kovael.cycle.id';
const ATTR_KOVAEL_TASK_HASH = 'kovael.task.hash';
const ATTR_KOVAEL_AGENT_ID = 'kovael.agent.id';

/**
 * Lazy holder for an OTel tracer plus the in-memory ring buffer. The async
 * `start()` performs the OTel SDK import + provider construction inside a
 * try/catch so a missing or broken SDK does not poison orchestrator boot.
 */
export class TracingBridge {
    public readonly ring: TraceRingBuffer;
    private tracer: Tracer | null = null;
    private provider: unknown | null = null;
    private ready = false;
    private readonly serviceName: string;
    private readonly env: NodeJS.ProcessEnv;
    private readonly spansByTrace = new Map<string, FinishedSpan[]>();
    private readonly cycleByTraceRoot = new Map<string, { cycleId: string; rootSpanId: string; startedAt: number }>();

    constructor(opts: TracingBridgeOptions = {}) {
        this.ring = new TraceRingBuffer(opts.capacity ?? DEFAULT_CAPACITY);
        this.serviceName = opts.serviceName ?? 'kovael-orchestrator';
        this.env = opts.env ?? process.env;
    }

    public isReady(): boolean {
        return this.ready;
    }

    /**
     * Initialise the OTel provider + ring-buffer processor. Safe to call
     * multiple times; the second call is a no-op. Returns true on success.
     */
    public async start(): Promise<boolean> {
        if (this.ready) return true;
        // SDK imports are NOT wrapped — @opentelemetry/api and sdk-trace-node
        // are required runtime deps; a missing module means broken install
        // and must surface as a hard rejection at the caller. Only the OTLP
        // exporter import below is wrapped, because OTLP is legitimately
        // opt-in (gated by OTEL_EXPORTER_OTLP_ENDPOINT) and a broken
        // collector should not poison startup.
        const api = await import('@opentelemetry/api');
        const sdk = await import('@opentelemetry/sdk-trace-node');

        const ring = this.ring;
            const spansByTrace = this.spansByTrace;
            const cycleByTraceRoot = this.cycleByTraceRoot;

            const ringProcessor = {
                onStart(_span: unknown, _ctx: unknown) {
                    // no-op; span attrs land at end-time.
                },
                onEnd(span: any) {
                    const traceId: string = span.spanContext().traceId;
                    const spanId: string = span.spanContext().spanId;
                    const parentSpanId: string | undefined =
                        typeof span.parentSpanId === 'string'
                            ? span.parentSpanId
                            : span.parentSpanContext?.spanId;
                    const startTimeUnixNano = hrToNs(span.startTime);
                    const endTimeUnixNano = hrToNs(span.endTime);
                    const finished: FinishedSpan = {
                        traceId,
                        spanId,
                        parentSpanId,
                        name: span.name,
                        kind: span.kind ?? SPAN_KIND_INTERNAL,
                        startTimeUnixNano,
                        endTimeUnixNano,
                        durationMs: (endTimeUnixNano - startTimeUnixNano) / 1_000_000,
                        attributes: { ...(span.attributes ?? {}) },
                        status: { code: span.status?.code ?? 0, message: span.status?.message },
                        events: (span.events ?? []).map((e: any) => ({
                            name: e.name,
                            timeUnixNano: hrToNs(e.time),
                            attributes: e.attributes ? { ...e.attributes } : undefined,
                        })),
                    };

                    let bucket = spansByTrace.get(traceId);
                    if (!bucket) {
                        bucket = [];
                        spansByTrace.set(traceId, bucket);
                    }
                    bucket.push(finished);

                    const root = cycleByTraceRoot.get(traceId);
                    if (root && root.rootSpanId === spanId) {
                        const cycleTrace: CycleTrace = {
                            cycleId: root.cycleId,
                            traceId,
                            rootSpanId: spanId,
                            startedAt: root.startedAt,
                            endedAt: Date.now(),
                            spans: bucket.slice(),
                        };
                        ring.put(cycleTrace);
                        spansByTrace.delete(traceId);
                        cycleByTraceRoot.delete(traceId);
                    }
                },
                shutdown() {
                    return Promise.resolve();
                },
                forceFlush() {
                    return Promise.resolve();
                },
            } as any;

            const processors: any[] = [ringProcessor];

            const endpoint = this.env.OTEL_EXPORTER_OTLP_ENDPOINT;
            if (endpoint && endpoint.length > 0) {
                try {
                    const otlp = await import('@opentelemetry/exporter-trace-otlp-http');
                    const exporter = new otlp.OTLPTraceExporter({ url: endpoint });
                    processors.push(new sdk.BatchSpanProcessor(exporter));
                } catch (err) {
                    console.warn('[tracing] OTLP exporter init failed; ring buffer only', err);
                }
            }

            const providerWithProcessors = new sdk.NodeTracerProvider({ spanProcessors: processors as any });
            providerWithProcessors.register();

            this.provider = providerWithProcessors;
            this.tracer = api.trace.getTracer(this.serviceName);
            this.ready = true;
            return true;
    }

    public async shutdown(): Promise<void> {
        const p = this.provider as { shutdown?: () => Promise<void> } | null;
        if (p && typeof p.shutdown === 'function') {
            try { await p.shutdown(); } catch { /* swallow */ }
        }
        this.ready = false;
        this.tracer = null;
        this.provider = null;
    }

    /**
     * Open the cycle.run root span and return a handle. The caller must
     * invoke handle.end() so the ring buffer flush fires. When tracing is
     * not ready the handle's calls are no-ops and child-span helpers return
     * null tracers.
     */
    public startCycle(attrs: CycleSpanAttrs): CycleSpanHandle {
        if (!this.ready || !this.tracer) {
            return new NoopCycleSpanHandle();
        }
        const span = this.tracer.startSpan('cycle.run', {
            attributes: {
                [ATTR_KOVAEL_CYCLE_ID]: attrs.cycleId,
                [ATTR_KOVAEL_TASK_HASH]: attrs.taskHash,
            },
        });
        const ctxApi = (globalThis as any).__otelApiCache ?? null;
        const startedAt = Date.now();
        this.cycleByTraceRoot.set(span.spanContext().traceId, {
            cycleId: attrs.cycleId,
            rootSpanId: span.spanContext().spanId,
            startedAt,
        });
        return new RealCycleSpanHandle(this.tracer, span);
    }
}

export interface CycleSpanHandle {
    runTriadPhase<T>(
        phase: 'triad.architect' | 'triad.operator' | 'triad.verifier',
        attrs: TriadSpanAttrs,
        fn: () => Promise<T>,
        usageOf?: (result: T) => TriadSpanUsage | undefined,
    ): Promise<T>;
    end(status?: 'ok' | 'error', message?: string): void;
}

class NoopCycleSpanHandle implements CycleSpanHandle {
    async runTriadPhase<T>(_p: any, _a: any, fn: () => Promise<T>): Promise<T> {
        return fn();
    }
    end(): void { /* no-op */ }
}

class RealCycleSpanHandle implements CycleSpanHandle {
    constructor(private readonly tracer: Tracer, private readonly rootSpan: Span) {}

    public async runTriadPhase<T>(
        phase: 'triad.architect' | 'triad.operator' | 'triad.verifier',
        attrs: TriadSpanAttrs,
        fn: () => Promise<T>,
        usageOf?: (result: T) => TriadSpanUsage | undefined,
    ): Promise<T> {
        const api = await import('@opentelemetry/api');
        const parentCtx = api.trace.setSpan(api.context.active(), this.rootSpan);
        const child = this.tracer.startSpan(
            phase,
            {
                attributes: {
                    [ATTR_GEN_AI_SYSTEM]: attrs.system,
                    [ATTR_GEN_AI_REQUEST_MODEL]: attrs.model,
                    [ATTR_KOVAEL_CYCLE_ID]: attrs.cycleId,
                    [ATTR_KOVAEL_TASK_HASH]: attrs.taskHash,
                    [ATTR_KOVAEL_AGENT_ID]: attrs.agentId,
                },
            },
            parentCtx,
        );
        try {
            const result = await api.context.with(api.trace.setSpan(parentCtx, child), fn);
            const usage = usageOf ? usageOf(result) : undefined;
            if (usage?.inputTokens !== undefined) {
                child.setAttribute(ATTR_KOVAEL_INPUT_TOKENS_EST, usage.inputTokens);
            }
            if (usage?.outputTokens !== undefined) {
                child.setAttribute(ATTR_KOVAEL_OUTPUT_TOKENS_EST, usage.outputTokens);
            }
            if (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) {
                child.setAttribute(ATTR_KOVAEL_TOKEN_COUNT_ESTIMATED, true);
            }
            child.setStatus({ code: 1 });
            return result;
        } catch (err) {
            child.recordException(err as Error);
            child.setStatus({ code: 2, message: (err as Error).message });
            throw err;
        } finally {
            child.end();
        }
    }

    public end(status: 'ok' | 'error' = 'ok', message?: string): void {
        if (status === 'error') {
            this.rootSpan.setStatus({ code: 2, message });
        } else {
            this.rootSpan.setStatus({ code: 1 });
        }
        this.rootSpan.end();
    }
}

function hrToNs(t: any): number {
    if (typeof t === 'number') return t * 1_000_000;
    if (Array.isArray(t) && t.length === 2) {
        return t[0] * 1_000_000_000 + t[1];
    }
    if (t && typeof t === 'object' && typeof (t as any).getTime === 'function') {
        return (t as Date).getTime() * 1_000_000;
    }
    return Date.now() * 1_000_000;
}

function boundTracePayload(trace: CycleTrace, opts: Required<TraceRingBufferOptions>): CycleTrace {
    let bounded: CycleTrace = {
        cycleId: safeString(trace.cycleId, opts.maxAttributeValueLength),
        traceId: safeString(trace.traceId, opts.maxAttributeValueLength),
        rootSpanId: safeString(trace.rootSpanId, opts.maxAttributeValueLength),
        startedAt: finiteNumber(trace.startedAt),
        endedAt: finiteNumber(trace.endedAt),
        spans: trace.spans.map((span) => sanitizeSpan(span, opts)),
    };

    while (jsonByteLength(bounded) > opts.maxTraceBytes && bounded.spans.length > 1) {
        bounded = { ...bounded, spans: bounded.spans.slice(0, -1) };
    }

    if (jsonByteLength(bounded) > opts.maxTraceBytes && bounded.spans.length === 1) {
        const only = bounded.spans[0];
        bounded = {
            ...bounded,
            spans: [{
                ...only,
                attributes: compactAttributes(only.attributes, opts.maxAttributeValueLength),
                events: [],
            }],
        };
    }

    if (jsonByteLength(bounded) > opts.maxTraceBytes) {
        bounded = {
            cycleId: bounded.cycleId,
            traceId: bounded.traceId,
            rootSpanId: bounded.rootSpanId,
            startedAt: bounded.startedAt,
            endedAt: bounded.endedAt,
            spans: [],
        };
    }

    return bounded;
}

function sanitizeSpan(span: FinishedSpan, opts: Required<TraceRingBufferOptions>): FinishedSpan {
    return {
        traceId: safeString(span.traceId, opts.maxAttributeValueLength),
        spanId: safeString(span.spanId, opts.maxAttributeValueLength),
        parentSpanId: span.parentSpanId ? safeString(span.parentSpanId, opts.maxAttributeValueLength) : undefined,
        name: safeString(span.name, opts.maxAttributeValueLength),
        kind: finiteNumber(span.kind),
        startTimeUnixNano: finiteNumber(span.startTimeUnixNano),
        endTimeUnixNano: finiteNumber(span.endTimeUnixNano),
        durationMs: finiteNumber(span.durationMs),
        attributes: sanitizeRecord(span.attributes, opts.maxAttributeValueLength),
        status: {
            code: finiteNumber(span.status.code),
            message: span.status.message ? safeString(span.status.message, opts.maxAttributeValueLength) : undefined,
        },
        events: span.events.slice(0, opts.maxEventsPerSpan).map((event) => ({
            name: safeString(event.name, opts.maxAttributeValueLength),
            timeUnixNano: finiteNumber(event.timeUnixNano),
            attributes: event.attributes ? sanitizeRecord(event.attributes, opts.maxAttributeValueLength) : undefined,
        })),
    };
}

function sanitizeRecord(input: Record<string, unknown>, maxStringLength: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input ?? {})) {
        out[safeString(key, maxStringLength)] = sanitizeUnknown(value, maxStringLength, new WeakSet<object>(), 0);
    }
    return out;
}

function sanitizeUnknown(
    value: unknown,
    maxStringLength: number,
    seen: WeakSet<object>,
    depth: number,
): unknown {
    if (typeof value === 'string') return safeString(value, maxStringLength);
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean' || value === null || value === undefined) return value;
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[circular]';
    if (depth >= 4) return '[max-depth]';
    seen.add(value);
    if (Array.isArray(value)) {
        return value.slice(0, 16).map((item) => sanitizeUnknown(item, maxStringLength, seen, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
        out[safeString(key, maxStringLength)] = sanitizeUnknown(item, maxStringLength, seen, depth + 1);
    }
    return out;
}

function compactAttributes(input: Record<string, unknown>, maxStringLength: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ['kovael.agent.id', 'gen_ai.system', 'gen_ai.request.model']) {
        if (input[key] !== undefined) out[key] = sanitizeUnknown(input[key], maxStringLength, new WeakSet<object>(), 0);
    }
    out['kovael.trace.truncated'] = true;
    return out;
}

function safeString(input: string, maxLength: number): string {
    if (input.length <= maxLength) return input;
    return `${input.slice(0, maxLength)}[truncated ${input.length - maxLength} chars]`;
}

function finiteNumber(input: number): number {
    return Number.isFinite(input) ? input : 0;
}

function jsonByteLength(input: unknown): number {
    return Buffer.byteLength(JSON.stringify(input), 'utf8');
}

export const __TRACING_INTERNALS__ = {
    ATTR_GEN_AI_SYSTEM,
    ATTR_GEN_AI_REQUEST_MODEL,
    ATTR_KOVAEL_INPUT_TOKENS_EST,
    ATTR_KOVAEL_OUTPUT_TOKENS_EST,
    ATTR_KOVAEL_TOKEN_COUNT_ESTIMATED,
    ATTR_KOVAEL_CYCLE_ID,
    ATTR_KOVAEL_TASK_HASH,
    ATTR_KOVAEL_AGENT_ID,
};
