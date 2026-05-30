import { ChairRegistry } from './ChairRegistry.js';
import crypto from 'node:crypto';
import {
    secureChairDispatchBody,
    verifyChairReplyProof,
} from './ChairDispatchSecurity.js';
import { redactSensitiveText } from './RuntimeSecurity.js';
import { assertSafeChairUrl } from './UrlEgressGuard.js';
import { readBoolean } from '../common/env-helpers.js';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    name?: string;
}

export interface TokenUsage {
    input: number;
    output: number;
    total: number;
    runtimeMs: number;
    source: 'estimate' | 'reported';
}

export interface ModelProviderOptions {
    system: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    topicId?: string;
    agentId?: string;
}

export interface ModelProvider {
    id: string;
    stream(opts: ModelProviderOptions): AsyncIterable<{ delta: string; usage?: TokenUsage }>;
}

/**
 * StubMarkovProvider: A local bigram transition chain generator.
 * Builds transitions dynamically from system prompt lore and conversation history,
 * streaming words at a natural human-simulated pace.
 */
export class StubMarkovProvider implements ModelProvider {
    constructor(public id: string) {}

    public async *stream(opts: ModelProviderOptions): AsyncIterable<{ delta: string; usage?: TokenUsage }> {
        const startTime = Date.now();

        // 1. Build a corpus from the system prompt, lore, and message history
        const corpusParts = [opts.system];
        for (const msg of opts.messages) {
            corpusParts.push(msg.content);
        }
        const corpus = corpusParts.join(' ').replace(/[\r\n\t]/g, ' ');

        // 2. Tokenize into words
        const words = corpus
            .split(/\s+/)
            .map((w) => w.trim())
            .filter((w) => w.length > 0);

        // 3. Build bigram transitions
        const transitions = new Map<string, string[]>();
        for (let i = 0; i < words.length - 1; i++) {
            const current = words[i];
            const next = words[i + 1];
            if (!transitions.has(current)) {
                transitions.set(current, []);
            }
            transitions.get(current)!.push(next);
        }

        // 4. Generate a sentence/response
        const responseWords: string[] = [];
        const maxWords = 40 + Math.floor(Math.random() * 40); // 40-80 words

        // Select a starting word
        let currentWord = '';
        if (words.length > 0) {
            // Find capitalized words to start nicely
            const capitalStarts = words.filter((w) => /^[A-Z]/.test(w));
            if (capitalStarts.length > 0) {
                currentWord = capitalStarts[Math.floor(Math.random() * capitalStarts.length)];
            } else {
                currentWord = words[Math.floor(Math.random() * words.length)];
            }
        }

        if (currentWord) {
            responseWords.push(currentWord);
            while (responseWords.length < maxWords) {
                const nextOptions = transitions.get(currentWord);
                if (nextOptions && nextOptions.length > 0) {
                    const chosen = nextOptions[Math.floor(Math.random() * nextOptions.length)];
                    responseWords.push(chosen);
                    currentWord = chosen;
                } else {
                    // Dead end, pick a random capitalized word or random word
                    const randomPick = words[Math.floor(Math.random() * words.length)];
                    if (!randomPick) break;
                    responseWords.push(randomPick);
                    currentWord = randomPick;
                }
            }
        } else {
            // Fallback corpus
            responseWords.push(...'Acknowledged. Mesh status nominal. Proceeding with routing and coordination.'.split(' '));
        }

        // 5. Stream words one-by-one with simulated delay
        let yieldedChars = 0;
        for (let i = 0; i < responseWords.length; i++) {
            if (opts.signal?.aborted) {
                break;
            }

            // Yield word with appropriate spacing
            const word = responseWords[i];
            const delta = i === 0 ? word : ' ' + word;
            yieldedChars += delta.length;
            yield { delta };

            // Natural typing delay: 10-30ms
            const delay = 10 + Math.floor(Math.random() * 20);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // 6. Yield final metadata and usage metrics
        const runtimeMs = Date.now() - startTime;
        const inputChars = corpus.length;
        const inputTokens = Math.ceil(inputChars / 4);
        const outputTokens = Math.ceil(yieldedChars / 4);

        yield {
            delta: '',
            usage: {
                input: inputTokens,
                output: outputTokens,
                total: inputTokens + outputTokens,
                runtimeMs,
                source: 'estimate',
            },
        };
    }
}

/**
 * ChairBridgeProvider: Bridges model execution to a live registered agent chair.
 * Dispatches prompt payload to the chair's inboxUrl and suspends until the chair
 * returns its response via the orchestrator HTTP webhook interface.
 */
export interface DispatchPolicy {
    /** Cap on a single POST attempt (connect + headers + first byte). */
    dispatchTimeoutMs: number;
    /** Total attempts. 1 = no retry. Default 3 = initial + 2 retries. */
    maxAttempts: number;
    /** Base for full-jitter exponential backoff. Delay = rand(0, base * 2^attempt). */
    baseBackoffMs: number;
}

export type ChairDispatchTelemetryEvent =
    | {
        type: 'chair_dispatch_started';
        requestId: string;
        topicId: string;
        agentId: string;
        claimSessionId: string;
        attempt: 0;
      }
    | {
        type: 'chair_dispatch_attempt';
        requestId: string;
        topicId: string;
        agentId: string;
        claimSessionId: string;
        attempt: number;
        dispatchLatencyMs: number;
        statusCode?: number;
      }
    | {
        type: 'chair_dispatch_accepted';
        requestId: string;
        topicId: string;
        agentId: string;
        claimSessionId: string;
        dispatchAttempts: number;
        dispatchLatencyMs: number;
      };

export interface ChairBridgeProviderOptions extends Partial<DispatchPolicy> {
    onDispatchEvent?: (event: ChairDispatchTelemetryEvent) => void;
}

export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
    dispatchTimeoutMs: 10_000,
    maxAttempts: 3,
    baseBackoffMs: 250,
};

