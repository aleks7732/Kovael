import type { CycleTrace, FinishedSpan } from './Tracing.js';

const ATTR_AGENT_ID = 'kovael.agent.id';
const ATTR_INPUT_TOKENS = 'kovael.gen_ai.response.estimated_input_tokens';
const ATTR_OUTPUT_TOKENS = 'kovael.gen_ai.response.estimated_output_tokens';
const ATTR_CONFIDENCE = 'kovael.verifier.confidence';

export function renderTraceFlowchartHtml(trace: CycleTrace): string {
    return [
        '<div class="kovael-trace-flowchart">',
        renderTraceFlowchartSvg(trace),
        '</div>',
    ].join('');
}

export function renderTraceFlowchartSvg(trace: CycleTrace): string {
    const spans = trace.spans.length > 0 ? trace.spans : [];
    const rows = spans.map((span, index) => renderSpanRow(trace, span, index)).join('');
    const width = 960;
    const height = Math.max(120, 64 + spans.length * 72);
    const agentTurns = countAgentTurns(spans);
    const summary = Object.entries(agentTurns)
        .map(([agent, turns]) => `${agent}: ${turns}`)
        .join(', ') || 'no agent turns';

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" role="img" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-label="Trace flowchart for ${escapeHtml(trace.cycleId)}">`,
        `<title>${escapeHtml(`cycle ${trace.cycleId} turns: ${summary}`)}</title>`,
        '<style>.node{fill:#171717;stroke:#d97706;stroke-width:1.5}.root{stroke:#f5f5dc}.label{fill:#f5f5dc;font:600 13px Arial}.meta{fill:#d6d3d1;font:11px Arial}.edge{stroke:#57534e;stroke-width:1.25}</style>',
        `<text x="24" y="28" class="label">${escapeHtml(`cycle ${trace.cycleId}`)}</text>`,
        `<text x="24" y="46" class="meta">${escapeHtml(`trace ${trace.traceId} | turns ${summary}`)}</text>`,
        rows,
        '</svg>',
    ].join('');
}

function renderSpanRow(trace: CycleTrace, span: FinishedSpan, index: number): string {
    const x = 48 + Math.min(index, 5) * 24;
    const y = 72 + index * 72;
    const width = 760;
    const height = 48;
    const agent = readStringAttr(span, ATTR_AGENT_ID) ?? 'system';
    const activeMs = Math.max(0, Math.round(span.durationMs));
    const input = readNumberAttr(span, ATTR_INPUT_TOKENS);
    const output = readNumberAttr(span, ATTR_OUTPUT_TOKENS);
    const confidence = readNumberAttr(span, ATTR_CONFIDENCE);
    const confidenceText = confidence === undefined ? 'confidence: n/a' : `confidence: ${Math.round(confidence * 100)}%`;
    const tooltip = truncateTooltip([
        span.name,
        `agent: ${agent}`,
        `input: ${input ?? 0}`,
        `output: ${output ?? 0}`,
        confidenceText,
        `active: ${activeMs}ms`,
    ].join(' | '));
    const edge = index === 0
        ? ''
        : `<path class="edge" d="M${x - 20} ${y - 48} L${x - 20} ${y - 8} L${x} ${y - 8}" fill="none"/>`;
    const klass = span.spanId === trace.rootSpanId ? 'node root' : 'node';
    return [
        edge,
        `<g tabindex="0">`,
        `<title>${escapeHtml(tooltip)}</title>`,
        `<rect class="${klass}" x="${x}" y="${y}" width="${width}" height="${height}" rx="8"/>`,
        `<text x="${x + 16}" y="${y + 21}" class="label">${escapeHtml(span.name)}</text>`,
        `<text x="${x + 16}" y="${y + 39}" class="meta">${escapeHtml(`${agent} | input: ${input ?? 0} | output: ${output ?? 0} | ${confidenceText} | active: ${activeMs}ms`)}</text>`,
        '</g>',
    ].join('');
}

function countAgentTurns(spans: FinishedSpan[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const span of spans) {
        const agent = readStringAttr(span, ATTR_AGENT_ID);
        if (!agent) continue;
        counts[agent] = (counts[agent] ?? 0) + 1;
    }
    return counts;
}

function readStringAttr(span: FinishedSpan, key: string): string | undefined {
    const value = span.attributes[key];
    return typeof value === 'string' ? value : undefined;
}

function readNumberAttr(span: FinishedSpan, key: string): number | undefined {
    const value = span.attributes[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateTooltip(value: string): string {
    return value.length <= 512 ? value : `${value.slice(0, 512)}...`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/\//g, '&#x2F;')
        .replace(/`/g, '&#x60;');
}
