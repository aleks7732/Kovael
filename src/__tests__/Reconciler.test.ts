import { describe, it, expect } from 'vitest';
import { Reconciler } from '../services/Reconciler.js';
import { TaskClaimMachine, ClaimState } from '../protocols/TaskClaimMachine.js';

function makeRunningClaim(claims: TaskClaimMachine, hash: string): void {
    claims.register(hash);
    claims.tryClaim(hash, 'cycle-x');
    claims.markRunning(hash, 'cycle-x');
}

describe('Reconciler', () => {
    it('Running claim older than stallTimeoutMs gets released', () => {
        const claims = new TaskClaimMachine();
        const reconciler = new Reconciler(claims, {
            sweepIntervalMs: 99999,
            stallTimeoutMs: 100,
            cleanupAfterMs: 999999,
        });

        makeRunningClaim(claims, 'r1');

        // Wind the clock: patch updatedAt backward past the stall threshold
        const record = (claims as any).ledger.get('r1');
        record.updatedAt = Date.now() - 200;

        const actions: any[] = [];
        reconciler.on('reconcile_action', a => actions.push(a));
        reconciler.sweep();

        expect(claims.get('r1')?.state).toBe(ClaimState.Released);
        expect(actions).toHaveLength(1);
        expect(actions[0].kind).toBe('stall_detected');
        expect(actions[0].taskHash).toBe('r1');
    });

    it('Claimed claim older than stallTimeoutMs gets released', () => {
        const claims = new TaskClaimMachine();
        const reconciler = new Reconciler(claims, {
            sweepIntervalMs: 99999,
            stallTimeoutMs: 100,
            cleanupAfterMs: 999999,
        });

        claims.register('r2');
        claims.tryClaim('r2', 'cycle-y'); // state=Claimed
        const record = (claims as any).ledger.get('r2');
        record.updatedAt = Date.now() - 200;

        reconciler.sweep();

        expect(claims.get('r2')?.state).toBe(ClaimState.Released);
    });

    it('Released claim older than cleanupAfterMs gets pruned from ledger', () => {
        const claims = new TaskClaimMachine();
        const reconciler = new Reconciler(claims, {
            sweepIntervalMs: 99999,
            stallTimeoutMs: 100,
            cleanupAfterMs: 100,
        });

        claims.register('r3');
        claims.tryClaim('r3', 'cycle-z');
        claims.release('r3', 'done');
        const record = (claims as any).ledger.get('r3');
        record.updatedAt = Date.now() - 200;

        const actions: any[] = [];
        reconciler.on('reconcile_action', a => actions.push(a));
        reconciler.sweep();

        expect(claims.has('r3')).toBe(false);
        expect(actions).toHaveLength(1);
        expect(actions[0].kind).toBe('terminal_cleanup');
    });

    it('fresh Running claim is not stalled', () => {
        const claims = new TaskClaimMachine();
        const reconciler = new Reconciler(claims, {
            sweepIntervalMs: 99999,
            stallTimeoutMs: 60_000,
            cleanupAfterMs: 999999,
        });

        makeRunningClaim(claims, 'r4');
        // updatedAt is just-now — no stall
        reconciler.sweep();
        expect(claims.get('r4')?.state).toBe(ClaimState.Running);
    });

    it('sweepCount increments with each sweep call', () => {
        const claims = new TaskClaimMachine();
        const reconciler = new Reconciler(claims, { sweepIntervalMs: 99999, stallTimeoutMs: 1, cleanupAfterMs: 1 });
        expect(reconciler.stats().sweepCount).toBe(0);
        reconciler.sweep();
        reconciler.sweep();
        expect(reconciler.stats().sweepCount).toBe(2);
    });
});
