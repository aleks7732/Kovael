import { describe, it, expect } from 'vitest';
import {
    renderTraceFlowchartHtml,
    renderTraceFlowchartSvg,
} from '../services/TraceComfyBridge.js';
import type { CycleTrace, FinishedSpan } from '../services/Tracing.js';

// -------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------

function makeSpan(overrides: Partial<FinishedSpan> = {}): FinishedSpan {
    return {
        traceId: 'trace-001',
        spanId: 'span-001',
        name: 'triad.architect',
        kind: 1,
        startTimeUnixNano: 1_000_000_000,
        endTimeUnixNano: 2_000_000_000,
        durationMs: 1000,
        attributes: {},
        status: { code: 0 },
        events: [],
        ...overrides,
    };
}

function makeTrace(spans: FinishedSpan[] = [], overrides: Partial<CycleTrace> = {}): CycleTrace {
    const rootSpanId = spans[0]?.spanId ?? 'root-span';
    return {
        cycleId: 'cycle-001',
        traceId: 'trace-001',
        rootSpanId,
        startedAt: Date.now() - 2000,
        endedAt: Date.now(),
        spans,
        ...overrides,
    };
}

// -------------------------------------------------------------------------
// renderTraceFlowchartSvg
// -------------------------------------------------------------------------

describe('renderTraceFlowchartSvg', () => {
    it('returns a string starting with <svg and ending with </svg>', () => {
        const svg = renderTraceFlowchartSvg(makeTrace());
        expect(svg.trimStart()).toMatch(/^<svg /);
        expect(svg.trimEnd()).toMatch(/<\/svg>$/);
    });

    it('includes valid SVG namespace attribute', () => {
        const svg = renderTraceFlowchartSvg(makeTrace());
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    });

    it('includes aria-label referencing the cycleId', () => {
        const svg = renderTraceFlowchartSvg(makeTrace([], { cycleId: 'my-cycle' }));
        expect(svg).toContain('my-cycle');
    });

    it('shows "no agent turns" summary when spans have no agent attribute', () => {
        const svg = renderTraceFlowchartSvg(makeTrace([makeSpan()]));
        expect(svg).toContain('no agent turns');
    });

    it('aggregates agent turn counts in the title', () => {
        const ATTR = 'kovael.agent.id';
        const spans = [
            makeSpan({ spanId: 's1', attributes: { [ATTR]: 'nyx-cli' } }),
            makeSpan({ spanId: 's2', attributes: { [ATTR]: 'nyx-cli' } }),
            makeSpan({ spanId: 's3', attributes: { [ATTR]: 'shaev' } }),
        ];
        const svg = renderTraceFlowchartSvg(makeTrace(spans));
        // Both agents and their counts should appear in the title summary
        expect(svg).toContain('nyx-cli: 2');
        expect(svg).toContain('shaev: 1');
    });

    it('height grows with the number of spans', () => {
        const few = renderTraceFlowchartSvg(makeTrace([makeSpan()]));
        const many = renderTraceFlowchartSvg(
            makeTrace(Array.from({ length: 10 }, (_, i) => makeSpan({ spanId: `s${i}` }))),
        );
        const extractHeight = (svg: string) =>
            Number(svg.match(/height="(\d+)"/)?.[1]);

        expect(extractHeight(many)).toBeGreaterThan(extractHeight(few));
    });

    it('marks the root span with the "root" CSS class', () => {
        const root = makeSpan({ spanId: 'root-1' });
        const child = makeSpan({ spanId: 'child-1' });
        const trace = makeTrace([root, child], { rootSpanId: 'root-1' });
        const svg = renderTraceFlowchartSvg(trace);
        expect(svg).toContain('node root');
    });

    it('HTML-escapes span names containing special characters', () => {
        const span = makeSpan({ name: '<script>alert("xss")</script>' });
        const svg = renderTraceFlowchartSvg(makeTrace([span]));
        expect(svg).not.toContain('<script>');
        expect(svg).toContain('&lt;script&gt;');
    });

    it('handles an empty spans array without throwing', () => {
        expect(() => renderTraceFlowchartSvg(makeTrace([]))).not.toThrow();
    });

    it('renders confidence as a percentage when attribute is present', () => {
        const CONF_ATTR = 'kovael.verifier.confidence';
        const span = makeSpan({ attributes: { [CONF_ATTR]: 0.87 } });
        const svg = renderTraceFlowchartSvg(makeTrace([span]));
        expect(svg).toContain('87%');
    });

    it('renders "confidence: n/a" when confidence attribute is absent', () => {
        const svg = renderTraceFlowchartSvg(makeTrace([makeSpan()]));
        // The SVG renderer HTML-escapes '/' as '&#x2F;' in attribute/text content.
        expect(svg).toMatch(/confidence: n(?:\/|&#x2F;)a/);
    });

    it('truncates tooltips longer than 512 chars', () => {
        const longName = 'x'.repeat(600);
        const span = makeSpan({ name: longName });
        const svg = renderTraceFlowchartSvg(makeTrace([span]));
        // The tooltip <title> element should not contain the full 600-char name
        // (it gets truncated at 512 with "...")
        expect(svg).toContain('...');
    });
});

// -------------------------------------------------------------------------
// renderTraceFlowchartHtml
// -------------------------------------------------------------------------

describe('renderTraceFlowchartHtml', () => {
    it('wraps the SVG in a div with class kovael-trace-flowchart', () => {
        const html = renderTraceFlowchartHtml(makeTrace());
        expect(html).toMatch(/^<div class="kovael-trace-flowchart">/);
        expect(html).toMatch(/<\/div>$/);
    });

    it('contains the SVG produced by renderTraceFlowchartSvg', () => {
        const trace = makeTrace([makeSpan()]);
        const svg = renderTraceFlowchartSvg(trace);
        const html = renderTraceFlowchartHtml(trace);
        expect(html).toContain(svg);
    });
});
