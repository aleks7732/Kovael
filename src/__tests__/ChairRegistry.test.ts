import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChairRegistry, ChairEvent } from '../services/ChairRegistry.js';

describe('ChairRegistry', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('claim emits claimed event and returns a sessionId', () => {
        const reg = new ChairRegistry();
        const events: ChairEvent[] = [];
        reg.on('chair_event', (e: ChairEvent) => events.push(e));

        const claim = reg.claim({ agentId: 'shaev', provider: 'Hermes', trustTier: 3 });

        expect(claim.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(claim.status).toBe('online');
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe('claimed');
        expect(events[0].agentId).toBe('shaev');
    });

    it('heartbeat with matching session refreshes lastBeaconAt', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const reg = new ChairRegistry();
        const { sessionId } = reg.claim({ agentId: 'nyx-codex', provider: 'Codex' });
        const initial = reg.get('nyx-codex')!.lastBeaconAt;

        vi.advanceTimersByTime(5_000);
        const refreshed = reg.heartbeat('nyx-codex', sessionId);

        expect(refreshed).not.toBeNull();
        expect(refreshed!.lastBeaconAt).toBeGreaterThan(initial);
    });

    it('heartbeat with stale sessionId is rejected', () => {
        const reg = new ChairRegistry();
        reg.claim({ agentId: 'nyx-cw', provider: 'JetBrains' });
        // Take the chair with a new claim — the prior session must be unable to heartbeat.
        const second = reg.claim({ agentId: 'nyx-cw', provider: 'JetBrains' });
        const ghost = reg.heartbeat('nyx-cw', 'some-other-session');
        expect(ghost).toBeNull();
        expect(reg.heartbeat('nyx-cw', second.sessionId)).not.toBeNull();
    });

    it('release removes the chair and emits released', () => {
        const reg = new ChairRegistry();
        const events: ChairEvent[] = [];
        reg.on('chair_event', (e: ChairEvent) => events.push(e));

        const { sessionId } = reg.claim({ agentId: 'nyx-adk', provider: 'ADK' });
        const ok = reg.release('nyx-adk', sessionId);

        expect(ok).toBe(true);
        expect(reg.get('nyx-adk')).toBeUndefined();
        expect(events.map((e) => e.kind)).toEqual(['claimed', 'released']);
    });

    it('release with wrong sessionId is a no-op', () => {
        const reg = new ChairRegistry();
        reg.claim({ agentId: 'nyx-adk', provider: 'ADK' });
        expect(reg.release('nyx-adk', 'not-the-right-session')).toBe(false);
        expect(reg.get('nyx-adk')).toBeDefined();
    });

    it('sweep marks beacons stale past healthyMs and evicts past offlineMs', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const reg = new ChairRegistry({ healthyMs: 1_000, offlineMs: 2_000, sweepIntervalMs: 500 });
        const events: ChairEvent[] = [];
        reg.on('chair_event', (e: ChairEvent) => events.push(e));
        reg.start();

        reg.claim({ agentId: 'nyx-openclaw', provider: 'OpenClaw' });

        // Cross healthyMs boundary → expect a 'stale' event.
        vi.advanceTimersByTime(1_500);
        expect(events.some((e) => e.kind === 'stale')).toBe(true);
        expect(reg.get('nyx-openclaw')?.status).toBe('stale');

        // Cross offlineMs boundary → expect 'expired' and eviction.
        vi.advanceTimersByTime(1_500);
        expect(events.some((e) => e.kind === 'expired')).toBe(true);
        expect(reg.get('nyx-openclaw')).toBeUndefined();

        reg.stop();
    });

    it('claim superseding an existing chair emits released for the prior session', () => {
        const reg = new ChairRegistry();
        const events: ChairEvent[] = [];
        reg.on('chair_event', (e: ChairEvent) => events.push(e));

        const first = reg.claim({ agentId: 'nyx-agcli', provider: 'AGCLI' });
        const second = reg.claim({ agentId: 'nyx-agcli', provider: 'AGCLI v2' });

        const kinds = events.map((e) => e.kind);
        expect(kinds).toEqual(['claimed', 'released', 'claimed']);
        expect(first.sessionId).not.toBe(second.sessionId);
    });

    it('stats reports total/online/stale counts', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const reg = new ChairRegistry({ healthyMs: 1_000, offlineMs: 10_000, sweepIntervalMs: 250 });
        reg.start();
        reg.claim({ agentId: 'a', provider: 'p' });
        reg.claim({ agentId: 'b', provider: 'p' });

        expect(reg.stats()).toEqual({ total: 2, online: 2, stale: 0 });

        vi.advanceTimersByTime(1_500);
        expect(reg.stats().stale).toBeGreaterThan(0);
        reg.stop();
    });
});
