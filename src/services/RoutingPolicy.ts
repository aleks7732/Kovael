import { EventEmitter } from 'node:events';

/**
 * RoutingPolicy — outcome-driven agent selection via Thompson sampling.
 *
 * Replaces the static VRAM-floor routing with a lightweight bandit that
 * learns which chair performs best for each task class. The VRAM floor
 * stays as a hard constraint; the bandit picks among feasible chairs.
 *
 * Model:
 * - Each (taskClass, chairId) pair maintains a Beta(α, β) distribution.
 * - On each dispatch, sample from each feasible chair's Beta and pick
 *   the highest sample (Thompson sampling).
 * - On verifier pass → α += 1. On verifier fail → β += 1.
 * - Priors start at α=1, β=1 (uniform) for exploration.
 *
 * Falls back to the static router when:
 * - No outcome history exists (cold start).
 * - `enabled` is false (default until opted in via WORKFLOW.md).
 */

export interface RoutingOutcome {
    taskClass: string;
    chairId: string;
    success: boolean;
    timestamp: number;
}

export interface ChairPrior {
    alpha: number;
    beta: number;
    total: number;
    successRate: number;
}

export interface RoutingDecision {
    chairId: string;
    sample: number;
    rationale: string;
    method: 'bandit' | 'static';
}

export interface RoutingPolicyConfig {
    /** Enable Thompson sampling. Default false (static routing). */
    enabled: boolean;
    /** Minimum observations before bandit takes over from static. */
    minObservations: number;
    /** Decay factor for old observations (0-1). 1 = no decay. */
    decayFactor: number;
}

export const DEFAULT_ROUTING_POLICY_CONFIG: RoutingPolicyConfig = {
    enabled: false,
    minObservations: 5,
    decayFactor: 1.0,
};

export class RoutingPolicy extends EventEmitter {
    private cfg: RoutingPolicyConfig;
    /** Map<"taskClass:chairId", { alpha, beta }> */
    private priors = new Map<string, { alpha: number; beta: number }>();

    constructor(cfg: Partial<RoutingPolicyConfig> = {}) {
        super();
        this.cfg = { ...DEFAULT_ROUTING_POLICY_CONFIG, ...cfg };
    }

    public configure(cfg: Partial<RoutingPolicyConfig>): void {
        this.cfg = { ...this.cfg, ...cfg };
    }

    /**
     * Select the best chair from `feasibleChairs` for the given task class.
     * If bandit is disabled or has insufficient data, returns null to
     * signal the caller should use static routing.
     */
    public select(taskClass: string, feasibleChairs: string[]): RoutingDecision | null {
        if (!this.cfg.enabled || feasibleChairs.length === 0) return null;

        // Check if we have enough observations for any chair.
        const hasEnoughData = feasibleChairs.some((chairId) => {
            const prior = this.getPrior(taskClass, chairId);
            return prior.total >= this.cfg.minObservations;
        });

        if (!hasEnoughData) return null;

        // Thompson sampling: draw from each chair's Beta distribution.
        let bestChair = feasibleChairs[0];
        let bestSample = -1;

        for (const chairId of feasibleChairs) {
            const prior = this.getPrior(taskClass, chairId);
            const sample = this.sampleBeta(prior.alpha, prior.beta);
            if (sample > bestSample) {
                bestSample = sample;
                bestChair = chairId;
            }
        }

        return {
            chairId: bestChair,
            sample: bestSample,
            rationale: `thompson_sampling:task_class=${taskClass},sample=${bestSample.toFixed(4)}`,
            method: 'bandit',
        };
    }

    /**
     * Record the outcome of a dispatch for bandit learning.
     */
    public recordOutcome(outcome: RoutingOutcome): void {
        const key = `${outcome.taskClass}:${outcome.chairId}`;
        const prior = this.priors.get(key) ?? { alpha: 1, beta: 1 };

        if (this.cfg.decayFactor < 1.0) {
            prior.alpha = 1 + (prior.alpha - 1) * this.cfg.decayFactor;
            prior.beta = 1 + (prior.beta - 1) * this.cfg.decayFactor;
        }

        if (outcome.success) {
            prior.alpha += 1;
        } else {
            prior.beta += 1;
        }

        this.priors.set(key, prior);
        this.emit('outcome_recorded', outcome);
    }

    /**
     * Get the current prior for a (taskClass, chairId) pair.
     */
    public getPrior(taskClass: string, chairId: string): ChairPrior {
        const key = `${taskClass}:${chairId}`;
        const prior = this.priors.get(key) ?? { alpha: 1, beta: 1 };
        const total = prior.alpha + prior.beta - 2; // Subtract the 2 from the uniform prior.
        return {
            alpha: prior.alpha,
            beta: prior.beta,
            total: Math.max(0, total),
            successRate: total > 0 ? (prior.alpha - 1) / total : 0.5,
        };
    }

    /**
     * Get all priors for a task class, sorted by success rate descending.
     */
    public leaderboard(taskClass: string): Array<{ chairId: string } & ChairPrior> {
        const results: Array<{ chairId: string } & ChairPrior> = [];
        const prefix = `${taskClass}:`;
        for (const [key] of this.priors) {
            if (key.startsWith(prefix)) {
                const chairId = key.slice(prefix.length);
                results.push({ chairId, ...this.getPrior(taskClass, chairId) });
            }
        }
        return results.sort((a, b) => b.successRate - a.successRate);
    }

    /**
     * Sample from a Beta(α, β) distribution using the Jöhnk algorithm.
     * This is a lightweight approximation suitable for our use case.
     */
    private sampleBeta(alpha: number, beta: number): number {
        // Use the gamma-ratio method for general Beta sampling.
        const x = this.sampleGamma(alpha);
        const y = this.sampleGamma(beta);
        return x / (x + y);
    }

    /**
     * Sample from Gamma(shape, 1) using Marsaglia and Tsang's method.
     */
    private sampleGamma(shape: number): number {
        if (shape < 1) {
            // Boost: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
            return this.sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
        }
        const d = shape - 1 / 3;
        const c = 1 / Math.sqrt(9 * d);
        const MAX_ITERATIONS = 1000;
        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            let x: number;
            let v: number;
            do {
                x = this.standardNormal();
                v = 1 + c * x;
            } while (v <= 0);
            v = v * v * v;
            const u = Math.random();
            if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
            if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
        }
        // Fallback — should be statistically unreachable.
        return d;
    }

    /**
     * Box-Muller transform for standard normal samples.
     */
    private standardNormal(): number {
        const u1 = Math.random();
        const u2 = Math.random();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    public config(): Readonly<RoutingPolicyConfig> {
        return { ...this.cfg };
    }

    public reset(): void {
        this.priors.clear();
    }
}
