import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { MevBridge, VerificationReceipt } from './MevBridge.js';
import { MevHandshake } from './services/MevHandshake.js';
import { SemanticIngestor } from './services/SemanticIngestor.js';
import { HardwareMonitor, VramMetrics } from './services/HardwareMonitor.js';
import { PhaseEvent } from './protocols/TriadStateMachine.js';
import { TaskClaimMachine, ClaimEvent, ClaimState } from './protocols/TaskClaimMachine.js';
import { RetryQueue, RetryDispatch, RetryConfig } from './services/RetryQueue.js';
import { Reconciler, ReconcileAction, ReconcilerConfig } from './services/Reconciler.js';
import { WorkspaceManager } from './services/WorkspaceManager.js';
import { HookRunner, HookResult } from './services/HookRunner.js';
import { WorkflowLoader, WorkflowDocument } from './services/WorkflowLoader.js';
import { RateLimitTracker, AgentRateSnapshot } from './services/RateLimitTracker.js';
import { ChairRegistry, ChairEvent, ChairRegistryConfig } from './services/ChairRegistry.js';
import { Logger, rootLogger } from './services/Logger.js';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { AgentCards } from './AgentCards.js';
import { PersonaLoader } from './services/PersonaLoader.js';
import { ConversationBus } from './services/ConversationBus.js';
import { ApiTokenGate } from './services/ApiTokenGate.js';
import { RateLimiter, RateLimiterConfig } from './services/RateLimiter.js';
import { HealthEndpoints } from './services/HealthEndpoints.js';
import { openOrchestratorDb } from './services/OrchestratorDb.js';
import { TracingBridge } from './services/Tracing.js';
import { CycleLog } from './services/CycleLog.js';
import { readBooleanEnv } from './common/env-helpers.js';
import { CircuitBreaker, ChairCircuitEvent } from './services/CircuitBreaker.js';
import { LearningMatrix } from './services/LearningMatrix.js';
import { SelfHealer, SelfHealEvent } from './services/SelfHealer.js';
import { ComfyUiBridge } from './services/ComfyUiBridge.js';
import { enrichWithAgUi } from './services/AgUiEventStream.js';
import { OrchestratorContext } from './services/OrchestratorContext.js';
import { HttpApiRouter, HttpTimeouts, DEFAULT_HTTP_TIMEOUTS } from './services/HttpApiRouter.js';
import { WebSocketBus } from './services/WebSocketBus.js';
import { InterAgentChatManager } from './services/InterAgentChatManager.js';
import { ResourceGovernor, ResourceModeChange } from './services/ResourceGovernor.js';
import { AgentRuntimeSupervisor, AgentRuntimeSupervisorConfig } from './services/AgentRuntimeSupervisor.js';
import { RemoteAccessMode, resolveBindHost } from './services/BindHostSecurity.js';
import { loadChairManifests } from './services/runtime/ChairManifestLoader.js';

export { HttpTimeouts, DEFAULT_HTTP_TIMEOUTS };

export interface OrchestratorResourceModeConfig {
    enabled?: boolean;
    idleAfterMs?: number;
    sweepIntervalMs?: number;
    idleTaskCacheRetain?: number;
    idleTraceRetain?: number;
}

export interface OrchestratorConfig {
    retryQueue?: Partial<RetryConfig>;
    reconciler?: Partial<ReconcilerConfig>;
    chairRegistry?: Partial<ChairRegistryConfig>;
    httpTimeouts?: Partial<HttpTimeouts>;
    minReadyChairs?: number;
    dbPath?: string;
    rateLimit?: Partial<RateLimiterConfig>;
    resourceMode?: Partial<OrchestratorResourceModeConfig>;
    agentRuntimes?: Partial<AgentRuntimeSupervisorConfig>;
    bindHost?: string;
}

const DEFAULT_RESOURCE_MODE_CONFIG: Required<OrchestratorResourceModeConfig> = {
    enabled: true,
    idleAfterMs: 10 * 60 * 1000,
    sweepIntervalMs: 5_000,
    idleTaskCacheRetain: 20,
    idleTraceRetain: 20,
};

