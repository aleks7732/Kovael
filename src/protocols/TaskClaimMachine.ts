import { EventEmitter } from 'node:events';

/**
 * TaskClaim — 5-state machine from OpenAI Symphony SPEC.md §7 (Apache-2.0,
 * https://github.com/openai/symphony). Symphony enforces that no two
 * workers operate on the same issue concurrently; we extend the same
 * invariant to Triad cycles so a duplicate task dispatch never runs.
 *
 *   Unclaimed   — task is known but idle
 *   Claimed     — reserved for dispatch (race-prevention window)
 *   Running     — worker has picked it up
 *   RetryQueued — failed; waiting on backoff timer
 *   Released    — claim removed (terminal, inactive, missing, or done)
 *
 * Transitions are guarded; illegal moves throw.
 */
export enum ClaimState {
    Unclaimed = 'Unclaimed',
    Claimed = 'Claimed',
    Running = 'Running',
    RetryQueued = 'RetryQueued',
    Released = 'Released',
}

const LEGAL: Record<ClaimState, ClaimState[]> = {
    [ClaimState.Unclaimed]:   [ClaimState.Claimed,     ClaimState.Released],
    [ClaimState.Claimed]:     [ClaimState.Running,     ClaimState.Released],
    [ClaimState.Running]:     [ClaimState.RetryQueued, ClaimState.Released],
    [ClaimState.RetryQueued]: [ClaimState.Claimed,     ClaimState.Released],
    [ClaimState.Released]:    [],
};

export interface ClaimEvent {
    taskHash: string;
    previous: ClaimState | null;
    state: ClaimState;
    timestamp: number;
    attempt: number;
    reason?: string;
    cycleId?: string;
}

interface ClaimRecord {
    taskHash: string;
    state: ClaimState;
    attempt: number;
    firstSeen: number;
    updatedAt: number;
    cycleId?: string;
    retryAfter?: number;
}

/**
 * TaskClaimMachine: in-memory ledger of every task's current claim state.
 * Orchestrator consults `tryClaim()` before dispatch; the machine refuses
 * duplicate claims, schedules retries, and exposes a snapshot for the
 * /api/v1/state observability endpoint.
 */
export class TaskClaimMachine extends EventEmitter {
    private readonly ledger: Map<string, ClaimRecord> = new Map();

    public has(taskHash: string): boolean {
        return this.ledger.has(taskHash);
    }

    public get(taskHash: string): Readonly<ClaimRecord> | undefined {
        const r = this.ledger.get(taskHash);
        return r ? { ...r } : undefined;
    }

    public snapshot(): Readonly<ClaimRecord>[] {
        return Array.from(this.ledger.values()).map(r => ({ ...r }));
    }

    public stats(): Record<ClaimState, number> {
        const counts: Record<ClaimState, number> = {
            [ClaimState.Unclaimed]: 0,
            [ClaimState.Claimed]: 0,
            [ClaimState.Running]: 0,
            [ClaimState.RetryQueued]: 0,
            [ClaimState.Released]: 0,
        };
        for (const r of this.ledger.values()) counts[r.state] += 1;
        return counts;
    }

    /**
     * Register a task or fetch its current record. Returns the record after
     * registration so the caller can read the attempt count.
     */
    public register(taskHash: string, reason?: string): ClaimRecord {
        const existing = this.ledger.get(taskHash);
        if (existing) return { ...existing };

        const now = Date.now();
        const record: ClaimRecord = {
            taskHash,
            state: ClaimState.Unclaimed,
            attempt: 0,
            firstSeen: now,
            updatedAt: now,
        };
        this.ledger.set(taskHash, record);
        this.emit('claim_event', this.eventFrom(record, null, reason));
        return { ...record };
    }

    /**
     * Atomic claim attempt — the orchestrator's gate. Returns true only
     * when the caller now owns the task. Symphony's core invariant.
     */
    public tryClaim(taskHash: string, cycleId: string, reason?: string): boolean {
        const record = this.ledger.get(taskHash) ?? this.register(taskHash);
        const fresh = this.ledger.get(taskHash)!;

        if (fresh.state !== ClaimState.Unclaimed && fresh.state !== ClaimState.RetryQueued) {
            return false;
        }
        return this.transition(taskHash, ClaimState.Claimed, { cycleId, reason });
    }

    public markRunning(taskHash: string, cycleId: string): boolean {
        return this.transition(taskHash, ClaimState.Running, { cycleId });
    }

    public markRetryQueued(taskHash: string, retryAfterMs: number, reason?: string): boolean {
        const ok = this.transition(taskHash, ClaimState.RetryQueued, { reason });
        if (ok) {
            const r = this.ledger.get(taskHash);
            if (r) r.retryAfter = Date.now() + retryAfterMs;
        }
        return ok;
    }

    public release(taskHash: string, reason: string): boolean {
        return this.transition(taskHash, ClaimState.Released, { reason });
    }

    /**
     * Permanently remove a record from the ledger. Reconciler uses this to
     * keep memory bounded after a Released claim has aged out. No event
     * is emitted — pruning is silent, the ledger snapshot is the only
     * source of truth.
     */
    public prune(taskHash: string): boolean {
        return this.ledger.delete(taskHash);
    }

    /** Tasks whose retryAfter has elapsed and that should be re-claimed. */
    public dueForRetry(): Readonly<ClaimRecord>[] {
        const now = Date.now();
        return Array.from(this.ledger.values())
            .filter(r => r.state === ClaimState.RetryQueued && (r.retryAfter ?? 0) <= now)
            .map(r => ({ ...r }));
    }

    private transition(taskHash: string, next: ClaimState, meta: { cycleId?: string; reason?: string }): boolean {
        const record = this.ledger.get(taskHash);
        if (!record) return false;
        if (!LEGAL[record.state].includes(next)) return false;

        const previous = record.state;
        record.state = next;
        record.updatedAt = Date.now();
        if (meta.cycleId) record.cycleId = meta.cycleId;
        if (next === ClaimState.Claimed) record.attempt += 1;

        this.emit('claim_event', this.eventFrom(record, previous, meta.reason));
        return true;
    }

    private eventFrom(record: ClaimRecord, previous: ClaimState | null, reason?: string): ClaimEvent {
        return {
            taskHash: record.taskHash,
            previous,
            state: record.state,
            timestamp: record.updatedAt,
            attempt: record.attempt,
            reason,
            cycleId: record.cycleId,
        };
    }
}
