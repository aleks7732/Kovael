import type { ModelProvider, ModelProviderOptions, TokenUsage } from './ModelProvider.js';

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