/** Upper bound on the live phase-event map; the oldest cycle is evicted past this. */
const MAX_ACTIVE_CYCLES = 512;

export class MeshOrchestrator extends EventEmitter implements OrchestratorContext {
    public readonly memoryDb: DatabaseSync;
    public readonly chairs: ChairRegistry;
    public readonly conversationBus: ConversationBus;
    public readonly claims: TaskClaimMachine;
    public readonly circuitBreaker: CircuitBreaker;
    public readonly learningMatrix: LearningMatrix;
    public readonly selfHealer: SelfHealer;
    public readonly comfyBridge: ComfyUiBridge;
    public readonly apiGate: ApiTokenGate;
    public readonly rateLimiter: RateLimiter;
    public readonly health: HealthEndpoints;
    public readonly handshake: MevHandshake;
    public readonly mevBridge: MevBridge;
    public readonly ingestor: SemanticIngestor;
    public readonly log: Logger = rootLogger;
    public readonly maxWsMessageBytes: number = 5 * 1024 * 1024;
    public readonly resourceGovernor: ResourceGovernor;
    public readonly agentRuntimeSupervisor: AgentRuntimeSupervisor;
    public readonly bindHost: string;
    public readonly remoteAccessMode: RemoteAccessMode;

    // Caches and state variables
    public agentCards: any[] = [];
    public readonly nodeCache: Map<string, any> = new Map();
    public taskCache: any[] = [];
    public hardwareCache: VramMetrics | null = null;
    public readonly activeCycles: Map<string, PhaseEvent> = new Map();
    public tokenTotals = { input: 0, output: 0, total: 0, runtimeMs: 0, cycles: 0 };
    public receiptsIssued: number = 0;
    public readonly chairDispatchMetrics = {
        attempts: 0,
        retries: 0,
        accepted: 0,
        successes: 0,
        failures: 0,
        inflight: 0,
    };

    private readonly server: http.Server;
    private readonly wsBus: WebSocketBus;
    private readonly apiRouter: HttpApiRouter;
    private readonly resourceModeConfig: Required<OrchestratorResourceModeConfig>;
    private boundPort: number;

    public get wss() {
        return this.wsBus.wss;
    }

    public retryQueue: RetryQueue;
    public reconciler: Reconciler;
    public workspaces: WorkspaceManager;
    public hooks: HookRunner;
    public workflowLoader: WorkflowLoader;
    public personaLoader: PersonaLoader;
    public rateLimits: RateLimitTracker;
    public tracing?: TracingBridge;
    private cycleLog: CycleLog;
    private hardware: HardwareMonitor;
    private readonly activeChairDispatches: Set<string> = new Set();

    // Inter-agent chat — extracted to InterAgentChatManager (Batch 3).
    private readonly chatManager: InterAgentChatManager;

    public get interAgentChatEnabled(): boolean { return this.chatManager.enabled; }
    public set interAgentChatEnabled(v: boolean) { this.chatManager.enabled = v; }
    public get interAgentChatMode(): 'technical' | 'interests' { return this.chatManager.mode; }
    public set interAgentChatMode(v: 'technical' | 'interests') { this.chatManager.mode = v; }

