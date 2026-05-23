import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../services/CircuitBreaker.js';

describe('CircuitBreaker', () => {
    it('opens after threshold, blocks dispatch, then half-opens after recovery window', () => {
        const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryMs: 1000 });
        const events: any[] = [];
        breaker.on('circuit_event', (event) => events.push(event));

        breaker.recordFailure('shaev', 'drop-1', 1000);
        const opened = breaker.recordFailure('shaev', 'drop-2', 1100);

        expect(opened.state).toBe('open');
        expect(breaker.canDispatch('shaev', 1500)).toBe(false);
        expect(breaker.canDispatch('shaev', 2200)).toBe(true);
        expect(breaker.snapshot()[0].state).toBe('half_open');
        expect(events.map((event) => event.type)).toContain('chair.circuit_open');
        expect(events.map((event) => event.type)).toContain('chair.circuit_half_open');
    });

    it('emits recovered and clears failure counters after success', () => {
        const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryMs: 1000 });
        const spy = vi.fn();
        breaker.on('circuit_event', spy);

        breaker.recordFailure('nyx-cw', 'network');
        const recovered = breaker.recordSuccess('nyx-cw');

        expect(recovered).toMatchObject({ state: 'closed', failures: 0 });
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chair.circuit_recovered' }));
    });
});
