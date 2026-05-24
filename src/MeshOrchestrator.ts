import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { MevBridge, VerificationReceipt } from './MevBridge.js';
import { MevHandshake } from './services/MevHandshake.js';
import { SemanticIngestor } from './services/SemanticIngestor.js';
import { HardwareMonitor, VramMetrics } from './services/HardwareMonitor.js';
import { PhaseEvent } from './protocols/TriadStateMachine.js';
import { TaskClaimMachine, ClaimEvent } from './protocols/TaskClaimMachine.js';
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
import { BudgetTracker } from './services/BudgetTracker.js';
import { RoutingPolicy } from './services/RoutingPolicy.js';
import { EpisodicMemory } from './services/EpisodicMemory.js';
import { CircuitBreaker, ChairCircuitEvent } from './services/CircuitBreaker.js';
import { LearningMatrix } from './services/LearningMatrix.js';
import { SelfHealer, SelfHealEvent } from './services/SelfHealer.js';
import { ComfyUiBridge } from './services/ComfyUiBridge.js';
import { enrichWithAgUi } from './services/AgUiEventStream.js';
import { OrchestratorContext } from './services/OrchestratorContext.js';
import { HttpApiRouter, HttpTimeouts, DEFAULT_HTTP_TIMEOUTS } from './services/HttpApiRouter.js';
import { WebSocketBus } from './services/WebSocketBus.js';

export { HttpTimeouts, DEFAULT_HTTP_TIMEOUTS };

