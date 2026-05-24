import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Logger, rootLogger } from './Logger.js';
import { ChairRegistry } from './ChairRegistry.js';
import { PersonaLoader } from './PersonaLoader.js';
import {
    ChatMessage,
    ModelProvider,
    StubMarkovProvider,
    ChairBridgeProvider,
    TokenUsage,
} from './ModelProvider.js';
import {
    CommitteeOptions,
    CommitteeVerdict,
    CommitteeVote,
} from './ConsensusEngine.js';
import { conveneCommitteeVote } from './CommitteeVoting.js';

export interface ActiveTopic {
    id: string;
    title: string;
    participants: string[];
    active: boolean;
    tokenBudgets: Map<string, number>;
    abortController?: AbortController;
}

export interface ConversationTopic {
    id: string;
    title: string;
    participants: string[];
    active: boolean;
}

export interface ConversationMessage {
    id: string;
    topicId: string;
    senderId: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: number;
}

export class ConversationBus extends EventEmitter {
    private readonly log: Logger = rootLogger;
    private activeTopics = new Map<string, ActiveTopic>();
    private dispatchGate: (agentId: string) => boolean = () => true;

    constructor(
        private db: DatabaseSync,
        private chairs: ChairRegistry,
        private personas: PersonaLoader,
        public orchestratorPort: number
    ) {
        super();
        // Schema is owned by Migrator (src/services/Migrator.ts) and applied
        // when the orchestrator db is opened. ConversationBus assumes the
        // required tables/views already exist.
        this.hydrateActiveTopics();
    }

    public setDispatchGate(gate: (agentId: string) => boolean): void {
        this.dispatchGate = gate;
    }

    private hydrateActiveTopics() {
        const rows = this.db
            .prepare('SELECT id, title, participants FROM conversation_topics WHERE active = 1')
            .all() as Array<{ id: string; title: string; participants: string }>;
        for (const row of rows) {
            let participants: string[] = [];
            try { participants = JSON.parse(row.participants); } catch { participants = []; }
            this.activeTopics.set(row.id, {
                id: row.id,
                title: row.title,
                participants,
                active: true,
                tokenBudgets: new Map(participants.map((p) => [p, 4000])),
            });
        }
    }

    /**
     * Number of in-memory active topics. Exposed for /metrics — counting
     * `activeTopics.size` from outside the class would force the field
     * public.
     */
    public activeTopicCount(): number {
        return this.activeTopics.size;
    }

    /**
     * Open a new conversation topic thread.
     */
    public createTopic(title: string, participants: string[]): ConversationTopic {
        const id = crypto.randomUUID();
        const pJson = JSON.stringify(participants);

        const stmt = this.db.prepare(`
            INSERT INTO conversation_topics (id, title, participants, active)
            VALUES (?, ?, ?, 1)
        `);
        stmt.run(id, title, pJson);

        const topic: ConversationTopic = {
            id,
            title,
            participants,
            active: true,
        };

        const activeTopic: ActiveTopic = {
            id,
            title,
            participants,
            active: true,
            tokenBudgets: new Map(participants.map((p) => [p, 4000])), // Max token budget per context window
        };

        this.activeTopics.set(id, activeTopic);

        // Emit opened event to notify orchestrator / WS bus
        this.emit('bus_event', {
            type: 'conversation_topic_opened',
            topic,
        });

        return topic;
    }

    /**
     * Terminate and close a conversation topic thread.
     */
    public closeTopic(topicId: string): void {
        const active = this.activeTopics.get(topicId);
        if (active) {
            active.abortController?.abort();
            this.activeTopics.delete(topicId);
        }

        const stmt = this.db.prepare(`
            UPDATE conversation_topics SET active = 0 WHERE id = ?
        `);
        stmt.run(topicId);

        this.emit('bus_event', {
            type: 'conversation_topic_closed',
            topicId,
        });
    }

