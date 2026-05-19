import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetryQueue, DEFAULT_RETRY_CONFIG } from '../services/RetryQueue.js';
import { TaskClaimMachine, ClaimState } from '../protocols/TaskClaimMachine.js';

function makePair(cfg: Partial<typeof DEFAULT_RETRY_CONFIG> = {}) {
    const claims = new TaskClaimMachine();
    const queue = new RetryQueue(claims, { sweepIntervalMs: 50, ...cfg });
    return { claims, queue };
}

describe('RetryQueue', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('enqueueFailure on first attempt schedules retry with base backoff', () => {
        const { claims, queue } = makePair({ baseMs: 500, factor: 2, maxAttempts: 3 });
        claims.register('h1');
        claims.tryClaim('h1', 'c1');         // attempt=1, state=Claimed
        claims.markRunning('h1', 'c1');      // state=Running

        const scheduledSpy = vi.fn();
        queue.on('retry_scheduled', scheduledSpy);

        const outcome = queue.enqueueFailure('h1', 'do work', 'test_fail');
        expect(outcome).toBe('retry');
        expect(claims.get('h1')?.state).toBe(ClaimState.RetryQueued);
        expect(scheduledSpy).toHaveBeenCalledOnce();

        const dispatch = scheduledSpy.mock.calls[0][0];
        // attempt=1 → backoff = base * factor^0 = 500ms
        expect(dispatch.backoffMs).toBe(500);
        expect(dispatch.attempt).toBe(2);
    });

    it('exceeding maxAttempts releases the claim as retry_exhausted', () => {
        const { claims, queue } = makePair({ maxAttempts: 1 });
        claims.register('h2');
        claims.tryClaim('h2', 'c2');
        claims.markRunning('h2', 'c2');

        const exhaustedSpy = vi.fn();
        queue.on('retry_exhausted', exhaustedSpy);

        const outcome = queue.enqueueFailure('h2', 'do work', 'test_fail');
        expect(outcome).toBe('exhausted');
        expect(claims.get('h2')?.state).toBe(ClaimState.Released);
        expect(exhaustedSpy).toHaveBeenCalledOnce();
        expect(exhaustedSpy.mock.calls[0][0]).toMatchObject({ taskHash: 'h2' });
    });

    it('sweep dispatches when retryAfter elapses', async () => {
        vi.useFakeTimers();
        const { claims, queue } = makePair({ baseMs: 100, factor: 1, maxAttempts: 3, sweepIntervalMs: 50 });

        const dispatched: string[] = [];
        queue.bind(async (goal) => { dispatched.push(goal); });
        // start() registers the setInterval under fake timers
        queue.start();

        claims.register('h3');
        claims.tryClaim('h3', 'c3');
        claims.markRunning('h3', 'c3');
        queue.enqueueFailure('h3', 'goal-text', 'first_fail');

        expect(dispatched).toHaveLength(0);

        // Advance past the backoff (100ms) and past one sweep interval (50ms).
        // With fake timers, setInterval fires synchronously at each boundary.
        vi.advanceTimersByTime(200);

        queue.stop();
        expect(dispatched).toEqual(['goal-text']);
    });

    it('enqueueFailure without a prior register returns exhausted', () => {
        const { queue } = makePair();
        const outcome = queue.enqueueFailure('unknown-hash', 'goal', 'no_record');
        expect(outcome).toBe('exhausted');
    });

    it('pendingCount tracks queued retries', () => {
        const { claims, queue } = makePair({ maxAttempts: 3, baseMs: 9999 });
        claims.register('h4');
        claims.tryClaim('h4', 'c4');
        claims.markRunning('h4', 'c4');
        expect(queue.pendingCount()).toBe(0);
        queue.enqueueFailure('h4', 'goal', 'fail');
        expect(queue.pendingCount()).toBe(1);
    });
});
