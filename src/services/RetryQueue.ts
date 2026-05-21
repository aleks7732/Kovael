import { EventEmitter } from 'node:events';
import { TaskClaimMachine, ClaimState } from '../protocols/TaskClaimMachine.js';

export interface RetryConfig {
    maxAttempts: number;
    baseMs: number;
    factor: number;
    sweepIntervalMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    baseMs: 2000,
    factor: 2,
    sweepIntervalMs: 1000,
};

export interface RetryDispatch {
    taskHash: string;
    attempt: number;
    backoffMs: number;
    scheduledFor: number;
    reason: string;
}

/**
 * RetryQueue — Symphony SPEC.md §3.1 retry scheduling with exponential
 * backoff (Apache-2.0, github.com/openai/symphony).
 *
 * On cycle failure, the orchestrator hands the task to this queue with a
 * `goal` payload. The queue:
 *   1. Increments the claim attempt counter (via TaskClaimMachine).
 *   2. If attempt < maxAttempts → transitions claim to RetryQueued, schedules
 *      a re-dispatch after `base * factor^(attempt-1)` ms.
 *   3. If attempt >= maxAttempts → transitions claim to Released with reason
 *      `retry_exhausted`. The orchestrator surfaces that on the PhaseFeed.
 *
 * A periodic sweep (default 1s) drains the queue: tasks whose `scheduledFor`
 * has elapsed are dispatched back to the supplied dispatcher.
 */
export class RetryQueue extends EventEmitter {
    private cfg: RetryConfig;
    private readonly claims: TaskClaimMachine;
    private readonly pending: Map<string, { goal: string; dispatch: RetryDispatch }> = new Map();
    private timer: NodeJS.Timeout | null = null;
    private dispatcher: ((goal: string) => Promise<unknown>) | null = null;

    constructor(claims: TaskClaimMachine, cfg: Partial<RetryConfig> = {}) {
        super();
        this.claims = claims;
        this.cfg = { ...DEFAULT_RETRY_CONFIG, ...cfg };
        if (this.cfg.maxAttempts < 1) throw new RangeError('RetryQueue maxAttempts must be >= 1');
        if (this.cfg.baseMs <= 0) throw new RangeError('RetryQueue baseMs must be > 0');
        if (this.cfg.factor < 1) throw new RangeError('RetryQueue factor must be >= 1');
    }

    public bind(dispatcher: (goal: string) => Promise<unknown>): void {
        this.dispatcher = dispatcher;
    }

    public start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.sweep(), this.cfg.sweepIntervalMs);
    }

    public stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    public updateConfig(cfg: Partial<RetryConfig>): void {
        const oldInterval = this.cfg.sweepIntervalMs;
        this.cfg = { ...this.cfg, ...cfg };
        if (this.timer && cfg.sweepIntervalMs !== undefined && this.cfg.sweepIntervalMs !== oldInterval) {
            this.stop();
            this.start();
        }
    }

    public pendingCount(): number {
        return this.pending.size;
    }

    public snapshot(): RetryDispatch[] {
        return Array.from(this.pending.values()).map(p => ({ ...p.dispatch }));
    }

    /**
     * Called by the orchestrator on a failed cycle.
     * Returns `retry` if scheduled, `exhausted` if no attempts remain.
     */
    public enqueueFailure(taskHash: string, goal: string, reason: string): 'retry' | 'exhausted' {
        const record = this.claims.get(taskHash);
        if (!record) {
            // No claim record yet — treat as immediate exhaustion to avoid
            // creating orphan retries. Caller should register first.
            return 'exhausted';
        }

        const nextAttempt = record.attempt + 1;
        if (nextAttempt > this.cfg.maxAttempts) {
            this.claims.release(taskHash, `retry_exhausted:${reason}`);
            this.emit('retry_exhausted', { taskHash, attempts: record.attempt, reason });
            return 'exhausted';
        }

        const backoffMs = this.cfg.baseMs * Math.pow(this.cfg.factor, record.attempt - 1);
        const queued = this.claims.markRetryQueued(taskHash, backoffMs, `attempt_${record.attempt}_failed:${reason}`);
        if (!queued) {
            // The claim was already released elsewhere — emit exhausted to be safe.
            this.emit('retry_exhausted', { taskHash, attempts: record.attempt, reason: 'claim_already_released' });
            return 'exhausted';
        }

        const dispatch: RetryDispatch = {
            taskHash,
            attempt: nextAttempt,
            backoffMs,
            scheduledFor: Date.now() + backoffMs,
            reason,
        };
        this.pending.set(taskHash, { goal, dispatch });
        this.emit('retry_scheduled', dispatch);
        return 'retry';
    }

    private sweep(): void {
        if (!this.dispatcher) return;

        // Defensive Map cleanup: prune pending tasks whose claims are no longer RetryQueued
        for (const [taskHash] of Array.from(this.pending.entries())) {
            const record = this.claims.get(taskHash);
            if (!record || record.state !== ClaimState.RetryQueued) {
                this.pending.delete(taskHash);
            }
        }

        const due = this.claims.dueForRetry();
        if (due.length === 0) return;

        for (const record of due) {
            const pending = this.pending.get(record.taskHash);
            if (!pending) {
                // The claim says retry-due but we have no goal — release it
                // to avoid leaking RetryQueued forever.
                this.claims.release(record.taskHash, 'retry_due_without_payload');
                continue;
            }
            // Remove from pending before dispatch to prevent duplicate sweep
            // dispatch. The goal is captured in a local variable so recovery
            // can still proceed via the retry_dispatch_error event.
            this.pending.delete(record.taskHash);
            this.emit('retry_dispatching', pending.dispatch);
            // Fire-and-forget — the dispatcher (orchestrator.injectTask) will
            // run a fresh tryClaim → markRunning → release cycle, and on
            // failure call back into enqueueFailure if attempts remain.
            this.dispatcher(pending.goal).catch((err) => {
                this.emit('retry_dispatch_error', {
                    taskHash: record.taskHash,
                    goal: pending.goal,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }
    }
}