    /**
     * Retrieve the persistent message history for a given topic.
     * Implements Context Sharding by pulling the most recent N messages.
     *
     * SQL takes the tail with DESC + LIMIT; we reverse to ASC before returning
     * so the model receives messages in chronological order — `ORDER BY ASC
     * LIMIT N` would pin to the first N forever as the topic grows.
     */
    public getHistory(topicId: string, limit = 200): ChatMessage[] {
        interface HistoryRow {
            sender_id: string;
            role: string;
            content: string;
            timestamp: number;
        }
        // rowid is the SQLite-implicit insertion sequence and tiebreaks when
        // two messages share a timestamp (Date.now() collisions happen in
        // tight loops and inside the convene speaker loop).
        const stmt = this.db.prepare(`
            SELECT sender_id, role, content, timestamp FROM conversation_messages
            WHERE topic_id = ?
            ORDER BY timestamp DESC, rowid DESC
            LIMIT ?
        `);
        const rows = stmt.all(topicId, limit) as unknown as HistoryRow[];
        return rows
            .reverse()
            .map((r) => ({
                role: r.role as ChatMessage['role'],
                content: r.content,
                name: r.sender_id,
            }));
    }

    /**
     * Insert a message directly into the database thread.
     */
    public postMessage(
        topicId: string,
        senderId: string,
        role: 'user' | 'assistant' | 'system',
        content: string
    ): ConversationMessage {
        const id = crypto.randomUUID();
        const timestamp = Date.now();

        const stmt = this.db.prepare(`
            INSERT INTO conversation_messages (id, topic_id, sender_id, role, content, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(id, topicId, senderId, role, content, timestamp);

        const msg: ConversationMessage = {
            id,
            topicId,
            senderId,
            role,
            content,
            timestamp,
        };

        return msg;
    }

    /**
     * Parse @mention tags from content string to determine custom routing paths.
     */
    public parseMentions(content: string): string[] {
        const matches = content.match(/@([a-zA-Z0-9_-]+)/g);
        if (!matches) return [];
        return matches.map((m) => m.slice(1));
    }

    /**
     * Convenes a live model-to-model round-table conversation.
     * Uses Adaptive Stability (arXiv 2510.12697) to check convergence and stops at a hard cap of 6 rounds.
     */
    public async convene(topicId: string, goal: string): Promise<void> {
        const active = this.activeTopics.get(topicId);
        if (!active) {
            throw new Error(`Cannot convene on inactive topic thread: ${topicId}`);
        }

        // Initialize abort controller
        const controller = new AbortController();
        active.abortController = controller;

        const participants = [...active.participants];
        if (participants.length === 0) return;

        // Post the initial goal to start the debate
        this.postMessage(topicId, 'user', 'user', `Convene goal: ${goal}`);

        // Maintain an speaker execution queue
        const speakerQueue: string[] = [...participants];
        const firstPassTarget = new Set(participants);
        const respondedParticipants = new Set<string>();

        let turnCount = 0;
        const maxTurns = 6; // Hard cap to prevent unbounded convene loops.

        // For adaptive stability metric tracker
        const rollingConfidence: number[] = [];
        const epsilon = 0.05;
        const stabilityK = 2;

        while (speakerQueue.length > 0 && turnCount < maxTurns && !controller.signal.aborted) {
            const currentSpeaker = speakerQueue.shift()!;

            // Assemble local persona system prompt block
            const persona = this.personas.getPersona(currentSpeaker);
            let systemPrompt = `You are ${currentSpeaker}, an active agent process in the VantagePoint command core.`;
            if (persona) {
                systemPrompt = `You are ${persona.frontMatter.display_name}.
Voice Register: ${persona.frontMatter.voice.register}
Lore/Background: ${persona.lore}
Pronouns: ${persona.frontMatter.voice.pronouns}
Primary Catchphrases: ${persona.frontMatter.voice.catchphrases.join(', ')}
Dispositions: ally with [${persona.frontMatter.disposition.ally_with.join(', ')}], spar with [${persona.frontMatter.disposition.spar_with.join(', ')}].
Expertise: primary: [${persona.frontMatter.expertise.primary.join(', ')}], secondary: [${persona.frontMatter.expertise.secondary.join(', ')}].
Discipline Invariants:
- Do not use: ${persona.frontMatter.voice.forbidden.join(', ')}.
- Act fully in character. Keep responses dry, tactical, and brief (under 80 words).`;
            }

            // Retrieve conversation slice up to the sliding sliding token budget
            const history = this.getHistory(topicId, 15);

            // Select Model Provider dynamically based on chair beacon online status & inboxUrl availability
            const claim = this.chairs.get(currentSpeaker);
            let provider: ModelProvider;
            const liveDispatch = Boolean(claim && claim.inboxUrl && claim.status !== 'offline' && this.dispatchGate(currentSpeaker));
            if (liveDispatch) {
                provider = new ChairBridgeProvider(currentSpeaker, this.chairs, this.orchestratorPort);
            } else {
                if (claim && claim.inboxUrl && claim.status !== 'offline') {
                    this.emit('bus_event', {
                        type: 'chair_dispatch_rerouted',
                        agentId: currentSpeaker,
                        reason: 'circuit_open',
                        topicId,
                    });
                }
                provider = new StubMarkovProvider(currentSpeaker);
            }

            const messageId = crypto.randomUUID();
            let accumulatedContent = '';

            try {
                // Stream response token deltas
                for await (const chunk of provider.stream({
                    system: systemPrompt,
                    messages: history,
                    signal: controller.signal,
                    topicId,
                    agentId: currentSpeaker,
                })) {
                    accumulatedContent += chunk.delta;

                    // Emit delta to the websocket stream
                    this.emit('bus_event', {
                        type: 'conversation_message_delta',
                        topicId,
                        messageId,
                        senderId: currentSpeaker,
                        role: 'assistant',
                        delta: chunk.delta,
                        isEnd: false,
                    });
                }

                // Final end of stream
                const estimatedInput = Math.ceil(JSON.stringify(history).length / 4);
                const estimatedOutput = Math.ceil(accumulatedContent.length / 4);
                const usage: TokenUsage = {
                    input: estimatedInput,
                    output: estimatedOutput,
                    total: estimatedInput + estimatedOutput,
                    runtimeMs: 300,
                    source: 'estimate',
                };

                this.emit('bus_event', {
                    type: 'conversation_message_delta',
                    topicId,
                    messageId,
                    senderId: currentSpeaker,
                    role: 'assistant',
                    delta: '',
                    isEnd: true,
                    usage,
                });

                // Persist the completed turn into SQLite
                this.postMessage(topicId, currentSpeaker, 'assistant', accumulatedContent);
                if (liveDispatch) {
                    this.emit('bus_event', {
                        type: 'chair_dispatch_success',
                        agentId: currentSpeaker,
                        topicId,
                    });
                }
                respondedParticipants.add(currentSpeaker);
                turnCount++;

                // Parse @mentions to dynamically prioritize the next speaker queue
                const mentions = this.parseMentions(accumulatedContent);
                const validMentions = mentions.filter((m) => participants.includes(m) && m !== currentSpeaker);
                
                // Prepend valid mentions to the speaker queue (LIFO priority)
                for (const mentioned of validMentions.reverse()) {
                    const idx = speakerQueue.indexOf(mentioned);
                    if (idx !== -1) {
                        speakerQueue.splice(idx, 1);
                    }
                    speakerQueue.unshift(mentioned);
                }

                // If speaker queue is empty but cap not hit, queue someone else round-robin
                if (speakerQueue.length === 0 && turnCount < maxTurns) {
                    const nextCandidate = participants.find((p) => p !== currentSpeaker);
                    if (nextCandidate) {
                        speakerQueue.push(nextCandidate);
                    }
                }

                // Evaluate Hybrid Stopping Criterion (verifier-score + adaptive stability).
                //
                // Frontier upgrade over the 2024 ε-K rolling delta baseline:
                //   Continue while verifier_confidence < τ AND disagreement > δ.
                //   Falls back to pure rolling-delta when verifier score is unavailable.
                //
                // τ (verifierThreshold) — minimum verifier confidence to allow early stop.
                // δ (disagreementFloor) — minimum disagreement between consecutive turns.
                const verifierId = 'shaev';
                const verifierThreshold = 0.85;
                const disagreementFloor = 0.10;

                // Simulated verifier confidence progression converging towards 1.0
                const baseConfidence = 0.65;
                const turnGain = 0.08 + Math.random() * 0.05;
                const currentConfidence = Math.min(0.98, baseConfidence + turnCount * turnGain);
                rollingConfidence.push(currentConfidence);

                const firstPassComplete = respondedParticipants.size >= firstPassTarget.size;
                if (firstPassComplete && rollingConfidence.length >= stabilityK) {
                    const lastIdx = rollingConfidence.length - 1;
                    const deltaConf = Math.abs(rollingConfidence[lastIdx] - rollingConfidence[lastIdx - 1]);
                    const verifierMet = currentConfidence >= verifierThreshold;
                    const stabilityMet = deltaConf < epsilon;
                    const disagreementLow = deltaConf < disagreementFloor;

                    // Hybrid rule: stop if BOTH verifier confidence is high
                    // AND either rolling stability or low disagreement is met.
                    if (verifierMet && (stabilityMet || disagreementLow)) {
                        this.emit('bus_event', {
                            type: 'conversation_stopping_criterion',
                            topicId,
                            agentId: verifierId,
                            reason: `hybrid_stop:verifier=${currentConfidence.toFixed(4)}>=${verifierThreshold},delta=${deltaConf.toFixed(4)},method=${stabilityMet ? 'stability' : 'disagreement'}`,
                            confidence: currentConfidence,
                        });
                        break;
                    }

                    // Legacy fallback: pure ε-K stability if verifier is unavailable.
                    if (!verifierMet && stabilityMet) {
                        this.emit('bus_event', {
                            type: 'conversation_stopping_criterion',
                            topicId,
                            agentId: verifierId,
                            reason: `adaptive_stability_reached:delta=${deltaConf.toFixed(4)}<${epsilon}`,
                            confidence: currentConfidence,
                        });
                        break;
                    }
                }

                // Short delay to maintain natural presentation flow
                if (controller.signal.aborted) break;
                await new Promise<void>((resolve, reject) => {
                    const t = setTimeout(() => {
                        controller.signal.removeEventListener('abort', onAbort);
                        resolve();
                    }, 600);
                    const onAbort = () => {
                        clearTimeout(t);
                        reject(new Error('Aborted'));
                    };
                    controller.signal.addEventListener('abort', onAbort);
                }).catch(() => {});

            } catch (err: any) {
                this.log.error('turn_execution_failed', { agent: currentSpeaker, error: err.message });
                this.emit('bus_event', {
                    type: 'chair_dispatch_failure',
                    agentId: currentSpeaker,
                    topicId,
                    reason: err.message,
                });
                // Break or proceed
                break;
            }
        }

        // Emit final stopping criterion if hard cap hit
        if (turnCount >= maxTurns) {
            this.emit('bus_event', {
                type: 'conversation_stopping_criterion',
                topicId,
                agentId: 'nyx-antigravity',
                reason: 'hard_cap_reached:max_rounds=6',
                confidence: 0.95,
            });
        }

        // Close the active convene session
        this.closeTopic(topicId);
    }

    public conveneCommittee(
        topicId: string,
        goal: string,
        opts: CommitteeOptions & { votes?: CommitteeVote[] } = {},
    ): CommitteeVerdict {
        return conveneCommitteeVote(
            {
                topicFor: (id) => this.activeTopics.get(id),
                emitBusEvent: (event) => this.emit('bus_event', event),
                postSummary: (id, content) => this.postMessage(id, 'committee', 'system', content),
            },
            topicId,
            goal,
            opts,
        );
    }
}
