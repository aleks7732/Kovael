import type { CycleTrace, FinishedSpan, TraceRingBufferOptions } from './TraceRingBuffer.js';

export const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
// Use kovael.* namespace + an explicit `estimated` flag rather than the
// official OTel GenAI keys (gen_ai.response.input_tokens / output_tokens),
// because today's counts are char/4 estimates. Setting them under the
// official names would make downstream tools (Jaeger, Grafana, cost
// pipelines) treat them as authoritative provider-reported counts.
// When ChairBridge starts reporting real counts, flip these to the
// canonical gen_ai.* names and drop the estimate flag.
export const ATTR_KOVAEL_INPUT_TOKENS_EST = 'kovael.gen_ai.response.estimated_input_tokens';
export const ATTR_KOVAEL_OUTPUT_TOKENS_EST = 'kovael.gen_ai.response.estimated_output_tokens';
export const ATTR_KOVAEL_TOKEN_COUNT_ESTIMATED = 'kovael.gen_ai.token_count_estimated';
export const ATTR_KOVAEL_CYCLE_ID = 'kovael.cycle.id';
export const ATTR_KOVAEL_TASK_HASH = 'kovael.task.hash';
export const ATTR_KOVAEL_AGENT_ID = 'kovael.agent.id';

export function boundTracePayload(trace: CycleTrace, opts: Required<TraceRingBufferOptions>): CycleTrace {
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

export function sanitizeSpan(span: FinishedSpan, opts: Required<TraceRingBufferOptions>): FinishedSpan {
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

export function sanitizeRecord(input: Record<string, unknown>, maxStringLength: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input ?? {})) {
        out[safeString(key, maxStringLength)] = sanitizeUnknown(value, maxStringLength, new WeakSet<object>(), 0);
    }
    return out;
}

export function sanitizeUnknown(
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

export function compactAttributes(input: Record<string, unknown>, maxStringLength: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ['kovael.agent.id', 'gen_ai.system', 'gen_ai.request.model']) {
        if (input[key] !== undefined) out[key] = sanitizeUnknown(input[key], maxStringLength, new WeakSet<object>(), 0);
    }
    out['kovael.trace.truncated'] = true;
    return out;
}

export function safeString(input: string, maxLength: number): string {
    if (input.length <= maxLength) return input;
    return `${input.slice(0, maxLength)}[truncated ${input.length - maxLength} chars]`;
}

export function finiteNumber(input: number): number {
    return Number.isFinite(input) ? input : 0;
}

export function jsonByteLength(input: unknown): number {
    return Buffer.byteLength(JSON.stringify(input), 'utf8');
}