export type ChairReplyStatus = 'succeeded' | 'failed';

export interface ChairReplySubmission {
    requestId: string;
    agentId: string;
    claimSessionId: string;
    replyProof: string;
    topicId?: string;
    content?: string;
    status?: ChairReplyStatus;
    error?: string;
}

export interface ChairDispatchReceipt {
    requestId: string;
    topicId: string;
    agentId: string;
    claimSessionId: string;
    status: ChairReplyStatus;
    receivedAt: number;
    proofVerified: boolean;
    dispatchAttempts?: number;
    dispatchLatencyMs?: number;
    error?: string;
}

export type ChairReplySubmitResult =
    | { ok: true; receipt: ChairDispatchReceipt }
    | { ok: false; status: number; code: string };

export class ChairBridgeReplyFailure extends Error {
    constructor(
        message: string,
        public readonly receipt: ChairDispatchReceipt,
    ) {
        super(message);
    }
}

export class ChairBridgeDispatchFailure extends Error {
    constructor(
        message: string,
        public readonly details: {
            requestId: string;
            topicId: string;
            agentId: string;
            claimSessionId: string;
            dispatchAttempts: number;
            dispatchLatencyMs: number;
        },
    ) {
        super(message);
    }
}

interface ResolvedChairReply {
    content: string;
    receipt: ChairDispatchReceipt;
}

interface PendingChairReply {
    requestId: string;
    topicId: string;
    agentId: string;
    claimSessionId: string;
    replyProofSecret: string;
    createdAt: number;
    dispatchStartedAt?: number;
    dispatchAttempts?: number;
    dispatchLatencyMs?: number;
    resolve: (reply: ResolvedChairReply) => void;
    reject: (err: Error) => void;
}

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

function replyTimeoutMs(): number {
    const parsed = Number(process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS);
    return Number.isFinite(parsed) ? Math.max(5_000, Math.min(600_000, Math.floor(parsed))) : 30_000;
}

