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
 * These routes live outside `/api/v1/*`; `/livez` and `/readyz` stay
 * probe-friendly, while `/metrics` may still be token-gated at the
 * orchestrator router.
 */

export interface MetricsSnapshot {
    chairsActive: number;
    topicsActive: number;
    chairDispatch?: {
        attempts: number;
        retries: number;
        accepted: number;
        successes: number;
        failures: number;
        inflight: number;
    };
}

export interface HealthEndpointOptions {
    minReadyChairs?: number;
}

export class HealthEndpoints {
    private ready = false;
    private readonly startedAt = Date.now();
    private readonly minReadyChairs: number;

    constructor(private readonly snapshot: () => MetricsSnapshot, opts: HealthEndpointOptions = {}) {
        this.minReadyChairs = Math.max(0, opts.minReadyChairs ?? 1);
    }

    public setReady(): void {
        this.ready = true;
    }

    public livez(res: ServerResponse): void {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime_s: this.uptimeSeconds() }));
    }

    public readyz(res: ServerResponse): void {
        try {
            const chairsReady = this.snapshot().chairsActive >= this.minReadyChairs;
            const ready = this.ready && chairsReady;
            const status = ready ? 200 : 503;
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: ready ? 'ok' : 'pending', min_ready_chairs: this.minReadyChairs }));
        } catch {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'error' }));
        }
    }

    public metrics(res: ServerResponse): void {
        const mem = process.memoryUsage();
        let snap;
        try {
            snap = this.snapshot();
        } catch {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'error' }));
            return;
        }
        const dispatch = snap.chairDispatch ?? {
            attempts: 0,
            retries: 0,
            accepted: 0,
            successes: 0,
            failures: 0,
            inflight: 0,
        };
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
            '# HELP kovael_chair_dispatch_attempts_total Total chair dispatch POST attempts.',
            '# TYPE kovael_chair_dispatch_attempts_total counter',
            `kovael_chair_dispatch_attempts_total ${dispatch.attempts}`,
            '# HELP kovael_chair_dispatch_retries_total Total chair dispatch retry attempts.',
            '# TYPE kovael_chair_dispatch_retries_total counter',
            `kovael_chair_dispatch_retries_total ${dispatch.retries}`,
            '# HELP kovael_chair_dispatch_accepted_total Total chair dispatches accepted by inbox adapters.',
            '# TYPE kovael_chair_dispatch_accepted_total counter',
            `kovael_chair_dispatch_accepted_total ${dispatch.accepted}`,
            '# HELP kovael_chair_dispatch_success_total Total chair dispatches completed with successful replies.',
            '# TYPE kovael_chair_dispatch_success_total counter',
            `kovael_chair_dispatch_success_total ${dispatch.successes}`,
            '# HELP kovael_chair_dispatch_failures_total Total chair dispatches that failed before or during reply.',
            '# TYPE kovael_chair_dispatch_failures_total counter',
            `kovael_chair_dispatch_failures_total ${dispatch.failures}`,
            '# HELP kovael_chair_dispatch_inflight Current chair dispatches awaiting acceptance or reply.',
            '# TYPE kovael_chair_dispatch_inflight gauge',
            `kovael_chair_dispatch_inflight ${dispatch.inflight}`,
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
