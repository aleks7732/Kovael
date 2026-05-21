import { describe, it, expect, beforeEach } from 'vitest';
import { RoutingPolicy } from '../services/RoutingPolicy.js';

describe('RoutingPolicy', () => {
    let policy: RoutingPolicy;

    beforeEach(() => {
        policy = new RoutingPolicy({ enabled: true, minObservations: 0 });
    });

    it('selects from feasible chairs via Thompson sampling', () => {
        const feasible = ['nyx-cli', 'shaev', 'orbiter'];
        const decision = policy.select('code_review', feasible);

        expect(decision).not.toBeNull();
        expect(feasible).toContain(decision!.chairId);
        expect(decision!.method).toBe('bandit');
    });

    it('returns null for empty feasible set', () => {
        expect(policy.select('code_review', [])).toBeNull();
    });

    it('returns null when disabled', () => {
        const disabled = new RoutingPolicy({ enabled: false });
        expect(disabled.select('task', ['a', 'b'])).toBeNull();
    });

    it('returns null when minObservations not met', () => {
        const strict = new RoutingPolicy({ enabled: true, minObservations: 10 });
        // No observations recorded, so should return null
        expect(strict.select('task', ['a', 'b'])).toBeNull();
    });

    it('records outcomes and shifts distribution', () => {
        // Record many successes for good-chair and failures for bad-chair
        for (let i = 0; i < 50; i++) {
            policy.recordOutcome({ taskClass: 'test_task', chairId: 'good-chair', success: true, timestamp: Date.now() });
            policy.recordOutcome({ taskClass: 'test_task', chairId: 'bad-chair', success: false, timestamp: Date.now() });
        }

        const feasible = ['good-chair', 'bad-chair'];

        // Over many selections, good-chair should be picked more often
        let goodCount = 0;
        const trials = 200;
        for (let i = 0; i < trials; i++) {
            const decision = policy.select('test_task', feasible);
            if (decision?.chairId === 'good-chair') goodCount++;
        }

        // good-chair should dominate (>70% of selections)
        expect(goodCount / trials).toBeGreaterThan(0.7);
    });

    it('getPrior returns distribution info', () => {
        policy.recordOutcome({ taskClass: 'task', chairId: 'chair-a', success: true, timestamp: Date.now() });
        policy.recordOutcome({ taskClass: 'task', chairId: 'chair-a', success: true, timestamp: Date.now() });
        policy.recordOutcome({ taskClass: 'task', chairId: 'chair-a', success: false, timestamp: Date.now() });

        const prior = policy.getPrior('task', 'chair-a');
        expect(prior.total).toBe(3);
        expect(prior.alpha).toBeGreaterThan(1);
    });

    it('getPrior returns uniform prior for unknown pair', () => {
        const prior = policy.getPrior('unknown', 'unknown');
        expect(prior.alpha).toBe(1);
        expect(prior.beta).toBe(1);
        expect(prior.total).toBe(0);
    });

    it('leaderboard returns chairs sorted by success rate', () => {
        for (let i = 0; i < 10; i++) {
            policy.recordOutcome({ taskClass: 'build', chairId: 'fast', success: true, timestamp: Date.now() });
            policy.recordOutcome({ taskClass: 'build', chairId: 'slow', success: i < 3, timestamp: Date.now() });
        }

        const board = policy.leaderboard('build');
        expect(board.length).toBe(2);
        expect(board[0].chairId).toBe('fast');
        expect(board[0].successRate).toBeGreaterThan(board[1].successRate);
    });

    it('reset clears all priors', () => {
        policy.recordOutcome({ taskClass: 'task', chairId: 'a', success: true, timestamp: Date.now() });
        policy.reset();
        expect(policy.getPrior('task', 'a').total).toBe(0);
    });
});