function pendingDispatchDetails(pending: PendingChairReply): ChairBridgeDispatchFailure['details'] {
    return {
        requestId: pending.requestId,
        topicId: pending.topicId,
        agentId: pending.agentId,
        claimSessionId: pending.claimSessionId,
        dispatchAttempts: pending.dispatchAttempts ?? 0,
        dispatchLatencyMs: pending.dispatchLatencyMs
            ?? (pending.dispatchStartedAt !== undefined ? Date.now() - pending.dispatchStartedAt : 0),
    };
}

export class ChairBridgeProvider implements ModelProvider {
    private static pendingReplies = new Map<string, PendingChairReply>();
    private readonly policy: DispatchPolicy;
    private readonly onDispatchEvent?: (event: ChairDispatchTelemetryEvent) => void;
    private lastDispatchReceipt: ChairDispatchReceipt | null = null;

    constructor(
        public id: string,
        private chairs: ChairRegistry,
        private orchestratorPort: number,
        options: ChairBridgeProviderOptions = {},
    ) {
        const { onDispatchEvent, ...policy } = options;
        this.policy = { ...DEFAULT_DISPATCH_POLICY, ...policy };
        this.onDispatchEvent = onDispatchEvent;
    }

    /**
     * Receive and route reply from HTTP webhook endpoint back to the suspended stream promise.
     */
    public static submitReply(topicId: string, agentId: string, content: string): boolean {
        const matches = Array.from(this.pendingReplies.entries())
            .filter(([, pending]) => pending.topicId === topicId && pending.agentId === agentId);
        if (matches.length !== 1) return false;

        const [requestId, pending] = matches[0];
        this.pendingReplies.delete(requestId);
        pending.resolve({
            content,
            receipt: {
                requestId,
                topicId,
                agentId,
                claimSessionId: pending.claimSessionId,
                status: 'succeeded',
                receivedAt: Date.now(),
                proofVerified: false,
                dispatchAttempts: pending.dispatchAttempts,
                dispatchLatencyMs: pending.dispatchLatencyMs,
            },
        });
        return true;
    }

    public static submitReplyForRequest(
        input: ChairReplySubmission,
        _activeClaimSessionId?: string,
    ): ChairReplySubmitResult {
        const pending = this.pendingReplies.get(input.requestId);
        if (!pending) {
            return { ok: false, status: 404, code: 'unknown_chair_dispatch_request' };
        }
        if (pending.agentId !== input.agentId || (input.topicId !== undefined && pending.topicId !== input.topicId)) {
            return { ok: false, status: 409, code: 'wrong_chair_dispatch_target' };
        }
        if (pending.claimSessionId !== input.claimSessionId) {
            return { ok: false, status: 409, code: 'wrong_claim_session' };
        }
        const proofVerified = verifyChairReplyProof({
            requestId: input.requestId,
            claimSessionId: input.claimSessionId,
            replyProofSecret: pending.replyProofSecret,
            replyProof: input.replyProof,
        });
        if (!proofVerified) {
            return { ok: false, status: 401, code: 'invalid_reply_proof' };
        }

        const status = input.status ?? 'succeeded';
        const error = typeof input.error === 'string' && input.error.trim().length > 0
            ? redactSensitiveText(input.error.trim())
            : undefined;
        const dispatchAttempts = pending.dispatchAttempts;
        const dispatchLatencyMs = pending.dispatchLatencyMs
            ?? (pending.dispatchStartedAt !== undefined ? Date.now() - pending.dispatchStartedAt : undefined);
        const receipt: ChairDispatchReceipt = {
            requestId: input.requestId,
            topicId: pending.topicId,
            agentId: pending.agentId,
            claimSessionId: pending.claimSessionId,
            status,
            receivedAt: Date.now(),
            proofVerified,
            dispatchAttempts,
            dispatchLatencyMs,
            error,
        };

        this.pendingReplies.delete(input.requestId);
        if (status === 'failed') {
            pending.reject(new ChairBridgeReplyFailure(
                error ?? input.content ?? `Chair Bridge runtime failure for agent "${pending.agentId}".`,
                receipt,
            ));
        } else {
            pending.resolve({ content: input.content ?? '', receipt });
        }
        return { ok: true, receipt };
    }

