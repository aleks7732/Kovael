import { describe, it, expect, vi } from 'vitest';
import { TriadStateMachine, TriadPhase } from '../protocols/TriadStateMachine.js';
import type { PhaseEvent } from '../protocols/TriadStateMachine.js';

// Helpers ------------------------------------------------------------------

function newMachine(id = 'cycle-abc', hash = 'deadbeef'): TriadStateMachine {
    return new TriadStateMachine(id, hash);
}

// Full happy-path sequence from PreparingContext → Succeeded
const HAPPY_PATH: TriadPhase[] = [
    TriadPhase.DispatchToArchitect,
    TriadPhase.ArchitectStreaming,
    TriadPhase.DispatchToOperator,
    TriadPhase.OperatorExecuting,
    TriadPhase.DispatchToVerifier,
    TriadPhase.VerifierAuditing,
    TriadPhase.IssuingReceipt,
    TriadPhase.Succeeded,
];

// Tests --------------------------------------------------------------------

describe('TriadStateMachine — initial state', () => {
    it('starts in PreparingContext', () => {
        expect(newMachine().current()).toBe(TriadPhase.PreparingContext);
    });

    it('exposes cycleId and taskHash', () => {
        const m = newMachine('my-cycle', 'abc123');
        expect(m.cycleId).toBe('my-cycle');
        expect(m.taskHash).toBe('abc123');
    });

    it('is not terminal on construction', () => {
        expect(newMachine().isTerminal()).toBe(false);
    });

    it('trail() has exactly one entry (the initial phase)', () => {
        const trail = newMachine().trail();
        expect(trail).toHaveLength(1);
        expect(trail[0].phase).toBe(TriadPhase.PreparingContext);
        expect(trail[0].previous).toBeNull();
    });
});

describe('TriadStateMachine — valid transitions', () => {
    it('traverses the full happy-path to Succeeded', () => {
        const m = newMachine();
        for (const phase of HAPPY_PATH) {
            m.transition(phase);
        }
        expect(m.current()).toBe(TriadPhase.Succeeded);
        expect(m.isTerminal()).toBe(true);
    });

    it('can short-circuit to Failed from any non-terminal phase', () => {
        for (const startPhase of [
            TriadPhase.PreparingContext,
            TriadPhase.DispatchToArchitect,
            TriadPhase.OperatorExecuting,
            TriadPhase.VerifierAuditing,
        ]) {
            const m = new TriadStateMachine(`cycle-${startPhase}`, 'hash');
            // Fast-forward to startPhase
            const pathTo = HAPPY_PATH.slice(0, HAPPY_PATH.indexOf(startPhase));
            for (const p of pathTo) m.transition(p);

            expect(m.canTransition(TriadPhase.Failed)).toBe(true);
            m.transition(TriadPhase.Failed);
            expect(m.isTerminal()).toBe(true);
        }
    });

    it('can short-circuit to Stalled (except from IssuingReceipt)', () => {
        const m = newMachine();
        expect(m.canTransition(TriadPhase.Stalled)).toBe(true);
        m.transition(TriadPhase.Stalled);
        expect(m.isTerminal()).toBe(true);
    });

    it('transition() returns a PhaseEvent with correct fields', () => {
        const before = Date.now();
        const m = newMachine('cid', 'thash');
        const evt = m.transition(TriadPhase.DispatchToArchitect, {
            routedAgent: 'nyx-cli',
            note: 'routed ok',
        });

        expect(evt.cycleId).toBe('cid');
        expect(evt.taskHash).toBe('thash');
        expect(evt.phase).toBe(TriadPhase.DispatchToArchitect);
        expect(evt.previous).toBe(TriadPhase.PreparingContext);
        expect(evt.routedAgent).toBe('nyx-cli');
        expect(evt.note).toBe('routed ok');
        expect(evt.timestamp).toBeGreaterThanOrEqual(before);
    });
});