    constructor(port: number, cfg: OrchestratorConfig = {}) {
        super();
        this.boundPort = port;
        const bind = resolveBindHost(cfg.bindHost ?? process.env.KOVAEL_BIND_HOST);
        this.bindHost = bind.bindHost;
        this.remoteAccessMode = bind.remoteAccessMode;
        this.handshake = new MevHandshake();
        this.apiGate = new ApiTokenGate();
        this.rateLimiter = new RateLimiter(cfg.rateLimit ?? {});

        const { db: orchestratorDb } = openOrchestratorDb({ path: cfg.dbPath });
        this.memoryDb = orchestratorDb;
        this.ingestor = new SemanticIngestor(this.memoryDb);
        this.mevBridge = new MevBridge(':memory:');
        this.personaLoader = new PersonaLoader();
        this.personaLoader.start();
        this.mevBridge.setPersonaLoader(this.personaLoader);
        this.hardware = new HardwareMonitor(2000);
        this.claims = new TaskClaimMachine();
        this.retryQueue = new RetryQueue(this.claims, cfg.retryQueue ?? {});
        this.retryQueue.bind((goal) => this.injectTask(goal));
        this.reconciler = new Reconciler(this.claims, cfg.reconciler ?? {});
        this.workspaces = new WorkspaceManager();
        this.hooks = new HookRunner();
        this.workflowLoader = new WorkflowLoader();
        this.rateLimits = new RateLimitTracker();
        this.chairs = new ChairRegistry(cfg.chairRegistry ?? {}, this.memoryDb);
        this.conversationBus = new ConversationBus(
            this.memoryDb,
            this.chairs,
            this.personaLoader,
            port
        );
        this.mevBridge.setRateLimitTracker(this.rateLimits);

        this.tracing = new TracingBridge();
        this.tracing.start().then((ok) => {
            if (ok) {
                this.mevBridge.setTracingBridge(this.tracing!);
                this.log.info('tracing_ready', { exporter: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'otlp_http' : 'ring_buffer_only' });
            }
        }).catch((err) => {
            this.log.error('tracing_init_failed', {
                error: err instanceof Error ? err.message : String(err),
                exporter: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'otlp_http' : 'ring_buffer_only',
            });
        });

        this.cycleLog = new CycleLog(this.memoryDb);
        this.circuitBreaker = new CircuitBreaker();
        this.learningMatrix = new LearningMatrix();
        this.selfHealer = new SelfHealer({
            repoRoot: process.cwd(),
            autoApply: process.env.KOVAEL_SELF_HEAL_AUTO_APPLY === '1',
            allowedBranchPrefixes: ['stage4/', 'self-heal/'],
        });
        this.comfyBridge = new ComfyUiBridge();
        this.chatManager = new InterAgentChatManager(
            this.conversationBus,
            (payload) => this.broadcast(payload),
        );
        this.conversationBus.setDispatchGate((agentId) => this.circuitBreaker.canDispatch(agentId));

        this.resourceModeConfig = resolveResourceModeConfig(cfg.resourceMode ?? {});
        this.resourceGovernor = new ResourceGovernor({
            enabled: this.resourceModeConfig.enabled,
            idleAfterMs: this.resourceModeConfig.idleAfterMs,
            sweepIntervalMs: this.resourceModeConfig.sweepIntervalMs,
            isBusy: () => this.hasInteractiveWork(),
            onEnterIdle: (event) => this.enterLightweightMode(event),
            onEnterActive: (event) => this.enterActiveMode(event),
        });
        this.agentRuntimeSupervisor = cfg.agentRuntimes
            ? new AgentRuntimeSupervisor({
                cwd: process.cwd(),
                logger: this.log,
                ...cfg.agentRuntimes,
            })
            : AgentRuntimeSupervisor.fromEnvironment({
                cwd: process.cwd(),
                logger: this.log,
            });

        this.health = new HealthEndpoints(
            () => ({
                chairsActive: this.chairs.stats().online,
                topicsActive: this.conversationBus.activeTopicCount(),
                chairDispatch: { ...this.chairDispatchMetrics },
            }),
            { minReadyChairs: cfg.minReadyChairs },
        );

        this.loadAgentCards();

        // Instantiate refactored Http & WS adapters
        const timeouts = { ...DEFAULT_HTTP_TIMEOUTS, ...(cfg.httpTimeouts ?? {}) };
        this.apiRouter = new HttpApiRouter(this, timeouts);
        this.server = this.apiRouter.createServer();
        this.wsBus = new WebSocketBus(this, this.server);

        this.initializeBus();
        this.wireHardware();
        this.wireMevBridge();
        this.wireClaims();
        this.wireRetryQueue();
        this.wireReconciler();
        this.wireHooks();
        this.wireChairs();
        this.wireCircuitBreaker();
        this.wireSelfHealer();

        this.retryQueue.start();
        this.reconciler.start();
        this.registerDefaultHooks();
        this.wireWorkflowLoader();
        this.wireRateLimits();
        this.workflowLoader.start();
        this.chairs.start();

        this.server.listen(port, this.bindHost, () => {
            const addr = this.server.address();
            const boundPort = addr && typeof addr === 'object' ? addr.port : port;
            this.boundPort = boundPort;
            this.conversationBus.orchestratorPort = boundPort;
            this.log.info('orchestrator_listening', {
                port: boundPort,
                bind_host: this.bindHost,
                remote_access_mode: this.remoteAccessMode,
                surfaces: ['ws', 'sse', '/api/v1/state', '/livez', '/readyz', '/metrics'],
            });
            this.agentRuntimeSupervisor.start(boundPort, 'orchestrator_listening');
        });

        this.hardware.start();
        this.resourceGovernor.start();
        this.triggerIngest();

        this.health.setReady();
    }

