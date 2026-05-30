import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface VramMetrics {
    status: 'ok' | 'unavailable' | 'error';
    timestamp: number;
    freeMb: number;
    usedMb: number;
    totalMb: number;
    utilizationPct: number;
    devices: number;
    error?: string;
}

const SMI_ARGS = [
    '--query-gpu=memory.free,memory.used,memory.total,utilization.gpu',
    '--format=csv,noheader,nounits',
];
const SMI_TIMEOUT_MS = 5_000;
const SMI_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * HardwareMonitor: VRAM-aware sensor for the Sovereign Mesh.
 * Polls nvidia-smi on a fixed cadence and broadcasts aggregate VRAM metrics.
 * Designed to fail soft — never throws — so the orchestrator stays alive on
 * machines without an NVIDIA stack.
 */
export class HardwareMonitor extends EventEmitter {
    private timer: NodeJS.Timeout | null = null;
    private latest: VramMetrics;
    private readonly intervalMs: number;
    private inFlight: boolean = false;
    private running: boolean = false;
    private generation: number = 0;

    constructor(intervalMs: number = 2000) {
        super();
        this.intervalMs = intervalMs;
        this.latest = {
            status: 'unavailable',
            timestamp: Date.now(),
            freeMb: 0,
            usedMb: 0,
            totalMb: 0,
            utilizationPct: 0,
            devices: 0,
        };
    }

    public start(): void {
        if (this.running) return;
        this.running = true;
        const generation = this.generation;
        this.poll(generation);
        this.timer = setInterval(() => this.poll(generation), this.intervalMs);
    }

    public stop(): void {
        if (!this.running && !this.timer) return;
        this.running = false;
        this.generation += 1;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    public snapshot(): VramMetrics {
        return { ...this.latest };
    }

    private poll(generation: number): void {
        if (!this.running || generation !== this.generation || this.inFlight) return;
        this.inFlight = true;

        let stdout = '';
        let stderr = '';
        let child;

        try {
            child = spawn('nvidia-smi', SMI_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            this.inFlight = false;
            if (!this.running || generation !== this.generation) return;
            this.publishUnavailable('spawn_failed');
            return;
        }

        // Kill a hung/streaming nvidia-smi so it cannot permanently latch inFlight
        // (freezing all future polls) or stream unbounded stdout into memory.
        const killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, SMI_TIMEOUT_MS);
        killTimer.unref?.();

        const cap = (buf: string, chunk: Buffer): string =>
            buf.length >= SMI_MAX_OUTPUT_BYTES ? buf : buf + chunk.toString();
        child.stdout.on('data', (chunk) => { stdout = cap(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = cap(stderr, chunk); });

        child.on('error', () => {
            clearTimeout(killTimer);
            this.inFlight = false;
            if (!this.running || generation !== this.generation) return;
            this.publishUnavailable('nvidia-smi_missing');
        });

        child.on('close', (code) => {
            clearTimeout(killTimer);
            this.inFlight = false;
            if (!this.running || generation !== this.generation) return;
            if (code !== 0) {
                this.publishUnavailable(stderr.trim().split('\n')[0] || `exit_${code}`);
                return;
            }
            const parsed = this.parseSmiOutput(stdout);
            this.publish(parsed);
        });
    }

    private parseSmiOutput(raw: string): VramMetrics {
        const rows = raw.split('\n').map(r => r.trim()).filter(Boolean);
        if (rows.length === 0) {
            return { ...this.latest, status: 'unavailable', timestamp: Date.now(), error: 'empty_output' };
        }

        let freeMb = 0;
        let usedMb = 0;
        let totalMb = 0;
        let utilSum = 0;

        for (const row of rows) {
            const cols = row.split(',').map(c => c.trim());
            if (cols.length < 4) continue;
            const [free, used, total, util] = cols.map(c => parseInt(c, 10));
            if (Number.isNaN(free) || Number.isNaN(used) || Number.isNaN(total)) continue;
            freeMb += free;
            usedMb += used;
            totalMb += total;
            utilSum += Number.isNaN(util) ? 0 : util;
        }

        return {
            status: 'ok',
            timestamp: Date.now(),
            freeMb,
            usedMb,
            totalMb,
            utilizationPct: rows.length > 0 ? Math.round(utilSum / rows.length) : 0,
            devices: rows.length,
        };
    }

    private publish(metrics: VramMetrics): void {
        this.latest = metrics;
        this.emit('vram_metrics', metrics);
    }

    private publishUnavailable(reason: string): void {
        const m: VramMetrics = {
            status: 'unavailable',
            timestamp: Date.now(),
            freeMb: 0,
            usedMb: 0,
            totalMb: 0,
            utilizationPct: 0,
            devices: 0,
            error: reason,
        };
        this.latest = m;
        this.emit('vram_metrics', m);
    }
}