    public getLastReceipt(): ChairDispatchReceipt | null {
        return this.lastDispatchReceipt ? { ...this.lastDispatchReceipt } : null;
    }

    /**
     * POST to the chair's inboxUrl with a per-attempt AbortController and
     * full-jitter exponential backoff. Retries on network errors and on
     * the transient-server status codes (429, 502, 503, 504). 4xx other
     * than 429 surface immediately — a 400 won't get better on retry.
     * Delivery is at-least-once; the stable requestId lets chair inboxes
     * dedupe retries if they support idempotency keys.
     */
    private async postWithRetry(
        url: string,
        body: string,
        parentSignal: AbortSignal | undefined,
        requestId: string,
        topicId: string,
        agentId: string,
        claimSessionId: string,
        dispatchStartedAt: number,
        headers: Record<string, string> = {},
    ): Promise<{ attempts: number }> {
        let lastErr: Error = new Error('chair bridge dispatch: no attempts ran');
        let attemptsMade = 0;
        const dispatchFailure = (err: Error) => new ChairBridgeDispatchFailure(err.message, {
            requestId,
            topicId,
            agentId,
            claimSessionId,
            dispatchAttempts: attemptsMade,
            dispatchLatencyMs: Date.now() - dispatchStartedAt,
        });
        for (let attempt = 0; attempt < this.policy.maxAttempts; attempt += 1) {
            if (parentSignal?.aborted) {
                throw dispatchFailure(new Error('chair bridge dispatch: aborted by caller'));
            }
            attemptsMade = attempt + 1;
            const pending = ChairBridgeProvider.pendingReplies.get(requestId);
            if (pending) {
                pending.dispatchAttempts = attemptsMade;
                pending.dispatchLatencyMs = Date.now() - dispatchStartedAt;
            }

            const ctrl = new AbortController();
            const attemptStartedAt = Date.now();
            const timer = setTimeout(() => ctrl.abort(), this.policy.dispatchTimeoutMs);
            // Chain parent abort → this attempt's abort.
            const onParentAbort = () => ctrl.abort();
            parentSignal?.addEventListener('abort', onParentAbort, { once: true });

            let response: Response | null = null;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'x-kovael-request-id': requestId,
                        ...headers,
                    },
                    body,
                    signal: ctrl.signal,
                });
            } catch (err) {
                lastErr = err instanceof Error ? err : new Error(String(err));
                // AbortError from caller-signal must surface immediately —
                // it is not a transient failure, it is intent.
                if (parentSignal?.aborted) throw dispatchFailure(lastErr);
            } finally {
                clearTimeout(timer);
                parentSignal?.removeEventListener('abort', onParentAbort);
            }

            if (response) {
                const active = ChairBridgeProvider.pendingReplies.get(requestId);
                if (active) {
                    active.dispatchAttempts = attemptsMade;
                    active.dispatchLatencyMs = Date.now() - dispatchStartedAt;
                }
                this.emitDispatchEvent({
                    type: 'chair_dispatch_attempt',
                    requestId,
                    topicId,
                    agentId,
                    claimSessionId,
                    attempt: attempt + 1,
                    dispatchLatencyMs: Date.now() - attemptStartedAt,
                    statusCode: response.status,
                });
                if (response.ok) return { attempts: attempt + 1 };
                // Non-retryable status — surface immediately. Don't burn
                // attempts on a 400/401/403/404; the upstream isn't going
                // to start agreeing with us.
                if (!RETRYABLE_STATUS.has(response.status)) {
                    throw dispatchFailure(new Error(`upstream returned non-retryable ${response.status}`));
                }
                lastErr = new Error(`upstream returned retryable ${response.status}`);
            } else {
                this.emitDispatchEvent({
                    type: 'chair_dispatch_attempt',
                    requestId,
                    topicId,
                    agentId,
                    claimSessionId,
                    attempt: attempt + 1,
                    dispatchLatencyMs: Date.now() - attemptStartedAt,
                });
            }

            // Don't sleep after the last attempt — fall through to throw.
            if (attempt < this.policy.maxAttempts - 1) {
                const cap = this.policy.baseBackoffMs * Math.pow(2, attempt);
                const delay = Math.floor(Math.random() * cap);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        throw dispatchFailure(lastErr);
    }

    private emitDispatchEvent(event: ChairDispatchTelemetryEvent): void {
        try {
            this.onDispatchEvent?.({ ...event });
        } catch {
            // Telemetry observers must never alter dispatch/reply state.
        }
    }

    public async *stream(opts: ModelProviderOptions): AsyncIterable<{ delta: string; usage?: TokenUsage }> {
        const startTime = Date.now();
        const topicId = opts.topicId || 'default-topic';
        const agentId = opts.agentId || this.id;

        // Check if there is a live claim
        const claim = this.chairs.get(agentId);
        if (!claim || !claim.inboxUrl || claim.status === 'offline') {
            throw new Error(`Chair Bridge failure: Agent "${agentId}" is offline or has no inboxUrl registered.`);
        }

        // Guard against SSRF: http(s) only, and reject link-local / cloud-metadata
        // (169.254.169.254) / unspecified egress targets so an attacker-registered
        // chair cannot turn the orchestrator into an SSRF proxy. Loopback chairs
        // stay allowed (the inbox is loopback-by-design); KOVAEL_CHAIR_BLOCK_PRIVATE
        // additionally blocks RFC1918/ULA.
        try {
            await assertSafeChairUrl(claim.inboxUrl, {
                blockPrivate: readBoolean(process.env.KOVAEL_CHAIR_BLOCK_PRIVATE, false),
            });
        } catch (err) {
            throw new Error(`Chair Bridge failure: Agent "${agentId}" inboxUrl rejected: ${(err as Error).message}`);
        }

        const requestId = crypto.randomUUID();
        const claimSessionId = claim.sessionId;
        const replyProofSecret = crypto.randomBytes(32).toString('hex');

        // Pending must exist before POST so a very fast chair reply can be
        // matched, but the reply timeout starts only after POST acceptance.
        let replyTimer: NodeJS.Timeout | undefined;
        let abortCleanup: (() => void) | undefined;
        let replySettled = false;
        const cleanupPending = () => {
            if (replyTimer) {
                clearTimeout(replyTimer);
                replyTimer = undefined;
            }
            if (abortCleanup) {
                abortCleanup();
                abortCleanup = undefined;
            }
            ChairBridgeProvider.pendingReplies.delete(requestId);
        };
        const replyReceived = new Promise<ResolvedChairReply>((resolve, reject) => {
            ChairBridgeProvider.pendingReplies.set(requestId, {
                requestId,
                topicId,
                agentId,
                claimSessionId,
                replyProofSecret,
                createdAt: Date.now(),
                resolve: (reply) => {
                    replySettled = true;
                    cleanupPending();
                    resolve(reply);
                },
                reject: (err) => {
                    replySettled = true;
                    cleanupPending();
                    reject(err);
                },
            });
        });
        const pending = ChairBridgeProvider.pendingReplies.get(requestId);

        // Make async POST to external agent inboxUrl
        try {
            const replyUrl = `http://localhost:${this.orchestratorPort}/api/v1/chairs/reply`;
            const payload = {
                system: opts.system,
                messages: opts.messages,
                topicId,
                agentId,
                replyUrl,
                requestId,
                claimSessionId,
                replyProofSecret,
            };
            const secured = secureChairDispatchBody(payload, requestId);

            const dispatchStartedAt = Date.now();
            if (pending) {
                pending.dispatchStartedAt = dispatchStartedAt;
            }
            this.emitDispatchEvent({
                type: 'chair_dispatch_started',
                requestId,
                topicId,
                agentId,
                claimSessionId,
                attempt: 0,
            });
            const dispatchResult = await this.postWithRetry(
                claim.inboxUrl,
                secured.body,
                opts.signal,
                requestId,
                topicId,
                agentId,
                claimSessionId,
                dispatchStartedAt,
                secured.headers,
            );
            const dispatchLatencyMs = Date.now() - dispatchStartedAt;
            if (pending) {
                pending.dispatchAttempts = dispatchResult.attempts;
                pending.dispatchLatencyMs = dispatchLatencyMs;
            }
            this.emitDispatchEvent({
                type: 'chair_dispatch_accepted',
                requestId,
                topicId,
                agentId,
                claimSessionId,
                dispatchAttempts: dispatchResult.attempts,
                dispatchLatencyMs,
            });

            if (!replySettled && ChairBridgeProvider.pendingReplies.has(requestId)) {
                const rejectAfterPostAbort = () => {
                    const active = ChairBridgeProvider.pendingReplies.get(requestId);
                    if (!active) return;
                    active.reject(new ChairBridgeDispatchFailure(
                        'chair bridge dispatch: aborted by caller',
                        pendingDispatchDetails(active),
                    ));
                };
                if (opts.signal?.aborted) {
                    rejectAfterPostAbort();
                } else {
                    opts.signal?.addEventListener('abort', rejectAfterPostAbort, { once: true });
                    abortCleanup = () => opts.signal?.removeEventListener('abort', rejectAfterPostAbort);
                }

                if (!replySettled && ChairBridgeProvider.pendingReplies.has(requestId)) {
                    replyTimer = setTimeout(() => {
                        const active = ChairBridgeProvider.pendingReplies.get(requestId);
                        if (!active) return;
                        active.reject(new ChairBridgeDispatchFailure(
                            `Chair Bridge timeout: Agent "${agentId}" did not reply in ${Math.round(replyTimeoutMs() / 1000)} seconds.`,
                            pendingDispatchDetails(active),
                        ));
                    }, replyTimeoutMs());
                }
            }
        } catch (err: any) {
            cleanupPending();
            if (err instanceof ChairBridgeDispatchFailure) {
                throw new ChairBridgeDispatchFailure(
                    `Chair Bridge dispatch failed for agent "${agentId}": ${err.message}`,
                    err.details,
                );
            }
            throw new Error(`Chair Bridge dispatch failed for agent "${agentId}": ${err.message}`);
        }

        // Await the external agent to post back to /api/v1/chairs/reply
        const reply = await replyReceived;
        this.lastDispatchReceipt = reply.receipt;
        const replyContent = reply.content;

        // Simulate streaming out the returned response
        const words = replyContent.split(' ');
        let yieldedChars = 0;

        for (let i = 0; i < words.length; i++) {
            if (opts.signal?.aborted) {
                break;
            }
            const word = words[i];
            const delta = i === 0 ? word : ' ' + word;
            yieldedChars += delta.length;
            yield { delta };

            // Natural typing delay: 5-15ms for playback
            const delay = 5 + Math.floor(Math.random() * 10);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        const runtimeMs = Date.now() - startTime;
        const inputChars = JSON.stringify(opts.messages).length;
        const inputTokens = Math.ceil(inputChars / 4);
        const outputTokens = Math.ceil(yieldedChars / 4);

        yield {
            delta: '',
            usage: {
                input: inputTokens,
                output: outputTokens,
                total: inputTokens + outputTokens,
                runtimeMs,
                source: 'reported',
            },
        };
    }
}
