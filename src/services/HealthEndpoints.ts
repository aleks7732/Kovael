import type { ServerResponse } from 'node:http';

/**
 * Health and metric endpoints for cloud-native orchestrator deploys.
 *
 * Routes:
 *   GET /livez   → 200 always (process is alive — the event loop ran
 *                  long enough to answer)
 *   GET /readyz  → 200 once setReady() has fired, else 503
 *   GET /metrics → Prometheus text exposition format
 *
 * All three live outside `/api/v1/*` so the bearer-token gate (iter 04)
 * does not apply — Kubernetes probes and Prometheus scrapers don't
 * carry auth headers.
 */

export interface MetricsSnapshot {
    chairsActive: number;
    topicsActive: number;
}

export class HealthEndpoints {
    private ready = false;
    private readonly startedAt = Date.now();

    constructor(private readonly snapshot: () => MetricsSnapshot) {}

    public setReady(): void {
        this.ready = true;
    }

    public livez(res: ServerResponse): void {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime_s: this.uptimeSeconds() }));
    }

    public readyz(res: ServerResponse): void {
        const status = this.ready ? 200 : 503;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: this.ready ? 'ok' : 'pending' }));
    }

    public metrics(res: ServerResponse): void {
        const mem = process.memoryUsage();
        const snap = this.snapshot();
        const body = [
            '# HELP kovael_uptime_seconds Seconds since the orchestrator started.',
            '# TYPE kovael_uptime_seconds counter',
            `kovael_uptime_seconds ${this.uptimeSeconds()}`,
            '# HELP kovael_chairs_active Currently online chairs (healthy heartbeats).',
            '# TYPE kovael_chairs_active gauge',
            `kovael_chairs_active ${snap.chairsActive}`,
            '# HELP kovael_topics_active Currently open conversation topics.',
            '# TYPE kovael_topics_active gauge',
            `kovael_topics_active ${snap.topicsActive}`,
            '# HELP kovael_process_resident_memory_bytes Resident set size in bytes.',
            '# TYPE kovael_process_resident_memory_bytes gauge',
            `kovael_process_resident_memory_bytes ${mem.rss}`,
            '# HELP kovael_process_heap_used_bytes V8 heap used in bytes.',
            '# TYPE kovael_process_heap_used_bytes gauge',
            `kovael_process_heap_used_bytes ${mem.heapUsed}`,
            '# HELP kovael_process_heap_total_bytes V8 heap total in bytes.',
            '# TYPE kovael_process_heap_total_bytes gauge',
            `kovael_process_heap_total_bytes ${mem.heapTotal}`,
            '',
        ].join('\n');

        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
    }

    private uptimeSeconds(): number {
        return Math.floor((Date.now() - this.startedAt) / 1000);
    }
}
