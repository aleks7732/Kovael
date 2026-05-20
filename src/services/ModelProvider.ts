import { ChairRegistry } from './ChairRegistry.js';

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
export class ChairBridgeProvider implements ModelProvider {
    private static pendingReplies = new Map<string, (reply: string) => void>();

    constructor(
        public id: string,
        private chairs: ChairRegistry,
        private orchestratorPort: number
    ) {}

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
        let replyPromise: Promise<string>;

        // Set up the reply receiver promise
        const replyReceived = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                ChairBridgeProvider.pendingReplies.delete(key);
                reject(new Error(`Chair Bridge timeout: Agent "${agentId}" did not reply in 30 seconds.`));
            }, 30000);

            ChairBridgeProvider.pendingReplies.set(key, (content: string) => {
                clearTimeout(timeout);
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
            };

            const response = await fetch(claim.inboxUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: opts.signal,
            });

            if (!response.ok) {
                throw new Error(`External agent inboxUrl returned status ${response.status}`);
            }
        } catch (err: any) {
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
