import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetTracker } from '../services/BudgetTracker.js';

describe('BudgetTracker', () => {
    let tracker: BudgetTracker;

    beforeEach(() => {
        tracker = new BudgetTracker();
    });

    it('starts a cycle and permits dispatch', () => {
        tracker.configure({ tokensPerCycle: 100_000 });
        tracker.startCycle('c1');
        expect(tracker.canDispatch('c1')).toBe(true);
    });

    it('tracks token usage and permits dispatch within budget', () => {
        tracker.configure({ tokensPerCycle: 1000 });
        tracker.startCycle('c1');
        tracker.recordUsage('c1', 200, 100);

        expect(tracker.canDispatch('c1')).toBe(true);
        const snap = tracker.snapshot('c1');
        expect(snap?.totalTokens).toBe(300);
    });

    it('blocks dispatch when token budget exceeded', () => {
        tracker.configure({ tokensPerCycle: 500 });
        tracker.startCycle('c1');
        tracker.recordUsage('c1', 300, 250);

        expect(tracker.canDispatch('c1')).toBe(false);
    });

    it('blocks dispatch when USD budget exceeded', () => {
        tracker.configure({ usdPerCycle: 0.01 });
        tracker.startCycle('c1');
        // 1M input tokens at default $3/M = $3
        tracker.recordUsage('c1', 1_000_000, 0);

        expect(tracker.canDispatch('c1')).toBe(false);
    });

    it('returns budget exceeded receipt from recordUsage', () => {
        tracker.configure({ tokensPerCycle: 100 });
        tracker.startCycle('c1');
        const receipt = tracker.recordUsage('c1', 150, 0);

        expect(receipt).not.toBeNull();
        expect(receipt!.cycleId).toBe('c1');
        expect(receipt!.reason).toContain('tokens');
    });

    it('returns null from recordUsage when within budget', () => {
        tracker.configure({ tokensPerCycle: 10_000 });
        tracker.startCycle('c1');
        const receipt = tracker.recordUsage('c1', 50, 50);

        expect(receipt).toBeNull();
    });

    it('handles unknown cycles gracefully', () => {
        expect(tracker.canDispatch('unknown')).toBe(true); // no budget = no constraint
        expect(tracker.snapshot('unknown')).toBeUndefined();
    });

    it('ends a cycle and returns final snapshot', () => {
        tracker.configure({ tokensPerCycle: 10_000 });
        tracker.startCycle('c1');
        tracker.recordUsage('c1', 500, 200);

        const final = tracker.endCycle('c1');
        expect(final).toBeDefined();
        expect(final!.totalTokens).toBe(700);

        // After ending, cycle data is cleaned up
        expect(tracker.snapshot('c1')).toBeUndefined();
    });

    it('emits budget_exceeded event', () => {
        tracker.configure({ tokensPerCycle: 100 });
        tracker.startCycle('c1');

        let emitted = false;
        tracker.on('budget_exceeded', () => { emitted = true; });
        tracker.recordUsage('c1', 200, 0);

        expect(emitted).toBe(true);
    });
});
