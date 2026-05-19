import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { TriadStateMachine, TriadPhase, PhaseEvent } from './protocols/TriadStateMachine.js';
import type { RateLimitTracker } from './services/RateLimitTracker.js';

/**
 * Token accounting per Symphony §13 — every receipt carries the cycle's
 * input/output/total token count and wall-clock runtime. When a real LLM
 * provider returns usage, populate `source: 'reported'` and accumulate
 * absolute thread totals; until then we ship a `source: 'estimate'`
 * derived from the chars/4 rule so the cockpit always has something
 * meaningful to render.
 */
export interface TokenUsage {
    input: number;
    output: number;
    total: number;
    runtimeMs: number;
    source: 'estimate' | 'reported';
}

/**
 * ZTNP: Zero Trust Node Protocol - Verification Receipt
 */
export interface VerificationReceipt {
    id: string;
    cycleId: string;
    timestamp: number;
    architectId: string;
    operatorId: string;
    verifierId: string;
    taskHash: string;
    status: 'verified' | 'failed';
    evidence: string;
    routing: {
        architectAgent: string;
        rationale: string;
        vramFreeMb: number;
    };
    phaseTrail: PhaseEvent[];
    tokens?: TokenUsage;
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface ShardOptions {
    keepRecent: number;
}

const SHAEV_AGENT = 'shaev';
const NYX_CLI_AGENT = 'nyx-cli';

/**
 * MevBridge: Implementation of the Triad Architect pattern.
 *
 * Routes the Architect/Operator/Verifier loop through a formal state machine
 * and produces ZTNP receipts that embed the full phase trail + routing
 * rationale. Hardware-gated: heavy architectural work is routed to Shaev only
 * when VRAM headroom is verified; otherwise the request falls back to a
 * lighter agent so the mesh never OOMs at high concurrency.
 */
export class MevBridge extends EventEmitter {
    private db: DatabaseSync;
    private vramFreeMb: number = 0;
    private vramKnown: boolean = false;
    private rateLimits: RateLimitTracker | null = null;
    private vramFloorMb: number = 8192;
    private primaryArchitect: string = SHAEV_AGENT;
    private fallbackAgent: string = NYX_CLI_AGENT;
    private keepRecentTurns: number = 3;

    constructor(dbPath: string = 'mev_bridge.db') {
        super();
        this.db = new DatabaseSync(dbPath);
        this.initializeDatabase();
    }

