import type { DatabaseSync } from 'node:sqlite';
import type { ChairRegistry } from './ChairRegistry.js';
import type { ConversationBus } from './ConversationBus.js';
import type { TaskClaimMachine } from '../protocols/TaskClaimMachine.js';
import type { CircuitBreaker } from './CircuitBreaker.js';
import type { LearningMatrix } from './LearningMatrix.js';
import type { SelfHealer } from './SelfHealer.js';
import type { ComfyUiBridge } from './ComfyUiBridge.js';
import type { PhaseEvent } from '../protocols/TriadStateMachine.js';
import type { VramMetrics } from './HardwareMonitor.js';
import type { Logger } from './Logger.js';
import type { ApiTokenGate } from './ApiTokenGate.js';
import type { RateLimiter } from './RateLimiter.js';
import type { HealthEndpoints } from './HealthEndpoints.js';
import type { MevHandshake } from './MevHandshake.js';
import type { MevBridge } from '../MevBridge.js';
import type { SemanticIngestor } from './SemanticIngestor.js';

export interface OrchestratorContext {
    readonly memoryDb: DatabaseSync;
    readonly chairs: ChairRegistry;
    readonly conversationBus: ConversationBus;
    readonly claims: TaskClaimMachine;
    readonly circuitBreaker: CircuitBreaker;
    readonly learningMatrix: LearningMatrix;
    readonly selfHealer: SelfHealer;
    readonly comfyBridge: ComfyUiBridge;
    readonly apiGate: ApiTokenGate;
    readonly rateLimiter: RateLimiter;
    readonly health: HealthEndpoints;
    readonly handshake: MevHandshake;
    readonly mevBridge: MevBridge;
    readonly ingestor: SemanticIngestor;
    readonly log: Logger;
    readonly maxWsMessageBytes: number;

    // Orchestrator caches and mutable state
    agentCards: any[];
    readonly nodeCache: Map<string, any>;
    taskCache: any[];
    hardwareCache: VramMetrics | null;
    readonly activeCycles: Map<string, PhaseEvent>;
    tokenTotals: {
        input: number;
        output: number;
        total: number;
        runtimeMs: number;
        cycles: number;
    };
    receiptsIssued: number;

    // Operations
    broadcast(msg: any): void;
    injectTask(goal: string, parentTrace?: { traceparent?: string; tracestate?: string }): Promise<any>;
}