describe('TriadStateMachine — illegal transitions', () => {
    it('throws on a backwards transition', () => {
        const m = newMachine();
        m.transition(TriadPhase.DispatchToArchitect);
        expect(() => m.transition(TriadPhase.PreparingContext)).toThrow(
            /Illegal transition/,
        );
    });

    it('throws when trying to skip a phase', () => {
        const m = newMachine();
        expect(() => m.transition(TriadPhase.OperatorExecuting)).toThrow(
            /Illegal transition/,
        );
    });

    it('throws when transitioning out of a terminal Succeeded state', () => {
        const m = newMachine();
        for (const p of HAPPY_PATH) m.transition(p);
        expect(() => m.transition(TriadPhase.Failed)).toThrow(/Illegal transition/);
    });

    it('throws when transitioning out of a terminal Failed state', () => {
        const m = newMachine();
        m.transition(TriadPhase.Failed);
        expect(() => m.transition(TriadPhase.Stalled)).toThrow(/Illegal transition/);
    });

    it('does not mutate phase on an illegal transition attempt', () => {
        const m = newMachine();
        try {
            m.transition(TriadPhase.Succeeded);
        } catch {
            // expected
        }
        expect(m.current()).toBe(TriadPhase.PreparingContext);
    });
});

describe('TriadStateMachine — events', () => {
    it('emits a phase_change event on every successful transition', () => {
        const m = newMachine();
        const events: PhaseEvent[] = [];
        m.on('phase_change', (e: PhaseEvent) => events.push(e));

        m.transition(TriadPhase.DispatchToArchitect);
        m.transition(TriadPhase.ArchitectStreaming);

        expect(events).toHaveLength(2);
        expect(events[0].phase).toBe(TriadPhase.DispatchToArchitect);
        expect(events[1].phase).toBe(TriadPhase.ArchitectStreaming);
    });

    it('does NOT emit an event on an illegal transition', () => {
        const m = newMachine();
        const handler = vi.fn();
        m.on('phase_change', handler);

        try { m.transition(TriadPhase.Succeeded); } catch { /* expected */ }

        expect(handler).not.toHaveBeenCalled();
    });
});

describe('TriadStateMachine — trail()', () => {
    it('grows by one entry per transition', () => {
        const m = newMachine();
        m.transition(TriadPhase.DispatchToArchitect);
        m.transition(TriadPhase.ArchitectStreaming);

        // 1 (initial) + 2 transitions
        expect(m.trail()).toHaveLength(3);
    });

    it('returns a defensive copy — mutating the result does not affect internal history', () => {
        const m = newMachine();
        const trail = m.trail();
        trail.push({} as PhaseEvent);

        expect(m.trail()).toHaveLength(1);
    });

    it('records phases in transition order', () => {
        const m = newMachine();
        m.transition(TriadPhase.DispatchToArchitect);
        m.transition(TriadPhase.Failed);

        const phases = m.trail().map((e) => e.phase);
        expect(phases).toEqual([
            TriadPhase.PreparingContext,
            TriadPhase.DispatchToArchitect,
            TriadPhase.Failed,
        ]);
    });
});

describe('TriadStateMachine — canTransition()', () => {
    it('returns true for all legal next phases', () => {
        const m = newMachine();
        expect(m.canTransition(TriadPhase.DispatchToArchitect)).toBe(true);
        expect(m.canTransition(TriadPhase.Failed)).toBe(true);
        expect(m.canTransition(TriadPhase.Stalled)).toBe(true);
    });

    it('returns false for illegal phases', () => {
        const m = newMachine();
        expect(m.canTransition(TriadPhase.Succeeded)).toBe(false);
        expect(m.canTransition(TriadPhase.VerifierAuditing)).toBe(false);
    });

    it('returns false for every phase once terminal', () => {
        const m = newMachine();
        m.transition(TriadPhase.Stalled);
        for (const phase of Object.values(TriadPhase)) {
            expect(m.canTransition(phase)).toBe(false);
        }
    });
});
