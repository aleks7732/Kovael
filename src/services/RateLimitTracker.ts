import { EventEmitter } from 'node:events';

export interface RateLimitConfig {
    windowMs: number;
    maxPerWindow: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
    windowMs: 60_000,
    maxPerWindow: 60,
};

export interface AgentRateSnapshot {
    agentId: string;
    inWindow: number;
    capacity: number;
    windowMs: number;
    blocked: boolean;
    resetAtMs?: number;
    providerReported?: { remaining: number; resetAtMs: number };
}

/**
 * RateLimitTracker — Symphony §13 rate-limit accounting.
 *
 * Two sources of truth, in priority order:
 *
 *   1. Provider-reported limits (set via updateProviderLimit). When a real
 *      LLM provider returns Retry-After / X-RateLimit-Remaining headers,
 *      the orchestrator surfaces those here. These ALWAYS win.
 *   2. Local sliding-window counter. Tracks every dispatch and refuses
 *      `canDispatch()` once the agent has burned more than `maxPerWindow`
 *      cycles in the trailing `windowMs`. Defaults give 60 dispatches per
 *      minute per agent — easily tunable per WORKFLOW.md.
 *
 * `MevBridge.routeArchitect()` consults `canDispatch(SHAEV_AGENT)` before
 * selecting Shaev for heavy work and falls back to Nyx-CLI when blocked,
 * embedding the rate-limit decision in the receipt's routing rationale.
 */
export class RateLimitTracker extends EventEmitter {
    private readonly cfg: RateLimitConfig;
    private readonly windows: Map<string, number[]> = new Map();
    private readonly providerLimits: Map<string, { remaining: number; resetAtMs: number }> = new Map();

    constructor(cfg: Partial<RateLimitConfig> = {}) {
        super();
        this.cfg = { ...DEFAULT_RATE_LIMIT_CONFIG, ...cfg };
    }

    public recordDispatch(agentId: string): void {
        const now = Date.now();
        const list = this.windows.get(agentId) ?? [];
        list.push(now);
        this.prune(list, now);
        this.windows.set(agentId, list);
        this.emit('rate_limit_update', this.snapshot(agentId));
    }

    public canDispatch(agentId: string): boolean {
        const reported = this.providerLimits.get(agentId);
        if (reported && reported.remaining <= 0 && Date.now() < reported.resetAtMs) {
            return false;
        }
        const list = this.windows.get(agentId) ?? [];
        this.prune(list, Date.now());
        return list.length < this.cfg.maxPerWindow;
    }

    public updateProviderLimit(agentId: string, remaining: number, resetAtMs: number): void {
        this.providerLimits.set(agentId, { remaining, resetAtMs });
        this.emit('rate_limit_update', this.snapshot(agentId));
    }

    public snapshot(agentId: string): AgentRateSnapshot {
        const list = this.windows.get(agentId) ?? [];
        this.prune(list, Date.now());
        const oldest = list[0];
        const reported = this.providerLimits.get(agentId);
        return {
            agentId,
            inWindow: list.length,
            capacity: this.cfg.maxPerWindow,
            windowMs: this.cfg.windowMs,
            blocked: !this.canDispatch(agentId),
            resetAtMs: oldest ? oldest + this.cfg.windowMs : undefined,
            providerReported: reported ? { ...reported } : undefined,
        };
    }

    public allSnapshots(): AgentRateSnapshot[] {
        return Array.from(this.windows.keys()).map(id => this.snapshot(id));
    }

    private prune(list: number[], now: number): void {
        const cutoff = now - this.cfg.windowMs;
        while (list.length > 0 && list[0] < cutoff) list.shift();
    }
}
