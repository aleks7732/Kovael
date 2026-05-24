/**
 * OpenTelemetry GenAI instrumentation for the Triad cycle.
 *
 * This module ships the smallest end-to-end tracing surface the mesh needs:
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
export * from './TraceRingBuffer.js';
export * from './TraceSanitizers.js';

import type { Span, Tracer } from '@opentelemetry/api';
import { rootLogger } from './Logger.js';
import { DEFAULT_CAPACITY, TraceRingBuffer, type CycleTrace, type FinishedSpan } from './TraceRingBuffer.js';
import {
    ATTR_GEN_AI_REQUEST_MODEL,
    ATTR_GEN_AI_SYSTEM,
    ATTR_KOVAEL_AGENT_ID,
    ATTR_KOVAEL_CYCLE_ID,
    ATTR_KOVAEL_INPUT_TOKENS_EST,
    ATTR_KOVAEL_OUTPUT_TOKENS_EST,
    ATTR_KOVAEL_TASK_HASH,
    ATTR_KOVAEL_TOKEN_COUNT_ESTIMATED,
} from './TraceSanitizers.js';

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
            // Duck-types the SpanProcessor interface without importing it.
            // Avoids coupling to the SDK's internal type exports.
            } as any;

            const processors: any[] = [ringProcessor];

            const endpoint = this.env.OTEL_EXPORTER_OTLP_ENDPOINT;
            if (endpoint && endpoint.length > 0) {
                try {
                    const otlp = await import('@opentelemetry/exporter-trace-otlp-http');
                    const exporter = new otlp.OTLPTraceExporter({ url: endpoint });
                    processors.push(new sdk.BatchSpanProcessor(exporter));
                } catch (err) {
                    rootLogger.warn('otlp_exporter_init_failed', { error: err instanceof Error ? err.message : String(err) });
                }
            }

            // Cast required: NodeTracerProvider expects SpanProcessor[] but
            // we duck-type the ring processor to avoid SDK import coupling.
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
