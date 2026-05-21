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
const MAX_SMI_OUTPUT_BYTES = 64 * 1024;

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
        if (this.timer) return;
        this.poll();
        this.timer = setInterval(() => this.poll(), this.intervalMs);
    }

    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    public snapshot(): VramMetrics {
        return { ...this.latest };
    }

    private poll(): void {
        if (this.inFlight) return;
        this.inFlight = true;

        let stdout = '';
        let stderr = '';
        let child: ReturnType<typeof spawn> | null = null;
        let outputBytes = 0;
        let killedForOutputLimit = false;

        const appendBounded = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
            outputBytes += chunk.byteLength;
            if (outputBytes > MAX_SMI_OUTPUT_BYTES) {
                killedForOutputLimit = true;
                child?.kill();
                return;
            }
            if (target === 'stdout') stdout += chunk.toString('utf8');
            else stderr += chunk.toString('utf8');
        };

        try {
            child = spawn('nvidia-smi', SMI_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            this.inFlight = false;
            this.publishUnavailable('spawn_failed');
            return;
        }

        child.stdout!.on('data', (chunk: Buffer) => appendBounded('stdout', chunk));
        child.stderr!.on('data', (chunk: Buffer) => appendBounded('stderr', chunk));

        child.on('error', () => {
            this.inFlight = false;
            this.publishUnavailable('nvidia-smi_missing');
        });

        child.on('close', (code) => {
            this.inFlight = false;
            if (killedForOutputLimit) {
                this.publishUnavailable('nvidia-smi_output_limit');
                return;
            }
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
