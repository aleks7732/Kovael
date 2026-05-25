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
import type { RetryQueue } from './RetryQueue.js';
import type { Reconciler } from './Reconciler.js';
import type { WorkspaceManager } from './WorkspaceManager.js';
import type { HookRunner } from './HookRunner.js';
import type { WorkflowLoader } from './WorkflowLoader.js';
import type { RateLimitTracker } from './RateLimitTracker.js';
import type { TracingBridge } from './Tracing.js';
import type { ResourceGovernor } from './ResourceGovernor.js';
import type { AgentRuntimeSupervisor } from './AgentRuntimeSupervisor.js';
import type { WebSocketServer } from 'ws';

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

    // --- Services accessed by HttpApiRouter (previously `as any`) ---
    readonly retryQueue: RetryQueue;
    readonly reconciler: Reconciler;
    readonly workspaces: WorkspaceManager;
    readonly hooks: HookRunner;
    readonly workflowLoader: WorkflowLoader;
    readonly rateLimits: RateLimitTracker;
    readonly tracing?: TracingBridge;
    readonly resourceGovernor: ResourceGovernor;
    readonly agentRuntimeSupervisor: AgentRuntimeSupervisor;
    readonly wss: WebSocketServer;

    // --- Inter-agent chat state (accessed by WebSocketBus) ---
    interAgentChatEnabled: boolean;
    interAgentChatMode: 'technical' | 'interests';
    startInterAgentChatLoop(): void;
    stopInterAgentChatLoop(): void;
    triggerInterAgentChat(): void;

    // --- EventEmitter surface (used by WebSocketBus.handleTelemetry) ---
    emit(event: string, ...args: any[]): boolean;

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
