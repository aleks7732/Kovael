import { describe, it, expect } from 'vitest';
import { HookRunner } from '../services/HookRunner.js';
import type { HookContext } from '../services/HookRunner.js';

const ctx: HookContext = { cycleId: 'test-cycle' };

describe('HookRunner', () => {
    it('successful before_run hook does not set shouldAbort', async () => {
        const runner = new HookRunner();
        runner.register({
            name: 'ok-hook',
            event: 'before_run',
            fn: async () => { /* success */ },
        });
        const results = await runner.run('before_run', ctx);
        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(true);
        expect(runner.shouldAbort('before_run', results)).toBe(false);
    });

    it('failing before_run hook causes shouldAbort to return true', async () => {
        const runner = new HookRunner();
        runner.register({
            name: 'fail-hook',
            event: 'before_run',
            fn: async () => { throw new Error('hook exploded'); },
        });
        const results = await runner.run('before_run', ctx);
        expect(results[0].success).toBe(false);
        expect(results[0].error).toContain('hook exploded');
        expect(runner.shouldAbort('before_run', results)).toBe(true);
    });

    it('failing after_run hook does NOT set shouldAbort (advisory event)', async () => {
        const runner = new HookRunner();
        runner.register({
            name: 'advisory-fail',
            event: 'after_run',
            fn: async () => { throw new Error('advisory failure'); },
        });
        const results = await runner.run('after_run', ctx);
        expect(results[0].success).toBe(false);
        // after_run is not in ABORT_ON_FAILURE
        expect(runner.shouldAbort('after_run', results)).toBe(false);
    });

    it('hook exceeding timeoutMs is killed and timedOut is set', async () => {
        const runner = new HookRunner();
        runner.register({
            name: 'slow-hook',
            event: 'before_run',
            fn: () => new Promise(resolve => setTimeout(resolve, 10_000)),
            timeoutMs: 50, // very short timeout
        });
        const results = await runner.run('before_run', ctx);
        expect(results[0].success).toBe(false);
        expect(results[0].timedOut).toBe(true);
        expect(runner.shouldAbort('before_run', results)).toBe(true);
    }, 3000);

    it('multiple hooks run in registration order; first failure short-circuits before_run', async () => {
        const runner = new HookRunner();
        const log: string[] = [];
        runner.register({ name: 'h1', event: 'before_run', fn: async () => { log.push('h1'); } });
        runner.register({ name: 'h2', event: 'before_run', fn: async () => { throw new Error('boom'); } });
        runner.register({ name: 'h3', event: 'before_run', fn: async () => { log.push('h3'); } });

        const results = await runner.run('before_run', ctx);
        expect(log).toEqual(['h1']);  // h3 never runs after h2 fails
        expect(results).toHaveLength(2); // h1 + h2
        expect(runner.shouldAbort('before_run', results)).toBe(true);
    });

    it('unregister removes a handler and it stops running', async () => {
        const runner = new HookRunner();
        let ran = false;
        runner.register({ name: 'removable', event: 'after_run', fn: async () => { ran = true; } });
        runner.unregister('after_run', 'removable');
        await runner.run('after_run', ctx);
        expect(ran).toBe(false);
    });
});
