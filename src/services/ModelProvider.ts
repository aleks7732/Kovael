import { ChairRegistry } from './ChairRegistry.js';
import crypto from 'node:crypto';

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

export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
    dispatchTimeoutMs: 10_000,
    maxAttempts: 3,
    baseBackoffMs: 250,
};

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export class ChairBridgeProvider implements ModelProvider {
    private static pendingReplies = new Map<string, (reply: string) => void>();
    private readonly policy: DispatchPolicy;

    constructor(
        public id: string,
        private chairs: ChairRegistry,
        private orchestratorPort: number,
        policy: Partial<DispatchPolicy> = {},
    ) {
        this.policy = { ...DEFAULT_DISPATCH_POLICY, ...policy };
    }

    /**
     * Receive and route reply from HTTP webhook endpoint back to the suspended stream promise.
     */
    public static submitReply(topicId: string, agentId: string, content: string): boolean {
        const key = `${topicId}:${agentId}`;
        const resolver = this.pendingReplies.get(key);
        if (resolver) {
            resolver(content);
            this.pendingReplies.delete(key);
            return true;
        }
        return false;
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
    ): Promise<void> {
        let lastErr: Error = new Error('chair bridge dispatch: no attempts ran');
        for (let attempt = 0; attempt < this.policy.maxAttempts; attempt += 1) {
            if (parentSignal?.aborted) {
                throw new Error('chair bridge dispatch: aborted by caller');
            }

            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), this.policy.dispatchTimeoutMs);
            // Chain parent abort → this attempt's abort.
            const onParentAbort = () => ctrl.abort();
            parentSignal?.addEventListener('abort', onParentAbort, { once: true });

            let response: Response | null = null;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-kovael-request-id': requestId,
                    },
                    body,
                    signal: ctrl.signal,
                });
            } catch (err) {
                lastErr = err instanceof Error ? err : new Error(String(err));
                // AbortError from caller-signal must surface immediately —
                // it is not a transient failure, it is intent.
                if (parentSignal?.aborted) throw lastErr;
            } finally {
                clearTimeout(timer);
                parentSignal?.removeEventListener('abort', onParentAbort);
            }

            if (response) {
                if (response.ok) return;
                // Non-retryable status — surface immediately. Don't burn
                // attempts on a 400/401/403/404; the upstream isn't going
                // to start agreeing with us.
                if (!RETRYABLE_STATUS.has(response.status)) {
                    throw new Error(`upstream returned non-retryable ${response.status}`);
                }
                lastErr = new Error(`upstream returned retryable ${response.status}`);
            }

            // Don't sleep after the last attempt — fall through to throw.
            if (attempt < this.policy.maxAttempts - 1) {
                const cap = this.policy.baseBackoffMs * Math.pow(2, attempt);
                const delay = Math.floor(Math.random() * cap);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        throw lastErr;
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

        const key = `${topicId}:${agentId}`;

        // Reply timeout captured here so the dispatch-failure path can
        // cancel it. Leaving it inside the Promise closure would leak a
        // ghost 30s timer per failed dispatch.
        let replyTimer: NodeJS.Timeout | undefined;
        const replyReceived = new Promise<string>((resolve, reject) => {
            replyTimer = setTimeout(() => {
                ChairBridgeProvider.pendingReplies.delete(key);
                reject(new Error(`Chair Bridge timeout: Agent "${agentId}" did not reply in 30 seconds.`));
            }, 30000);

            ChairBridgeProvider.pendingReplies.set(key, (content: string) => {
                if (replyTimer) clearTimeout(replyTimer);
                resolve(content);
            });
        });

        // Make async POST to external agent inboxUrl
        try {
            const replyUrl = `http://localhost:${this.orchestratorPort}/api/v1/chairs/reply`;
            const payload = {
                system: opts.system,
                messages: opts.messages,
                topicId,
                agentId,
                replyUrl,
                requestId: crypto.randomUUID(),
            };

            await this.postWithRetry(claim.inboxUrl, JSON.stringify(payload), opts.signal, payload.requestId);
        } catch (err: any) {
            if (replyTimer) clearTimeout(replyTimer);
            ChairBridgeProvider.pendingReplies.delete(key);
            throw new Error(`Chair Bridge dispatch failed for agent "${agentId}": ${err.message}`);
        }

        // Await the external agent to post back to /api/v1/chairs/reply
        const replyContent = await replyReceived;

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
