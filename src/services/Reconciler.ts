import { EventEmitter } from 'node:events';
import { TaskClaimMachine, ClaimState } from '../protocols/TaskClaimMachine.js';

export interface ReconcilerConfig {
    /** Sweep cadence — how often to inspect the claim ledger. */
    sweepIntervalMs: number;
    /** A Claimed/Running claim is stalled if updatedAt is older than this. */
    stallTimeoutMs: number;
    /** Released claims older than this are pruned from the ledger entirely. */
    cleanupAfterMs: number;
}

export const DEFAULT_RECONCILER_CONFIG: ReconcilerConfig = {
    sweepIntervalMs: 5000,
    stallTimeoutMs: 60_000,    // 1 minute
    cleanupAfterMs: 300_000,   // 5 minutes
};

export interface ReconcileAction {
    kind: 'stall_detected' | 'terminal_cleanup';
    taskHash: string;
    previousState: ClaimState;
    ageMs: number;
    timestamp: number;
}

/**
 * Reconciler — Symphony SPEC §3.1 "active-run reconciliation and stall
 * detection" + "workspace cleanup for terminal issues" (Apache-2.0,
 * github.com/openai/symphony).
 *
 * Two responsibilities, one sweep:
 *   1. Stall detection: a claim stuck in Claimed/Running past stallTimeoutMs
 *      is released with reason `stall_detected:<previous-state>`. The
 *      orchestrator's retry queue does NOT automatically re-dispatch — a
 *      stall is a hint that the agent is wedged, not that the work is
 *      flaky. Operators decide whether to re-inject.
 *   2. Terminal cleanup: a Released claim older than cleanupAfterMs is
 *      removed from the in-memory ledger so the snapshot doesn't grow
 *      unbounded during long-running deployments.
 */
export class Reconciler extends EventEmitter {
    private readonly cfg: ReconcilerConfig;
    private readonly claims: TaskClaimMachine;
    private timer: NodeJS.Timeout | null = null;
    private sweepCount: number = 0;

    constructor(claims: TaskClaimMachine, cfg: Partial<ReconcilerConfig> = {}) {
        super();
        this.claims = claims;
        this.cfg = { ...DEFAULT_RECONCILER_CONFIG, ...cfg };
    }

    public start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.sweep(), this.cfg.sweepIntervalMs);
    }

    public stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    public stats() {
        return {
            sweepCount: this.sweepCount,
            sweepIntervalMs: this.cfg.sweepIntervalMs,
            stallTimeoutMs: this.cfg.stallTimeoutMs,
            cleanupAfterMs: this.cfg.cleanupAfterMs,
        };
    }

    /** Visible for testing — runs one sweep synchronously. */
    public sweep(): void {
        this.sweepCount += 1;
        const now = Date.now();
        const records = this.claims.snapshot();

        for (const r of records) {
            const age = now - r.updatedAt;

            // 1. Stall detection
            if ((r.state === ClaimState.Claimed || r.state === ClaimState.Running) && age >= this.cfg.stallTimeoutMs) {
                const released = this.claims.release(r.taskHash, `stall_detected:${r.state}_${age}ms`);
                if (released) {
                    const action: ReconcileAction = {
                        kind: 'stall_detected',
                        taskHash: r.taskHash,
                        previousState: r.state,
                        ageMs: age,
                        timestamp: now,
                    };
                    this.emit('reconcile_action', action);
                }
                continue;
            }

            // 2. Terminal cleanup
            if (r.state === ClaimState.Released && age >= this.cfg.cleanupAfterMs) {
                this.claims.prune(r.taskHash);
                const action: ReconcileAction = {
                    kind: 'terminal_cleanup',
                    taskHash: r.taskHash,
                    previousState: ClaimState.Released,
                    ageMs: age,
                    timestamp: now,
                };
                this.emit('reconcile_action', action);
            }
        }
    }
}
