import { describe, it, expect, vi, afterEach } from 'vitest';
import { ResourceGovernor } from '../services/ResourceGovernor.js';

describe('ResourceGovernor', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('enters idle mode after the quiet window and invokes the idle callback once', async () => {
        vi.useFakeTimers();
        const onEnterIdle = vi.fn();
        const governor = new ResourceGovernor({
            idleAfterMs: 1_000,
            sweepIntervalMs: 100,
            onEnterIdle,
        });

        governor.start();
        await vi.advanceTimersByTimeAsync(999);
        expect(governor.snapshot().mode).toBe('active');
        expect(onEnterIdle).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(governor.snapshot().mode).toBe('idle');
        expect(onEnterIdle).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(onEnterIdle).toHaveBeenCalledTimes(1);
        governor.stop();
    });

    it('returns to active mode when interactive activity arrives', async () => {
        vi.useFakeTimers();
        const onEnterActive = vi.fn();
        const governor = new ResourceGovernor({
            idleAfterMs: 500,
            sweepIntervalMs: 100,
            onEnterActive,
        });

        governor.start();
        await vi.advanceTimersByTimeAsync(500);
        expect(governor.snapshot().mode).toBe('idle');

        governor.noteActivity('http:GET:/api/v1/state');

        const snapshot = governor.snapshot();
        expect(snapshot.mode).toBe('active');
        expect(snapshot.lastActivityReason).toBe('http:GET:/api/v1/state');
        expect(onEnterActive).toHaveBeenCalledTimes(1);
        governor.stop();
    });

    it('stays active while the busy predicate reports active work', async () => {
        vi.useFakeTimers();
        let busy = true;
        const governor = new ResourceGovernor({
            idleAfterMs: 500,
            sweepIntervalMs: 100,
            isBusy: () => busy,
        });

        governor.start();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(governor.snapshot().mode).toBe('active');

        busy = false;
        await vi.advanceTimersByTimeAsync(499);
        expect(governor.snapshot().mode).toBe('active');

        await vi.advanceTimersByTimeAsync(1);
        expect(governor.snapshot().mode).toBe('idle');
        governor.stop();
    });
});
