import { EventEmitter } from 'node:events';

export type ResourceMode = 'active' | 'idle';

export interface ResourceModeChange {
    mode: ResourceMode;
    previousMode: ResourceMode;
    timestamp: number;
    idleForMs: number;
    reason: string;
}

export interface ResourceGovernorSnapshot {
    enabled: boolean;
    mode: ResourceMode;
    idleAfterMs: number;
    sweepIntervalMs: number;
    lastActivityAt: number;
    lastActivityReason: string;
    idleForMs: number;
    trimCount: number;
    lastTrimmedAt: number | null;
}

export interface ResourceGovernorOptions {
    enabled?: boolean;
    idleAfterMs?: number;
    sweepIntervalMs?: number;
    isBusy?: () => boolean;
    onEnterIdle?: (event: ResourceModeChange) => void;
    onEnterActive?: (event: ResourceModeChange) => void;
    now?: () => number;
}

const DEFAULT_IDLE_AFTER_MS = 10 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

/**
 * Tracks interactive use and flips the orchestrator between the normal
 * active profile and a low-footprint idle profile. Chair heartbeats and
 * health probes should not call noteActivity; user/API/WS traffic should.
 */
export class ResourceGovernor extends EventEmitter {
    private mode: ResourceMode = 'active';
    private timer: NodeJS.Timeout | null = null;
    private lastActivityAt: number;
    private lastActivityReason = 'startup';
    private trimCount = 0;
    private lastTrimmedAt: number | null = null;
    private readonly enabled: boolean;
    private readonly idleAfterMs: number;
    private readonly sweepIntervalMs: number;
    private readonly isBusy: () => boolean;
    private readonly onEnterIdle?: (event: ResourceModeChange) => void;
    private readonly onEnterActive?: (event: ResourceModeChange) => void;
    private readonly now: () => number;

    constructor(options: ResourceGovernorOptions = {}) {
        super();
        this.enabled = options.enabled ?? true;
        this.idleAfterMs = positiveInteger(options.idleAfterMs, DEFAULT_IDLE_AFTER_MS);
        this.sweepIntervalMs = positiveInteger(options.sweepIntervalMs, DEFAULT_SWEEP_INTERVAL_MS);
        this.isBusy = options.isBusy ?? (() => false);
        this.onEnterIdle = options.onEnterIdle;
        this.onEnterActive = options.onEnterActive;
        this.now = options.now ?? (() => Date.now());
        this.lastActivityAt = this.now();
    }

    public start(): void {
        if (!this.enabled || this.timer) return;
        this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
        this.timer.unref();
    }

    public stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    public noteActivity(reason: string): void {
        const now = this.now();
        this.lastActivityAt = now;
        this.lastActivityReason = reason.slice(0, 160);
        if (this.mode === 'idle') {
            this.enterActive(now, reason);
        }
    }

    public snapshot(): ResourceGovernorSnapshot {
        const now = this.now();
        return {
            enabled: this.enabled,
            mode: this.mode,
            idleAfterMs: this.idleAfterMs,
            sweepIntervalMs: this.sweepIntervalMs,
            lastActivityAt: this.lastActivityAt,
            lastActivityReason: this.lastActivityReason,
            idleForMs: Math.max(0, now - this.lastActivityAt),
            trimCount: this.trimCount,
            lastTrimmedAt: this.lastTrimmedAt,
        };
    }

    private sweep(): void {
        if (!this.enabled || this.mode !== 'active') return;

        const now = this.now();
        if (this.isBusy()) {
            this.lastActivityAt = now;
            this.lastActivityReason = 'busy';
            return;
        }

        if (now - this.lastActivityAt >= this.idleAfterMs) {
            this.enterIdle(now);
        }
    }

    private enterIdle(now: number): void {
        if (this.mode === 'idle') return;
        const previousMode = this.mode;
        this.mode = 'idle';
        this.trimCount += 1;
        this.lastTrimmedAt = now;
        const event = {
            mode: this.mode,
            previousMode,
            timestamp: now,
            idleForMs: Math.max(0, now - this.lastActivityAt),
            reason: 'idle_timeout',
        };
        this.emit('resource_mode_changed', event);
        this.onEnterIdle?.(event);
    }

    private enterActive(now: number, reason: string): void {
        if (this.mode === 'active') return;
        const previousMode = this.mode;
        this.mode = 'active';
        const event = {
            mode: this.mode,
            previousMode,
            timestamp: now,
            idleForMs: 0,
            reason: reason.slice(0, 160),
        };
        this.emit('resource_mode_changed', event);
        this.onEnterActive?.(event);
    }
}

function positiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
