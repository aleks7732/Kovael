import { EventEmitter } from 'node:events';

/**
 * BudgetTracker — per-cycle token / cost / wall-clock governor.
 *
 * Every dispatch accumulates estimated or reported token usage. When a
 * cycle exceeds its budget the tracker emits `budget_exceeded` and
 * returns a structured 402-style receipt so the orchestrator can abort
 * or warn before burning more resources.
 *
 * The budget block is read from WORKFLOW.md:
 *
 *   budget:
 *     tokens_per_cycle: 100000
 *     usd_per_cycle: 2.50
 *     wall_clock_ms: 300000
 *
 * When no budget is configured, the tracker is a passthrough (never blocks).
 */

export interface BudgetConfig {
    /** Max input+output tokens per cycle. 0 = unlimited. */
    tokensPerCycle: number;
    /** Max estimated USD per cycle. 0 = unlimited. */
    usdPerCycle: number;
    /** Max wall-clock milliseconds per cycle. 0 = unlimited. */
    wallClockMs: number;
    /** Estimated cost per 1M input tokens in USD. */
    inputCostPerMillion: number;
    /** Estimated cost per 1M output tokens in USD. */
    outputCostPerMillion: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
    tokensPerCycle: 0,
    usdPerCycle: 0,
    wallClockMs: 0,
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
};

export interface CycleBudgetState {
    cycleId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedUsd: number;
    elapsedMs: number;
    startedAt: number;
    exceeded: boolean;
    exceedReason?: string;
}

export interface BudgetExceededReceipt {
    cycleId: string;
    reason: string;
    budget: { tokens: number; usd: number; wallClockMs: number };
    actual: { tokens: number; usd: number; wallClockMs: number };
}

export class BudgetTracker extends EventEmitter {
    private cfg: BudgetConfig;
    private cycles = new Map<string, CycleBudgetState>();

    constructor(cfg: Partial<BudgetConfig> = {}) {
        super();
        this.cfg = { ...DEFAULT_BUDGET_CONFIG, ...cfg };
    }

    /**
     * Apply new budget configuration (e.g. from hot-reloaded WORKFLOW.md).
     */
    public configure(cfg: Partial<BudgetConfig>): void {
        this.cfg = { ...this.cfg, ...cfg };
    }

    /**
     * Start tracking a new cycle.
     */
    public startCycle(cycleId: string): void {
        this.cycles.set(cycleId, {
            cycleId,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedUsd: 0,
            elapsedMs: 0,
            startedAt: Date.now(),
            exceeded: false,
        });
    }

    /**
     * Record token usage for a cycle. Returns a receipt if budget is exceeded.
     */
    public recordUsage(
        cycleId: string,
        input: number,
        output: number,
    ): BudgetExceededReceipt | null {
        if (input < 0 || output < 0) throw new RangeError('Token counts must be non-negative');
        let state = this.cycles.get(cycleId);
        if (!state) {
            this.startCycle(cycleId);
            state = this.cycles.get(cycleId)!;
        }

        state.inputTokens += input;
        state.outputTokens += output;
        state.totalTokens = state.inputTokens + state.outputTokens;
        state.elapsedMs = Date.now() - state.startedAt;

        // Cost estimation.
        state.estimatedUsd =
            (state.inputTokens / 1_000_000) * this.cfg.inputCostPerMillion +
            (state.outputTokens / 1_000_000) * this.cfg.outputCostPerMillion;

        return this.checkBudget(state);
    }

    /**
     * Check wall-clock only (useful before dispatch, not after).
     */
    public checkWallClock(cycleId: string): BudgetExceededReceipt | null {
        const state = this.cycles.get(cycleId);
        if (!state) return null;
        state.elapsedMs = Date.now() - state.startedAt;
        return this.checkBudget(state);
    }

    private checkBudget(state: CycleBudgetState): BudgetExceededReceipt | null {
        const reasons: string[] = [];

        if (this.cfg.tokensPerCycle > 0 && state.totalTokens > this.cfg.tokensPerCycle) {
            reasons.push(`tokens:${state.totalTokens}>${this.cfg.tokensPerCycle}`);
        }
        if (this.cfg.usdPerCycle > 0 && state.estimatedUsd > this.cfg.usdPerCycle) {
            reasons.push(`usd:${state.estimatedUsd.toFixed(4)}>${this.cfg.usdPerCycle}`);
        }
        if (this.cfg.wallClockMs > 0 && state.elapsedMs > this.cfg.wallClockMs) {
            reasons.push(`wall_clock:${state.elapsedMs}ms>${this.cfg.wallClockMs}ms`);
        }

        if (reasons.length === 0) return null;

        state.exceeded = true;
        state.exceedReason = reasons.join(';');

        const receipt: BudgetExceededReceipt = {
            cycleId: state.cycleId,
            reason: state.exceedReason,
            budget: {
                tokens: this.cfg.tokensPerCycle,
                usd: this.cfg.usdPerCycle,
                wallClockMs: this.cfg.wallClockMs,
            },
            actual: {
                tokens: state.totalTokens,
                usd: state.estimatedUsd,
                wallClockMs: state.elapsedMs,
            },
        };

        this.emit('budget_exceeded', receipt);
        return receipt;
    }

    /**
     * Can the cycle afford another dispatch? Returns true if no budget
     * limit has been exceeded yet.
     */
    public canDispatch(cycleId: string): boolean {
        const state = this.cycles.get(cycleId);
        if (!state) return true;
        state.elapsedMs = Date.now() - state.startedAt;
        return this.checkBudget(state) === null;
    }

    /**
     * Finalize a cycle — clean up tracking state.
     */
    public endCycle(cycleId: string): CycleBudgetState | undefined {
        const state = this.cycles.get(cycleId);
        if (state) {
            state.elapsedMs = Date.now() - state.startedAt;
            this.cycles.delete(cycleId);
        }
        return state;
    }

    public snapshot(cycleId: string): CycleBudgetState | undefined {
        const state = this.cycles.get(cycleId);
        if (state) {
            state.elapsedMs = Date.now() - state.startedAt;
            return { ...state };
        }
        return undefined;
    }

    public config(): Readonly<BudgetConfig> {
        return { ...this.cfg };
    }
}
