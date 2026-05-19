import { EventEmitter } from 'node:events';

/**
 * TriadPhase: the formal lifecycle of a single Architect→Operator→Verifier cycle.
 *
 * Inspired by the 11-phase run-attempt model in OpenAI's Symphony SPEC.md
 * (https://github.com/openai/symphony, Apache-2.0). Symphony covers a single
 * coding agent's lifecycle; Kovael's Triad splits one cycle across three
 * roles (Architect / Operator / Verifier) and folds Symphony's phases into
 * dispatch + streaming pairs per role. Every cycle MUST traverse these
 * phases in order; terminal phases cannot be transitioned out of.
 */
export enum TriadPhase {
    PreparingContext = 'PreparingContext',
    DispatchToArchitect = 'DispatchToArchitect',
    ArchitectStreaming = 'ArchitectStreaming',
    DispatchToOperator = 'DispatchToOperator',
    OperatorExecuting = 'OperatorExecuting',
    DispatchToVerifier = 'DispatchToVerifier',
    VerifierAuditing = 'VerifierAuditing',
    IssuingReceipt = 'IssuingReceipt',
    Succeeded = 'Succeeded',
    Failed = 'Failed',
    Stalled = 'Stalled',
}

const TERMINAL = new Set<TriadPhase>([
    TriadPhase.Succeeded,
    TriadPhase.Failed,
    TriadPhase.Stalled,
]);

const NEXT: Record<TriadPhase, TriadPhase[]> = {
    [TriadPhase.PreparingContext]: [TriadPhase.DispatchToArchitect, TriadPhase.Failed, TriadPhase.Stalled],
    [TriadPhase.DispatchToArchitect]: [TriadPhase.ArchitectStreaming, TriadPhase.Failed, TriadPhase.Stalled],
    [TriadPhase.ArchitectStreaming]: [TriadPhase.DispatchToOperator, TriadPhase.Failed, TriadPhase.Stalled],
    [TriadPhase.DispatchToOperator]: [TriadPhase.OperatorExecuting, TriadPhase.Failed, TriadPhase.Stalled],
    [TriadPhase.OperatorExecuting]: [TriadPhase.DispatchToVerifier, TriadPhase.Failed, TriadPhase.Stalled],
    [TriadPhase.DispatchToVerifier]: [TriadPhase.VerifierAuditing, TriadPhase.Failed, TriadPhase.Stalled],
    [TriadPhase.VerifierAuditing]: [TriadPhase.IssuingReceipt, TriadPhase.Failed, TriadPhase.Stalled],
    [TriadPhase.IssuingReceipt]: [TriadPhase.Succeeded, TriadPhase.Failed],
    [TriadPhase.Succeeded]: [],
    [TriadPhase.Failed]: [],
    [TriadPhase.Stalled]: [],
};

export interface PhaseEvent {
    cycleId: string;
    taskHash: string;
    phase: TriadPhase;
    previous: TriadPhase | null;
    timestamp: number;
    routedAgent?: string;
    note?: string;
}

/**
 * TriadStateMachine: enforces legal phase transitions for a single cycle and
 * emits structured observability events. Every transition carries the cycle
 * context fields (cycleId, taskHash, phase) — Symphony-style.
 */
export class TriadStateMachine extends EventEmitter {
    private phase: TriadPhase = TriadPhase.PreparingContext;
    public readonly cycleId: string;
    public readonly taskHash: string;
    private readonly history: PhaseEvent[] = [];

    constructor(cycleId: string, taskHash: string) {
        super();
        this.cycleId = cycleId;
        this.taskHash = taskHash;
        this.history.push({
            cycleId,
            taskHash,
            phase: this.phase,
            previous: null,
            timestamp: Date.now(),
        });
    }

    public current(): TriadPhase {
        return this.phase;
    }

    public isTerminal(): boolean {
        return TERMINAL.has(this.phase);
    }

    public canTransition(next: TriadPhase): boolean {
        return NEXT[this.phase].includes(next);
    }

    public transition(next: TriadPhase, meta?: { routedAgent?: string; note?: string }): PhaseEvent {
        if (!this.canTransition(next)) {
            throw new Error(`[TriadStateMachine] Illegal transition ${this.phase} → ${next} (cycle ${this.cycleId})`);
        }
        const event: PhaseEvent = {
            cycleId: this.cycleId,
            taskHash: this.taskHash,
            phase: next,
            previous: this.phase,
            timestamp: Date.now(),
            routedAgent: meta?.routedAgent,
            note: meta?.note,
        };
        this.phase = next;
        this.history.push(event);
        this.emit('phase_change', event);
        return event;
    }

    public trail(): PhaseEvent[] {
        return [...this.history];
    }
}
