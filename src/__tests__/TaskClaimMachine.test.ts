import { describe, it, expect } from 'vitest';
import { TaskClaimMachine, ClaimState } from '../protocols/TaskClaimMachine.js';

describe('TaskClaimMachine', () => {
    it('tryClaim returns true on first claim', () => {
        const m = new TaskClaimMachine();
        m.register('hash-a');
        const result = m.tryClaim('hash-a', 'cycle-1');
        expect(result).toBe(true);
        expect(m.get('hash-a')?.state).toBe(ClaimState.Claimed);
    });

    it('tryClaim returns false on duplicate (already Claimed)', () => {
        const m = new TaskClaimMachine();
        m.register('hash-b');
        expect(m.tryClaim('hash-b', 'cycle-2')).toBe(true);
        // Second attempt on the same hash while already Claimed
        expect(m.tryClaim('hash-b', 'cycle-3')).toBe(false);
    });

    it('tryClaim returns false when task is Running', () => {
        const m = new TaskClaimMachine();
        m.register('hash-c');
        m.tryClaim('hash-c', 'cycle-4');
        m.markRunning('hash-c', 'cycle-4');
        expect(m.tryClaim('hash-c', 'cycle-5')).toBe(false);
    });

    it('illegal transition Released → Claimed is refused (returns false)', () => {
        const m = new TaskClaimMachine();
        m.register('hash-d');
        m.tryClaim('hash-d', 'cycle-6');
        m.release('hash-d', 'done');
        // tryClaim internally checks state — Released is not claimable
        const result = m.tryClaim('hash-d', 'cycle-7');
        expect(result).toBe(false);
        // State must remain Released
        expect(m.get('hash-d')?.state).toBe(ClaimState.Released);
    });

    it('direct transition Released → Running throws (LEGAL guard)', () => {
        const m = new TaskClaimMachine();
        m.register('hash-e');
        m.tryClaim('hash-e', 'cycle-8');
        m.release('hash-e', 'done');
        // markRunning goes through the private transition which enforces LEGAL
        const result = m.markRunning('hash-e', 'cycle-9');
        expect(result).toBe(false); // transition returns false, does not throw
        expect(m.get('hash-e')?.state).toBe(ClaimState.Released);
    });

    it('attempt counter increments on each Claim transition', () => {
        const m = new TaskClaimMachine();
        m.register('hash-f');
        m.tryClaim('hash-f', 'cycle-10');
        expect(m.get('hash-f')?.attempt).toBe(1);
        // Put back to RetryQueued so we can reclaim
        m.markRunning('hash-f', 'cycle-10');
        m.markRetryQueued('hash-f', 0);
        m.tryClaim('hash-f', 'cycle-11');
        expect(m.get('hash-f')?.attempt).toBe(2);
    });

    it('snapshot returns copies — mutations do not affect ledger', () => {
        const m = new TaskClaimMachine();
        m.register('hash-g');
        const snap = m.snapshot();
        expect(snap).toHaveLength(1);
        // Mutating the snapshot record must not alter the ledger
        (snap[0] as any).state = ClaimState.Running;
        expect(m.get('hash-g')?.state).toBe(ClaimState.Unclaimed);
    });
});