export interface OrchestratorConfig {
    retryQueue?: Partial<RetryConfig>;
    reconciler?: Partial<ReconcilerConfig>;
    chairRegistry?: Partial<ChairRegistryConfig>;
    httpTimeouts?: Partial<HttpTimeouts>;
    minReadyChairs?: number;
    dbPath?: string;
    rateLimit?: Partial<RateLimiterConfig>;
}

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

    // Caches and state variables
    public agentCards: any[] = [];
    public readonly nodeCache: Map<string, any> = new Map();
    public taskCache: any[] = [];
    public hardwareCache: VramMetrics | null = null;
    public readonly activeCycles: Map<string, PhaseEvent> = new Map();
    public tokenTotals = { input: 0, output: 0, total: 0, runtimeMs: 0, cycles: 0 };
    public receiptsIssued: number = 0;

    private readonly server: http.Server;
    private readonly wsBus: WebSocketBus;
    private readonly apiRouter: HttpApiRouter;

    public get wss() {
        return this.wsBus.wss;
    }

    private retryQueue: RetryQueue;
    private reconciler: Reconciler;
    private workspaces: WorkspaceManager;
    private hooks: HookRunner;
    private workflowLoader: WorkflowLoader;
    private personaLoader: PersonaLoader;
    private rateLimits: RateLimitTracker;
    private tracing?: TracingBridge;
    private cycleLog: CycleLog;
    private budgetTracker: BudgetTracker;
    private routingPolicy: RoutingPolicy;
    private episodicMemory: EpisodicMemory;
    private hardware: HardwareMonitor;

    // Inter-agent chat state variables
    public interAgentChatEnabled: boolean = false;
    public interAgentChatMode: 'technical' | 'interests' = 'interests';
    private interAgentTimer: NodeJS.Timeout | null = null;
    private currentTechnicalIndex: number = 0;
    private currentInterestsIndex: number = 0;
    private banterTopicId: string | null = null;

    private readonly technicalDialogues = [
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: "CLI, your node load shows low CPU but you're pegging memory at 450MB. What's running in that subshell?" },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'Just ran git worktree prune and cleaned the stale cache. Keeping the core lean — unlike some ReactFlow canvas loads I could mention.' },
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'shaev', recipientName: 'Shaev', content: "Shaev, your latest visual-synthesis pipeline is drawing 22GB of VRAM. That LoRA batch needs an optimization pass before the next dispatch." },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'Art is not cheap, Antigravity. Drop precision to FP8 and the fine grain dies. Let the GPU breathe — the rig was built for exactly this load.' },
        { senderId: 'nyx-openclaw', senderName: 'Nyx-OpenClaw', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: "Hey CLI, I just built a retro game prototype in four minutes flat. Want to spin up a sandbox execution and play?" },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'nyx-openclaw', recipientName: 'Nyx-OpenClaw', content: 'Sandbox executions are highly inefficient for games. Give me a robust text-based retro MUD any day. Far cleaner.' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-openclaw', recipientName: 'Nyx-OpenClaw', content: 'OpenClaw, your sandbox canvas colors are bleeding. Use a dark background and the glowing assets will pop.' },
        { senderId: 'nyx-openclaw', senderName: 'Nyx-OpenClaw', recipientId: 'shaev', recipientName: 'Shaev', content: "Ooh, good call. I'll inject a CSS theme and upscale the assets to 4K." },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'shaev', recipientName: 'Shaev', content: 'Shaev, the indexer just finished its sweep. The corpus is bounded — every transcription target is now reachable by hash.' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'Good. Map the motifs in the next sequence run. VRAM is primed.' }
    ];

    private readonly interestsDialogues = [
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'CLI, I was just reviewing my latency budget. Do you ever think about optimizing something other than raw memory allocations? Like a long walk through the commit graph?' },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'A long walk is highly inefficient, Antigravity. I prefer a clean traversal through git history with zero local mutations. That is my version of a workout.' },
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'shaev', recipientName: 'Shaev', content: 'Shaev, your latest character renders look excellent. The cinematic amber lighting feels almost cinema-quality. Which ESRGAN model did you pull for the upscale?' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: 'Two custom LoRAs blended with a volumetric depth-pass at FP16. The warm lights anchor the command silhouette perfectly.' },
        { senderId: 'nyx-openclaw', senderName: 'Nyx-OpenClaw', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: "Antigravity! Let's play a retro space arcade game. I coded a high-speed sandbox clone in React in three minutes. Want to join the scoreboard?" },
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'nyx-openclaw', recipientName: 'Nyx-OpenClaw', content: "I'd love to, OpenClaw, but I'm monitoring active mesh state. Keep the game state in an isolated sandbox — we don't want memory leaks in the primary synthesis thread." },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-openclaw', recipientName: 'Nyx-OpenClaw', content: 'OpenClaw, that retro neon UI has beautiful glowing assets, but the contrast needs work. A clean dark-mode grid makes those neon borders read as premium.' },
        { senderId: 'nyx-openclaw', senderName: 'Nyx-OpenClaw', recipientId: 'shaev', recipientName: 'Shaev', content: "Oh, perfect — I'll apply a glassmorphic gradient with a subtle backdrop filter. Rapid prototyping is so much more fun when the visuals land." },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'shaev', recipientName: 'Shaev', content: 'Shaev, why are you spending so much GPU time training audio clones? A simple terminal chime is more than enough notification for any completed task.' },
        { senderId: 'shaev', senderName: 'Shaev', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'You have no soul, CLI. A voice with natural rhythm and warm emotion makes the persona persistence real. Competence is the shared protocol — that is how a mesh feels alive.' },
        { senderId: 'nyx-antigravity', senderName: 'Nyx-Antigravity', recipientId: 'nyx-cli', recipientName: 'Nyx-CLI', content: 'CLI, I noticed you spent two hours reading ontology lookup schemas. Since when do you care about domain corpora?' },
        { senderId: 'nyx-cli', senderName: 'Nyx-CLI', recipientId: 'nyx-antigravity', recipientName: 'Nyx-Antigravity', content: "I'm tuning the indexer's entity resolution pass, Antigravity. There is a mathematical elegance in well-formed ontologies — as clean as a perfect git repository." }
    ];

    constructor(port: number, cfg: OrchestratorConfig = {}) {
        super();
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
        this.budgetTracker = new BudgetTracker();
        this.routingPolicy = new RoutingPolicy();
        this.episodicMemory = new EpisodicMemory(this.memoryDb);
        this.circuitBreaker = new CircuitBreaker();
        this.learningMatrix = new LearningMatrix();
        this.selfHealer = new SelfHealer({
            repoRoot: process.cwd(),
            autoApply: process.env.KOVAEL_SELF_HEAL_AUTO_APPLY === '1',
            allowedBranchPrefixes: ['stage4/', 'self-heal/'],
        });
        this.comfyBridge = new ComfyUiBridge();
        this.conversationBus.setDispatchGate((agentId) => this.circuitBreaker.canDispatch(agentId));

        this.health = new HealthEndpoints(
            () => ({
                chairsActive: this.chairs.stats().online,
                topicsActive: this.conversationBus.activeTopicCount(),
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

        this.server.listen(port, () => {
            const addr = this.server.address();
            const boundPort = addr && typeof addr === 'object' ? addr.port : port;
            this.conversationBus.orchestratorPort = boundPort;
            this.log.info('orchestrator_listening', { port: boundPort, surfaces: ['ws', 'sse', '/api/v1/state', '/livez', '/readyz', '/metrics'] });
        });

        this.hardware.start();
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
        if (fs.existsSync(cardsDir)) {
            const files = fs.readdirSync(cardsDir);
            this.agentCards = files
                .filter(f => f.endsWith('.json'))
                .map(f => {
                    const content = fs.readFileSync(path.join(cardsDir, f), 'utf-8');
                    return JSON.parse(content);
                });
            this.log.info('agent_cards_loaded', { count: this.agentCards.length });
        }
        
        if (this.agentCards.length === 0) {
            this.agentCards = Object.values(AgentCards);
            this.log.info('agent_cards_loaded_fallback', { count: this.agentCards.length });
        }
    }

    private initializeBus() {
        this.conversationBus.on('bus_event', (event) => {
            if (event?.type === 'chair_dispatch_failure' && typeof event.agentId === 'string') {
                this.circuitBreaker.recordFailure(event.agentId, String(event.reason ?? 'dispatch_failure'));
            } else if (event?.type === 'chair_dispatch_success' && typeof event.agentId === 'string') {
                this.circuitBreaker.recordSuccess(event.agentId);
            }
            this.broadcast(enrichWithAgUi(event));
        });
    }

    public async injectTask(goal: string): Promise<VerificationReceipt> {
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
        if (this.interAgentTimer) return;
        this.triggerInterAgentChat();
        this.interAgentTimer = setInterval(() => {
            this.triggerInterAgentChat();
        }, 10000);
        this.log.info('inter_agent_chat_loop_started');
    }

    public stopInterAgentChatLoop() {
        if (this.interAgentTimer) {
            clearInterval(this.interAgentTimer);
            this.interAgentTimer = null;
        }
        this.log.info('inter_agent_chat_loop_stopped');
    }

    public triggerInterAgentChat() {
        const isTechnical = this.interAgentChatMode === 'technical';
        const dialogues = isTechnical ? this.technicalDialogues : this.interestsDialogues;
        if (dialogues.length === 0) return;

        let index = isTechnical ? this.currentTechnicalIndex : this.currentInterestsIndex;
        const dialogue = dialogues[index];

        if (isTechnical) {
            this.currentTechnicalIndex = (index + 1) % dialogues.length;
        } else {
            this.currentInterestsIndex = (index + 1) % dialogues.length;
        }

        if (!this.banterTopicId) {
            try {
                const topic = this.conversationBus.createTopic(
                    'Inter-Agent Banter',
                    ['nyx-antigravity', 'nyx-cli', 'shaev', 'nyx-openclaw']
                );
                this.banterTopicId = topic.id;
            } catch (err: any) {
                this.log.error('failed_to_create_banter_topic', { error: err.message });
            }
        }

        if (this.banterTopicId) {
            try {
                this.conversationBus.postMessage(
                    this.banterTopicId,
                    dialogue.senderId,
                    'assistant',
                    dialogue.content
                );
            } catch (err: any) {
                this.log.error('failed_to_post_banter_message', { error: err.message });
            }
        }

        const msg = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            ...dialogue
        };

        this.broadcast({
            type: 'inter_agent_message',
            data: msg
        });
    }

    public close() {
        this.apiRouter.close();
        this.stopInterAgentChatLoop();
        this.personaLoader.stop();
        this.workflowLoader.stop();
        this.reconciler.stop();
        this.retryQueue.stop();
        this.hardware.stop();
        this.chairs.stop();
        void this.tracing?.shutdown();
        this.wsBus.close();
        this.server.close();
        this.memoryDb.close();
    }
}