    private initializeDatabase() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS verification_receipts (
                id TEXT PRIMARY KEY,
                cycle_id TEXT,
                timestamp INTEGER,
                architect_id TEXT,
                operator_id TEXT,
                verifier_id TEXT,
                task_hash TEXT,
                status TEXT,
                evidence TEXT,
                routing TEXT,
                phase_trail TEXT
            ) STRICT
        `);
    }

    /**
     * Hardware Gate: orchestrator pipes VRAM telemetry in here so routing
     * decisions stay current without coupling to the WS bus.
     */
    public setVramFree(freeMb: number, known: boolean = true): void {
        this.vramFreeMb = freeMb;
        this.vramKnown = known;
    }

    public setVramFloor(floorMb: number): void {
        this.vramFloorMb = floorMb;
    }

    public setRateLimitTracker(tracker: RateLimitTracker): void {
        this.rateLimits = tracker;
    }

    public setPrimaryArchitect(agent: string): void {
        this.primaryArchitect = agent;
    }

    public setFallbackAgent(agent: string): void {
        this.fallbackAgent = agent;
    }

    public setKeepRecentTurns(turns: number): void {
        this.keepRecentTurns = turns;
    }

    /**
     * Context Sharding (tightened per Module C):
     * Keep the system prompt + the ANX mission manifest + the last 3 turns.
     * Reduces token pressure on every dispatch — critical at 1,000 nodes.
     */
    public shardContext(history: any[], opts: ShardOptions = { keepRecent: 3 }): any[] {
        const keepRecent = opts.keepRecent ?? 3;
        const system = history.find(m => m?.role === 'system');
        const tail = history.slice(-keepRecent);

        const head: any[] = [];
        if (system && !tail.includes(system)) head.push(system);

        return [...head, ...tail];
    }

    /**
     * Hardware + rate-limit router: decide which agent owns the architect
     * phase. Order of precedence: rate-limit blocks first (catastrophic for
     * the agent if ignored), then VRAM floor, then default.
     */
    private routeArchitect(): { agent: string; rationale: string } {
        // Rate-limit gate first — if primary is hot, fall back regardless of VRAM.
        if (this.rateLimits && !this.rateLimits.canDispatch(this.primaryArchitect)) {
            return {
                agent: this.fallbackAgent,
                rationale: `${this.primaryArchitect}_rate_limited:falling_back_to_${this.fallbackAgent}`,
            };
        }
        if (!this.vramKnown) {
            return {
                agent: this.fallbackAgent,
                rationale: 'vram_unknown:defaulting_to_lightweight',
            };
        }
        if (this.vramFreeMb >= this.vramFloorMb) {
            return {
                agent: this.primaryArchitect,
                rationale: `vram_free_${this.vramFreeMb}mb>=${this.vramFloorMb}mb:${this.primaryArchitect}_authorized`,
            };
        }
        return {
            agent: this.fallbackAgent,
            rationale: `vram_free_${this.vramFreeMb}mb<${this.vramFloorMb}mb:${this.primaryArchitect}_gated`,
        };
    }

    /**
     * The Triad Architect Loop execution.
     */
    public async execute(
        task: string,
        context: any[] = [],
    ): Promise<VerificationReceipt> {
        const taskHash = crypto.createHash('sha256').update(task).digest('hex');
        const cycleId = crypto.randomUUID();
        const machine = new TriadStateMachine(cycleId, taskHash);
        const cycleStart = Date.now();

        machine.on('phase_change', (evt: PhaseEvent) => this.emit('phase_change', evt));

        const routing = this.routeArchitect();
        // Record the dispatch for rate-limit accounting (no-op if tracker absent).
        this.rateLimits?.recordDispatch(routing.agent);
        const shardedContext = this.shardContext(context, { keepRecent: this.keepRecentTurns });

        try {
            machine.transition(TriadPhase.DispatchToArchitect, { routedAgent: routing.agent, note: routing.rationale });
            machine.transition(TriadPhase.ArchitectStreaming);
            const blueprint = await this.architect(task, shardedContext, routing.agent);

            machine.transition(TriadPhase.DispatchToOperator);
            machine.transition(TriadPhase.OperatorExecuting);
            const executionResult = await this.operator(blueprint);

            machine.transition(TriadPhase.DispatchToVerifier);
            machine.transition(TriadPhase.VerifierAuditing);
            const verification = await this.verifier(blueprint, executionResult);

            machine.transition(TriadPhase.IssuingReceipt);

            // Symphony §13 — token accounting. No real LLM is wired today;
            // we estimate from prompt + response character length so the
            // shape is correct when a provider returns usage later.
            const promptText = task + shardedContext.map(m => (m?.content ?? '')).join('\n');
            const responseText = JSON.stringify(blueprint) + JSON.stringify(executionResult) + JSON.stringify(verification.details);
            const input = estimateTokens(promptText);
            const output = estimateTokens(responseText);
            const tokens: TokenUsage = {
                input,
                output,
                total: input + output,
                runtimeMs: Date.now() - cycleStart,
                source: 'estimate',
            };

            const receipt: VerificationReceipt = {
                id: crypto.randomUUID(),
                cycleId,
                timestamp: Date.now(),
                architectId: routing.agent,
                operatorId: 'operator-v1-nyx',
                verifierId: 'verifier-v1-nyx',
                taskHash,
                status: verification.success ? 'verified' : 'failed',
                evidence: JSON.stringify({
                    blueprintId: blueprint.taskId,
                    verificationDetails: verification.details,
                    executionStatus: executionResult.status,
                }),
                routing: {
                    architectAgent: routing.agent,
                    rationale: routing.rationale,
                    vramFreeMb: this.vramFreeMb,
                },
                phaseTrail: machine.trail(),
                tokens,
            };

            // Terminal transition carries routedAgent so the cockpit can
            // reset the agent's status from 'dispatching' back to 'online'.
            machine.transition(
                verification.success ? TriadPhase.Succeeded : TriadPhase.Failed,
                { routedAgent: routing.agent },
            );
            receipt.phaseTrail = machine.trail();

            this.storeReceipt(receipt);
            this.emit('cycle_complete', receipt);

            return receipt;
        } catch (error) {
            if (!machine.isTerminal()) {
                try {
                    machine.transition(TriadPhase.Failed, {
                        routedAgent: routing.agent,
                        note: (error as Error).message,
                    });
                } catch { /* swallow */ }
            }
            console.error('[MevBridge] Loop failure:', error);
            throw error;
        }
    }

    private async architect(task: string, context: any[], routedAgent: string) {
        console.log(`[Architect:${routedAgent}] Designing strategy for: ${task}`);
        return {
            taskId: crypto.randomUUID(),
            intent: task,
            shardsUsed: context.length,
            routedAgent,
            requirements: ['idempotency', 'traceability'],
        };
    }

    private async operator(blueprint: any) {
        console.log(`[Operator] Executing blueprint: ${blueprint.taskId}`);
        return {
            status: 'success',
            payload: 'Operation payload generated',
            exitCode: 0,
        };
    }

    private async verifier(blueprint: any, result: any) {
        console.log(`[Verifier] Verifying execution of: ${blueprint.taskId}`);
        const isValid = result.exitCode === 0 && result.status === 'success';
        return {
            success: isValid,
            details: {
                intentMatched: true,
                checksum: crypto.randomBytes(8).toString('hex'),
            },
        };
    }

    private storeReceipt(receipt: VerificationReceipt) {
        const stmt = this.db.prepare(`
            INSERT INTO verification_receipts (
                id, cycle_id, timestamp, architect_id, operator_id, verifier_id,
                task_hash, status, evidence, routing, phase_trail
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            receipt.id,
            receipt.cycleId,
            receipt.timestamp,
            receipt.architectId,
            receipt.operatorId,
            receipt.verifierId,
            receipt.taskHash,
            receipt.status,
            receipt.evidence,
            JSON.stringify(receipt.routing),
            JSON.stringify(receipt.phaseTrail),
        );
    }
}