    public broadcast(payload: any) {
        this.wsBus.broadcast(payload);
    }

    private wireHardware() {
        this.hardware.on('vram_metrics', (metrics: VramMetrics) => {
            this.hardwareCache = metrics;
            this.mevBridge.setVramFree(metrics.freeMb, metrics.status === 'ok');
            this.broadcast({
                type: 'hardware_telemetry',
                nodeId: 'hardware-monitor',
                data: metrics,
            });
        });
    }

    private wireClaims() {
        this.claims.on('claim_event', (evt: ClaimEvent) => {
            this.broadcast({
                type: 'claim_event',
                nodeId: 'task-claim-machine',
                data: evt,
            });
        });
    }

    private wireChairs() {
        this.chairs.on('chair_event', (evt: ChairEvent) => {
            this.log.info('chair_event', {
                kind: evt.kind,
                agent_id: evt.agentId,
                session_id: evt.sessionId,
                status: evt.status,
                reason: evt.reason,
            });
            this.broadcast({
                type: 'chair_event',
                nodeId: 'chair-registry',
                data: evt,
            });
            if (evt.kind === 'expired' || evt.kind === 'stale') {
                this.circuitBreaker.recordFailure(evt.agentId, evt.reason ?? evt.kind);
            }
        });
    }

    private wireCircuitBreaker() {
        this.circuitBreaker.on('circuit_event', (evt: ChairCircuitEvent) => {
            this.log.warn('chair_circuit_event', {
                agent_id: evt.agentId,
                state: evt.state,
                failures: evt.failures,
                reason: evt.lastReason,
                circuit_type: evt.type,
            });
            this.broadcast({
                type: evt.type,
                nodeId: evt.agentId,
                data: evt,
            });
        });
    }

    private wireSelfHealer() {
        this.selfHealer.on('self_heal_event', (evt: SelfHealEvent) => {
            this.log.info('self_heal_event', {
                type: evt.type,
                cycle_id: evt.cycleId,
                task_hash: evt.taskHash,
                attempt: evt.attempt,
                reason: evt.reason,
            });
            this.broadcast({
                type: evt.type,
                nodeId: 'self-healer',
                data: evt,
            });
        });
    }

    private wireRateLimits() {
        this.rateLimits.on('rate_limit_update', (snapshot: AgentRateSnapshot) => {
            this.broadcast({
                type: 'rate_limit_update',
                nodeId: 'rate-limit-tracker',
                data: snapshot,
            });
        });
    }

