#!/usr/bin/env node
/**
 * Per-endpoint latency baseline for the Mesh orchestrator.
 *
 * Methodology
 *   - Boot a real MeshOrchestrator on an ephemeral port (same pattern as
 *     scripts/validate-all-chairs.mjs). No mocks. Real loopback HTTP.
 *   - For every hot endpoint, run 100 warmup requests (discarded) then
 *     1000 measured requests sequentially. No concurrency: we are
 *     characterizing per-request latency, not server throughput under
 *     load. Throughput is reported as the reciprocal of mean latency.
 *   - Timings come from performance.now(); arrays are sorted to compute
 *     p50/p95/p99/max plus mean.
 *   - Results print as a markdown table to stdout and are written to
 *     docs/perf/baseline-<ISO date>.md.
 *   - Each measured endpoint is compared against the SLOs in
 *     docs/perf/SLOs.md. If any p99 misses, the script exits 1 so CI
 *     can wire this script as a gate.
 *
 * Usage:
 *   npm run build && node scripts/perf.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { MeshOrchestrator } from '../dist/MeshOrchestrator.js';
import { AgentCards } from '../dist/AgentCards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const WARMUP = 100;
const ITERATIONS = 1000;

// p99 budgets, in milliseconds. Keep in sync with docs/perf/SLOs.md.
const SLO_P99_MS = {
    '/livez': 5,
    '/api/v1/state': 50,
    '/api/v1/chairs/heartbeat': 20,
    '/metrics': 10,
    '/api/v1/chairs/claim': 30,
};

function quantile(sortedAsc, q) {
    if (sortedAsc.length === 0) return 0;
    const idx = Math.min(sortedAsc.length - 1, Math.ceil(q * sortedAsc.length) - 1);
    return sortedAsc[Math.max(0, idx)];
}

function summarize(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    return {
        n: sorted.length,
        mean,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        p99: quantile(sorted, 0.99),
        max: sorted[sorted.length - 1],
        throughputRps: 1000 / mean,
    };
}

function fmt(ms) {
    if (ms >= 100) return ms.toFixed(1);
    if (ms >= 10) return ms.toFixed(2);
    return ms.toFixed(3);
}

async function runScenario(name, request) {
    for (let i = 0; i < WARMUP; i++) await request();
    const samples = new Array(ITERATIONS);
    for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        await request();
        samples[i] = performance.now() - t0;
    }
    return { name, ...summarize(samples) };
}

function renderTable(rows) {
    const head = '| endpoint | n | mean (ms) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | rps (1/mean) | SLO p99 (ms) | verdict |';
    const sep = '|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|';
    const body = rows.map((r) => {
        const slo = SLO_P99_MS[r.name];
        const pass = slo === undefined || r.p99 <= slo;
        return `| \`${r.name}\` | ${r.n} | ${fmt(r.mean)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${r.throughputRps.toFixed(0)} | ${slo ?? '—'} | ${pass ? 'PASS' : 'FAIL'} |`;
    });
    return [head, sep, ...body].join('\n');
}

async function ensureClaim(port) {
    const agentId = Object.keys(AgentCards)[0];
    const card = AgentCards[agentId];
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/chairs/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            agentId,
            provider: card.provider,
            capabilities: card.mcp_capabilities ?? [],
            trustTier: card.trust_tier,
            note: 'perf-baseline',
        }),
    });
    const body = await res.json();
    return { agentId, sessionId: body.sessionId };
}

let exitCode = 0;
let orchestrator = null;
try {
    orchestrator = new MeshOrchestrator(0);
    const port = await orchestrator.ready();
    process.stdout.write(`[perf] orchestrator listening on :${port}\n`);

    const base = `http://127.0.0.1:${port}`;
    const heartbeatSession = await ensureClaim(port);

    const scenarios = [
        {
            name: '/livez',
            request: async () => {
                const r = await fetch(`${base}/livez`);
                await r.arrayBuffer();
            },
        },
        {
            name: '/metrics',
            request: async () => {
                const r = await fetch(`${base}/metrics`);
                await r.arrayBuffer();
            },
        },
        {
            name: '/api/v1/state',
            request: async () => {
                const r = await fetch(`${base}/api/v1/state`);
                await r.arrayBuffer();
            },
        },
        {
            name: '/api/v1/chairs/claim',
            request: async () => {
                const agentId = Object.keys(AgentCards)[0];
                const card = AgentCards[agentId];
                const r = await fetch(`${base}/api/v1/chairs/claim`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        agentId,
                        provider: card.provider,
                        capabilities: card.mcp_capabilities ?? [],
                        trustTier: card.trust_tier,
                        note: 'perf-baseline-claim',
                    }),
                });
                await r.arrayBuffer();
            },
        },
        {
            name: '/api/v1/chairs/heartbeat',
            request: async () => {
                const r = await fetch(`${base}/api/v1/chairs/heartbeat`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        agentId: heartbeatSession.agentId,
                        sessionId: heartbeatSession.sessionId,
                    }),
                });
                await r.arrayBuffer();
            },
        },
    ];

    const results = [];
    for (const s of scenarios) {
        process.stdout.write(`[perf] scenario ${s.name} — warmup ${WARMUP}, measure ${ITERATIONS}\n`);
        const r = await runScenario(s.name, s.request);
        results.push(r);

        if (s.name === '/api/v1/chairs/claim') {
            const refreshed = await ensureClaim(port);
            heartbeatSession.agentId = refreshed.agentId;
            heartbeatSession.sessionId = refreshed.sessionId;
        }
    }

    const table = renderTable(results);
    process.stdout.write('\n' + table + '\n');

    const failures = results.filter((r) => SLO_P99_MS[r.name] !== undefined && r.p99 > SLO_P99_MS[r.name]);
    if (failures.length > 0) {
        process.stdout.write(`\n[perf] SLO FAIL on: ${failures.map((f) => f.name).join(', ')}\n`);
        exitCode = 1;
    } else {
        process.stdout.write('\n[perf] all SLOs met\n');
    }

    const dateIso = new Date().toISOString().slice(0, 10);
    const outDir = path.join(REPO_ROOT, 'docs', 'perf');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `baseline-${dateIso}.md`);
    const node = process.version;
    const meta = [
        `# Orchestrator latency baseline — ${dateIso}`,
        '',
        `- Harness: \`scripts/perf.mjs\` (warmup ${WARMUP}, measure ${ITERATIONS}, sequential)`,
        `- Node: ${node}`,
        `- Platform: ${process.platform} ${process.arch}`,
        `- Orchestrator commit: ${process.env.GIT_SHA ?? 'see git log'}`,
        '',
        '## Results',
        '',
        table,
        '',
        '## Verdict',
        '',
        failures.length === 0
            ? 'All measured p99s within SLO.'
            : `SLO miss on: ${failures.map((f) => `\`${f.name}\` (p99 ${fmt(f.p99)} ms vs budget ${SLO_P99_MS[f.name]} ms)`).join(', ')}.`,
        '',
    ].join('\n');
    fs.writeFileSync(outPath, meta);
    process.stdout.write(`[perf] baseline written to ${path.relative(REPO_ROOT, outPath)}\n`);
} catch (err) {
    process.stderr.write(`[perf] threw: ${err && err.stack ? err.stack : err}\n`);
    exitCode = 1;
} finally {
    if (orchestrator) orchestrator.close();
    await sleep(50);
    process.exit(exitCode);
}
