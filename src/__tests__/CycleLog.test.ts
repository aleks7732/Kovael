import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { CycleLog } from '../services/CycleLog.js';
import { openOrchestratorDb } from '../services/OrchestratorDb.js';

describe('CycleLog', () => {
    let db: DatabaseSync;
    let log: CycleLog;

    beforeEach(() => {
        db = openOrchestratorDb({ path: ':memory:' }).db;
        log = new CycleLog(db);
    });

    afterEach(() => {
        db.close();
    });

    it('appends events and retrieves trail in order', () => {
        log.append('cycle-1', 'phase_transition', 'orchestrator', { phase: 'architect' });
        log.append('cycle-1', 'phase_transition', 'orchestrator', { phase: 'operator' });
        log.append('cycle-1', 'phase_transition', 'orchestrator', { phase: 'verifier' });

        const trail = log.trail('cycle-1');
        expect(trail).toHaveLength(3);
        expect(trail[0].kind).toBe('phase_transition');
        expect(trail[0].payload.phase).toBe('architect');
        expect(trail[1].payload.phase).toBe('operator');
        expect(trail[2].payload.phase).toBe('verifier');
    });

    it('assigns sequential seq numbers per cycle', () => {
        log.append('cycle-1', 'task_claimed', 'nyx', { chairId: 'nyx' });
        log.append('cycle-1', 'task_running', 'nyx', { chairId: 'nyx' });
        log.append('cycle-2', 'task_claimed', 'shaev', { chairId: 'shaev' });

        const trail1 = log.trail('cycle-1');
        expect(trail1[0].seq).toBe(0);
        expect(trail1[1].seq).toBe(1);

        const trail2 = log.trail('cycle-2');
        expect(trail2[0].seq).toBe(0);
    });

    it('returns empty trail for unknown cycle', () => {
        expect(log.trail('nonexistent')).toEqual([]);
    });

    it('seals a cycle with Merkle root', () => {
        log.append('cycle-1', 'phase_transition', 'orchestrator', { phase: 'architect' });
        log.append('cycle-1', 'dispatch_reply', 'nyx', { text: 'done' });

        const receipt = log.sealCycle('cycle-1');
        expect(receipt.cycleId).toBe('cycle-1');
        expect(receipt.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.eventCount).toBe(2);
    });

    it('produces a valid 64-char hex Merkle root', () => {
        log.append('c1', 'cycle_started', 'orchestrator', { x: 1 });
        log.append('c1', 'dispatch_reply', 'nyx', { y: 2 });
        const r1 = log.sealCycle('c1');

        expect(r1.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
        expect(r1.eventCount).toBe(2);

        // Sealing again on a different cycle with different data produces a different root.
        log.append('c2', 'cycle_started', 'orchestrator', { z: 99 });
        const r2 = log.sealCycle('c2');
        expect(r2.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
        // Different payloads → different root (overwhelmingly likely).
        expect(r1.merkleRoot).not.toBe(r2.merkleRoot);
    });

    it('signs and verifies receipts with ed25519', () => {
        log.append('c1', 'cycle_started', 'orchestrator', {});
        const receipt = log.sealCycle('c1');

        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const signature = CycleLog.signReceipt(receipt, privateKey);

        expect(signature).toBeDefined();
        expect(CycleLog.verifyReceipt(receipt, signature, publicKey)).toBe(true);
    });

    it('rejects tampered receipts', () => {
        log.append('c1', 'cycle_started', 'orchestrator', {});
        const receipt = log.sealCycle('c1');

        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const signature = CycleLog.signReceipt(receipt, privateKey);

        // Tamper with the Merkle root
        const tampered = { ...receipt, merkleRoot: '0'.repeat(64) };
        expect(CycleLog.verifyReceipt(tampered, signature, publicKey)).toBe(false);
    });

    it('replays open cycles', () => {
        log.append('c1', 'phase_transition', 'orchestrator', { phase: 'architect' });
        log.append('c1', 'phase_transition', 'orchestrator', { phase: 'operator' });
        log.sealCycle('c1'); // sealed = closed

        log.append('c2', 'phase_transition', 'orchestrator', { phase: 'architect' });
        // c2 is NOT sealed = open

        const open = log.replayOpenCycles();
        expect(open).toHaveLength(1);
        expect(open[0].cycleId).toBe('c2');
        expect(open[0].eventCount).toBe(1);
    });

    it('totalEvents returns count across all cycles', () => {
        log.append('c1', 'cycle_started', 'orchestrator', {});
        log.append('c1', 'dispatch_reply', 'nyx', {});
        log.append('c2', 'cycle_started', 'orchestrator', {});
        expect(log.totalEvents()).toBe(3);
    });
});
