import { EventEmitter } from 'node:events';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
    failureThreshold: number;
    recoveryMs: number;
}

export interface ChairCircuitSnapshot {
    agentId: string;
    state: CircuitState;
    failures: number;
    openedAt?: number;
    lastReason?: string;
}

export interface ChairCircuitEvent extends ChairCircuitSnapshot {
    type: 'chair.circuit_open' | 'chair.circuit_recovered' | 'chair.circuit_half_open' | 'chair.circuit_failure';
    timestamp: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 3,
    recoveryMs: 30_000,
};

export class CircuitBreaker extends EventEmitter {
    private readonly cfg: CircuitBreakerConfig;
    private readonly circuits = new Map<string, ChairCircuitSnapshot>();

    constructor(config: Partial<CircuitBreakerConfig> = {}) {
        super();
        this.cfg = { ...DEFAULT_CONFIG, ...config };
    }

    public canDispatch(agentId: string, now = Date.now()): boolean {
        const circuit = this.ensure(agentId);
        if (circuit.state !== 'open') return true;
        if (circuit.openedAt !== undefined && now - circuit.openedAt >= this.cfg.recoveryMs) {
            circuit.state = 'half_open';
            this.emitCircuit('chair.circuit_half_open', circuit, now);
            return true;
        }
        return false;
    }

    public recordFailure(agentId: string, reason: string, now = Date.now()): ChairCircuitSnapshot {
        const circuit = this.ensure(agentId);
        circuit.failures += 1;
        circuit.lastReason = reason.slice(0, 240);
        if (circuit.failures >= this.cfg.failureThreshold) {
            circuit.state = 'open';
            circuit.openedAt = now;
            this.emitCircuit('chair.circuit_open', circuit, now);
        } else {
            this.emitCircuit('chair.circuit_failure', circuit, now);
        }
        return { ...circuit };
    }

    public recordSuccess(agentId: string, now = Date.now()): ChairCircuitSnapshot {
        const circuit = this.ensure(agentId);
        const wasOpen = circuit.state !== 'closed' || circuit.failures > 0;
        circuit.state = 'closed';
        circuit.failures = 0;
        circuit.openedAt = undefined;
        circuit.lastReason = undefined;
        if (wasOpen) this.emitCircuit('chair.circuit_recovered', circuit, now);
        return { ...circuit };
    }

    public snapshot(): ChairCircuitSnapshot[] {
        return Array.from(this.circuits.values()).map((circuit) => ({ ...circuit }));
    }

    private ensure(agentId: string): ChairCircuitSnapshot {
        const existing = this.circuits.get(agentId);
        if (existing) return existing;
        const created: ChairCircuitSnapshot = { agentId, state: 'closed', failures: 0 };
        this.circuits.set(agentId, created);
        return created;
    }

    private emitCircuit(type: ChairCircuitEvent['type'], circuit: ChairCircuitSnapshot, timestamp: number): void {
        this.emit('circuit_event', { ...circuit, type, timestamp } satisfies ChairCircuitEvent);
    }
}