    private wireWorkflowLoader() {
        this.workflowLoader.on('workflow_loaded', ({ document, firstLoad }: { document: WorkflowDocument; firstLoad: boolean }) => {
            this.log.info('workflow_loaded', {
                version: document.frontMatter.version,
                first_load: firstLoad,
                loaded_at: document.loadedAt,
            });

            const floor = document.frontMatter.routing?.vram_floor_mb;
            if (typeof floor === 'number') {
                this.mevBridge.setVramFloor(floor);
            }

            const primary = document.frontMatter.routing?.primary_architect;
            if (typeof primary === 'string') {
                this.mevBridge.setPrimaryArchitect(primary);
            }

            const fallback = document.frontMatter.routing?.fallback_agent;
            if (typeof fallback === 'string') {
                this.mevBridge.setFallbackAgent(fallback);
            }

            const turns = document.frontMatter.sharding?.keep_recent_turns;
            if (typeof turns === 'number') {
                this.mevBridge.setKeepRecentTurns(turns);
            }

            const retryCfg: Partial<RetryConfig> = {};
            if (typeof document.frontMatter.retry?.max_attempts === 'number') {
                retryCfg.maxAttempts = document.frontMatter.retry.max_attempts;
            }
            if (typeof document.frontMatter.retry?.backoff_base_ms === 'number') {
                retryCfg.baseMs = document.frontMatter.retry.backoff_base_ms;
            }
            if (typeof document.frontMatter.retry?.backoff_factor === 'number') {
                retryCfg.factor = document.frontMatter.retry.backoff_factor;
            }
            if (Object.keys(retryCfg).length > 0) {
                this.retryQueue.updateConfig(retryCfg);
            }

            this.broadcast({
                type: 'workflow_loaded',
                nodeId: 'workflow-loader',
                data: { version: document.frontMatter.version, firstLoad, loadedAt: document.loadedAt },
            });
        });
        this.workflowLoader.on('workflow_error', (payload: { error: string; keptKnownGood: boolean }) => {
            this.log.warn('workflow_reload_failed', {
                error: payload.error,
                kept_known_good: payload.keptKnownGood,
            });
            this.broadcast({
                type: 'workflow_error',
                nodeId: 'workflow-loader',
                data: payload,
            });
        });
    }

    private registerDefaultHooks() {
        const sentinel = (event: 'after_create' | 'before_run' | 'after_run' | 'before_remove') => ({
            name: `kovael.sentinel.${event}`,
            event,
            fn: (ctx: { cycleId: string; taskHash?: string }) => {
                this.log.info('hook_sentinel', {
                    hook_event: event,
                    cycle_id: ctx.cycleId,
                    task_hash: ctx.taskHash,
                });
            },
            timeoutMs: 5000,
        });
        this.hooks.register(sentinel('after_create'));
        this.hooks.register(sentinel('before_run'));
        this.hooks.register(sentinel('after_run'));
        this.hooks.register(sentinel('before_remove'));
    }

    private wireHooks() {
        this.hooks.on('hook_event', (r: HookResult) => {
            if (!r.success) {
                this.log.warn('hook_failed', {
                    hook: r.name,
                    event: r.event,
                    duration_ms: r.durationMs,
                    timed_out: r.timedOut,
                    error: r.error,
                });
            }
            this.broadcast({ type: 'hook_event', nodeId: 'hook-runner', data: r });
        });
    }

    private wireReconciler() {
        this.reconciler.on('reconcile_action', (action: ReconcileAction) => {
            if (action.kind === 'stall_detected') {
                this.log.warn('stall_released', {
                    task_hash: action.taskHash,
                    previous_state: action.previousState,
                    age_ms: action.ageMs,
                });
            }
            this.broadcast({
                type: 'reconcile_event',
                nodeId: 'reconciler',
                data: action,
            });
        });
    }

    private wireRetryQueue() {
        this.retryQueue.on('retry_scheduled', (d: RetryDispatch) => {
            this.log.info('retry_scheduled', {
                task_hash: d.taskHash,
                attempt: d.attempt,
                backoff_ms: d.backoffMs,
                reason: d.reason,
            });
            this.broadcast({ type: 'retry_event', nodeId: 'retry-queue', data: { kind: 'scheduled', dispatch: d } });
        });
        this.retryQueue.on('retry_dispatching', (d: RetryDispatch) => {
            this.broadcast({ type: 'retry_event', nodeId: 'retry-queue', data: { kind: 'dispatching', dispatch: d } });
        });
        this.retryQueue.on('retry_exhausted', (info: { taskHash: string; attempts: number; reason: string }) => {
            this.log.warn('retry_exhausted', {
                task_hash: info.taskHash,
                attempts: info.attempts,
                reason: info.reason,
            });
            this.broadcast({ type: 'retry_event', nodeId: 'retry-queue', data: { kind: 'exhausted', ...info } });
        });
    }

