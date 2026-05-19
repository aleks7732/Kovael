import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimitTracker } from '../services/RateLimitTracker.js';

describe('RateLimitTracker', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('canDispatch returns true when under the cap', () => {
        const tracker = new RateLimitTracker({ windowMs: 60_000, maxPerWindow: 5 });
        expect(tracker.canDispatch('agent-a')).toBe(true);
    });

    it('canDispatch returns false once maxPerWindow dispatches have been recorded', () => {
        const tracker = new RateLimitTracker({ windowMs: 60_000, maxPerWindow: 3 });
        tracker.recordDispatch('agent-b');
        tracker.recordDispatch('agent-b');
        tracker.recordDispatch('agent-b');
        expect(tracker.canDispatch('agent-b')).toBe(false);
    });

    it('window slide: old dispatches age out and canDispatch recovers', () => {
        vi.useFakeTimers();
        const tracker = new RateLimitTracker({ windowMs: 1_000, maxPerWindow: 2 });

        // Fill window
        tracker.recordDispatch('agent-c');
        tracker.recordDispatch('agent-c');
        expect(tracker.canDispatch('agent-c')).toBe(false);

        // Advance past the window
        vi.advanceTimersByTime(1_100);
        expect(tracker.canDispatch('agent-c')).toBe(true);
    });

    it('provider-reported limit blocks regardless of local window', () => {
        const tracker = new RateLimitTracker({ windowMs: 60_000, maxPerWindow: 100 });
        const resetAtMs = Date.now() + 60_000;
        tracker.updateProviderLimit('agent-d', 0, resetAtMs);
        expect(tracker.canDispatch('agent-d')).toBe(false);
    });

    it('provider-reported limit unblocks after reset time passes', () => {
        vi.useFakeTimers();
        const tracker = new RateLimitTracker({ windowMs: 60_000, maxPerWindow: 100 });
        const resetAtMs = Date.now() + 1_000;
        tracker.updateProviderLimit('agent-e', 0, resetAtMs);
        expect(tracker.canDispatch('agent-e')).toBe(false);
        vi.advanceTimersByTime(1_100);
        expect(tracker.canDispatch('agent-e')).toBe(true);
    });

    it('snapshot includes correct inWindow count and blocked flag', () => {
        const tracker = new RateLimitTracker({ windowMs: 60_000, maxPerWindow: 2 });
        tracker.recordDispatch('agent-f');
        const snap = tracker.snapshot('agent-f');
        expect(snap.inWindow).toBe(1);
        expect(snap.blocked).toBe(false);

        tracker.recordDispatch('agent-f');
        const snap2 = tracker.snapshot('agent-f');
        expect(snap2.inWindow).toBe(2);
        expect(snap2.blocked).toBe(true);
    });
});