    private wireMevBridge() {
        this.mevBridge.on('phase_change', (evt: PhaseEvent) => {
            this.activeCycles.set(evt.cycleId, evt);
            // Bound the map (LRU-evict the oldest) so a long-running session — where
            // a connected WS client keeps idle-mode's clear() from firing — cannot
            // grow activeCycles per-cycle without bound.
            if (this.activeCycles.size > MAX_ACTIVE_CYCLES) {
                const oldest = this.activeCycles.keys().next().value;
                if (oldest !== undefined) this.activeCycles.delete(oldest);
            }
            this.broadcast({
                type: 'phase_change',
                nodeId: evt.routedAgent || 'triad',
                data: evt,
            });
        });
        this.mevBridge.on('cycle_complete', (receipt: VerificationReceipt) => {
            this.receiptsIssued += 1;
            if (receipt.tokens) {
                this.tokenTotals.input += receipt.tokens.input;
                this.tokenTotals.output += receipt.tokens.output;
                this.tokenTotals.total += receipt.tokens.total;
                this.tokenTotals.runtimeMs += receipt.tokens.runtimeMs;
                this.tokenTotals.cycles += 1;
                this.broadcast({
                    type: 'token_update',
                    nodeId: 'mev-bridge',
                    data: {
                        cycle: receipt.tokens,
                        totals: { ...this.tokenTotals },
                    },
                });
            }
            this.broadcast({
                type: 'verification_receipt',
                nodeId: receipt.architectId,
                data: receipt,
            });
            try {
                this.learningMatrix.record({
                    cycleId: receipt.cycleId,
                    taskHash: receipt.taskHash,
                    status: receipt.status,
                    latencyMs: receipt.tokens?.runtimeMs ?? 0,
                    tokenTotal: receipt.tokens?.total ?? 0,
                    confidence: receipt.status === 'verified' ? 0.95 : 0.25,
                    retryCount: 0,
                    recipeIds: [],
                    timestamp: receipt.timestamp,
                });
            } catch (err) {
                this.log.warn('learning_matrix_record_failed', {
                    error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
                });
            }
            if (receipt.status === 'failed') {
                this.selfHealer.repairFromReceipt(receipt).catch((err) => {
                    this.log.warn('self_heal_failed', {
                        cycle_id: receipt.cycleId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
            }
        });
    }

    private triggerIngest() {
        const rootPath = process.cwd();
        this.ingestor.ingest(rootPath);
    }

    private loadAgentCards() {
        const cardsDir = path.join(process.cwd(), 'agent_cards');
        const result = loadChairManifests(cardsDir);
        this.agentCards = result.cards;
        for (const err of result.errors) this.log.warn('agent_cards_invalid', { error: err });
        this.log.info(result.source === 'manifests' ? 'agent_cards_loaded' : 'agent_cards_loaded_fallback', { count: this.agentCards.length });
    }

    private initializeBus() {
        this.conversationBus.on('bus_event', (event) => {
            this.recordChairDispatchMetric(event);
            if (event?.type === 'chair_dispatch_failure' && typeof event.agentId === 'string') {
                this.circuitBreaker.recordFailure(event.agentId, String(event.reason ?? 'dispatch_failure'));
            } else if (event?.type === 'chair_dispatch_success' && typeof event.agentId === 'string') {
                this.circuitBreaker.recordSuccess(event.agentId);
            }
            this.broadcast(enrichWithAgUi(event));
        });
    }

    private recordChairDispatchMetric(event: unknown): void {
        if (!event || typeof event !== 'object') return;
        const payload = event as { type?: unknown; requestId?: unknown; attempt?: unknown };
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined;
        switch (payload.type) {
            case 'chair_dispatch_started':
                if (requestId) {
                    this.activeChairDispatches.add(requestId);
                    this.chairDispatchMetrics.inflight = this.activeChairDispatches.size;
                }
                break;
            case 'chair_dispatch_attempt':
                this.chairDispatchMetrics.attempts += 1;
                if (typeof payload.attempt === 'number' && payload.attempt > 1) {
                    this.chairDispatchMetrics.retries += 1;
                }
                break;
            case 'chair_dispatch_accepted':
                this.chairDispatchMetrics.accepted += 1;
                break;
            case 'chair_dispatch_success':
                this.chairDispatchMetrics.successes += 1;
                this.finishChairDispatchMetric(requestId);
                break;
            case 'chair_dispatch_failure':
                this.chairDispatchMetrics.failures += 1;
                this.finishChairDispatchMetric(requestId);
                break;
        }
    }

    private finishChairDispatchMetric(requestId?: string): void {
        if (requestId) {
            this.activeChairDispatches.delete(requestId);
        } else {
            const first = this.activeChairDispatches.values().next();
            if (!first.done) this.activeChairDispatches.delete(first.value);
        }
        this.chairDispatchMetrics.inflight = this.activeChairDispatches.size;
    }

    public async injectTask(goal: string): Promise<VerificationReceipt> {
        this.resourceGovernor.noteActivity('task:inject');
        const taskHash = crypto.createHash('sha256').update(goal).digest('hex');
        const cycleId = crypto.randomUUID();
        const cycleLog = this.log.scope({ cycle_id: cycleId, task_hash: taskHash });

        this.claims.register(taskHash, `inject:${goal.slice(0, 60)}`);
        const claimed = this.claims.tryClaim(taskHash, cycleId, 'orchestrator_inject');
        if (!claimed) {
            const current = this.claims.get(taskHash);
            cycleLog.warn('duplicate_dispatch_refused', { current_state: current?.state });
            throw new Error(`Task already in flight (state=${current?.state}); refusing duplicate dispatch.`);
        }

        cycleLog.info('claim_acquired', { goal_preview: goal.slice(0, 80) });
        this.claims.markRunning(taskHash, cycleId);

        let workspacePath: string | undefined;
        try {
            workspacePath = this.workspaces.acquire(cycleId);
        } catch (err) {
            cycleLog.warn('workspace_acquire_failed', { error: (err as Error).message });
        }

        const hookCtx = { cycleId, taskHash, workspacePath, goal };

        const afterCreate = await this.hooks.run('after_create', hookCtx);
        if (this.hooks.shouldAbort('after_create', afterCreate)) {
            if (workspacePath) this.workspaces.release(cycleId);
            this.claims.release(taskHash, 'hook_after_create_aborted');
            throw new Error('after_create hook aborted cycle');
        }

        const beforeRun = await this.hooks.run('before_run', hookCtx);
        if (this.hooks.shouldAbort('before_run', beforeRun)) {
            if (workspacePath) this.workspaces.release(cycleId);
            this.claims.release(taskHash, 'hook_before_run_aborted');
            throw new Error('before_run hook aborted cycle');
        }

        let receipt: VerificationReceipt;
        try {
            receipt = await this.mevBridge.execute(goal, [
                { role: 'system', content: 'You are Nyx, the Sovereign Intelligence.' },
                { role: 'user', content: `Execute goal: ${goal}` },
            ]);
        } catch (err) {
            const reason = `execute_threw:${(err as Error).message}`;
            this.retryQueue.enqueueFailure(taskHash, goal, reason);
            if (workspacePath) this.workspaces.release(cycleId);
            throw err;
        }

        await this.hooks.run('after_run', { ...hookCtx, receiptId: receipt.id, status: receipt.status });

        if (receipt.status === 'verified') {
            this.claims.release(taskHash, 'cycle_succeeded');
        } else {
            this.retryQueue.enqueueFailure(taskHash, goal, `cycle_failed:${receipt.id}`);
        }

        if (workspacePath) {
            await this.hooks.run('before_remove', hookCtx);
            this.workspaces.release(cycleId);
        }

        this.emit('task_routed', { goal, receipt });

        this.broadcast({
            type: 'new_task',
            task: {
                id: receipt.id,
                name: goal,
                status: receipt.status,
                receipt: receipt,
            },
        });

        return receipt;
    }

    public ready(): Promise<number> {
        return new Promise((resolve) => {
            const addr = this.server.address();
            if (addr && typeof addr === 'object') {
                resolve(addr.port);
            } else {
                this.server.once('listening', () => {
                    const a = this.server.address();
                    resolve(a && typeof a === 'object' ? a.port : 0);
                });
            }
        });
    }

    public startInterAgentChatLoop() {
        this.chatManager.start();
    }

    public stopInterAgentChatLoop() {
        this.chatManager.stop();
    }

    public triggerInterAgentChat() {
        this.chatManager.trigger();
    }

    public close() {
        this.apiRouter.close();
        this.agentRuntimeSupervisor.stop('orchestrator_close');
        this.resourceGovernor.stop();
        this.stopInterAgentChatLoop();
        this.personaLoader.stop();
        this.workflowLoader.stop();
        this.reconciler.stop();
        this.retryQueue.stop();
        this.hardware.stop();
        this.chairs.stop();
        void this.tracing?.shutdown();
        this.wsBus.close();
        // Drain in-flight HTTP requests before closing the database.
        // server.close() stops new connections; the callback fires when
        // all existing connections have ended, preventing SQLite "database
        // is closed" errors from mid-flight request handlers (C7).
        this.server.close(() => {
            this.memoryDb.close();
        });
    }

    private hasInteractiveWork(): boolean {
        if ((this.wsBus?.wss?.clients?.size ?? 0) > 0) return true;
        if (this.conversationBus.activeTopicCount() > 0) return true;
        const stats = this.claims.stats();
        return stats[ClaimState.Claimed] > 0 || stats[ClaimState.Running] > 0;
    }

    private enterLightweightMode(event: ResourceModeChange): void {
        this.hardware.stop();
        if (this.interAgentChatEnabled) {
            this.stopInterAgentChatLoop();
        }

        const droppedNodes = this.nodeCache.size;
        this.nodeCache.clear();

        const droppedTasks = Math.max(0, this.taskCache.length - this.resourceModeConfig.idleTaskCacheRetain);
        if (droppedTasks > 0) {
            this.taskCache = this.taskCache.slice(-this.resourceModeConfig.idleTaskCacheRetain);
        }

        this.hardwareCache = null;
        this.activeCycles.clear();
        const droppedTraces = this.tracing?.ring.trimTo(this.resourceModeConfig.idleTraceRetain) ?? 0;
        const maybeGc = (globalThis as { gc?: () => void }).gc;
        if (typeof maybeGc === 'function') {
            try {
                maybeGc();
            } catch {
                // GC is best-effort and only available when Node is run with --expose-gc.
            }
        }

        this.log.info('resource_mode_idle', {
            idle_for_ms: event.idleForMs,
            dropped_nodes: droppedNodes,
            dropped_tasks: droppedTasks,
            dropped_traces: droppedTraces,
        });
        if (this.agentRuntimeSupervisor.parkOnIdle()) {
            this.agentRuntimeSupervisor.stop('resource_idle');
        }
    }

    private enterActiveMode(event: ResourceModeChange): void {
        this.hardware.start();
        if (this.interAgentChatEnabled) {
            this.startInterAgentChatLoop();
        }
        this.agentRuntimeSupervisor.start(this.boundPort, 'resource_active');
        this.log.info('resource_mode_active', { reason: event.reason });
        this.broadcast({
            type: 'resource_mode',
            nodeId: 'resource-governor',
            data: this.resourceGovernor.snapshot(),
        });
    }
}

function resolveResourceModeConfig(
    overrides: Partial<OrchestratorResourceModeConfig>,
): Required<OrchestratorResourceModeConfig> {
    return {
        ...DEFAULT_RESOURCE_MODE_CONFIG,
        enabled: readBooleanEnv('KOVAEL_RESOURCE_MODE_ENABLED', DEFAULT_RESOURCE_MODE_CONFIG.enabled),
        idleAfterMs: readPositiveIntEnv('KOVAEL_RESOURCE_IDLE_AFTER_MS', DEFAULT_RESOURCE_MODE_CONFIG.idleAfterMs),
        sweepIntervalMs: readPositiveIntEnv('KOVAEL_RESOURCE_SWEEP_INTERVAL_MS', DEFAULT_RESOURCE_MODE_CONFIG.sweepIntervalMs),
        idleTaskCacheRetain: readNonNegativeIntEnv(
            'KOVAEL_RESOURCE_IDLE_TASK_RETAIN',
            DEFAULT_RESOURCE_MODE_CONFIG.idleTaskCacheRetain,
        ),
        idleTraceRetain: readNonNegativeIntEnv(
            'KOVAEL_RESOURCE_IDLE_TRACE_RETAIN',
            DEFAULT_RESOURCE_MODE_CONFIG.idleTraceRetain,
        ),
        ...overrides,
    };
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
