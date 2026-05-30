import { describe, it, expect } from 'vitest';
import { StubMarkovProvider } from '../services/StubMarkovProvider.js';
import type { ModelProviderOptions } from '../services/ModelProvider.js';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function collect(
    provider: StubMarkovProvider,
    opts: ModelProviderOptions,
): Promise<{ deltas: string[]; usage: import('../services/ModelProvider.js').TokenUsage | undefined }> {
    const deltas: string[] = [];
    let usage: import('../services/ModelProvider.js').TokenUsage | undefined;

    for await (const chunk of provider.stream(opts)) {
        if (chunk.usage) {
            usage = chunk.usage;
        } else {
            deltas.push(chunk.delta);
        }
    }
    return { deltas, usage };
}

function opts(overrides: Partial<ModelProviderOptions> = {}): ModelProviderOptions {
    return {
        system: 'You are a sovereign mesh coordinator.',
        messages: [
            { role: 'user', content: 'What is the status of the mesh?' },
            { role: 'assistant', content: 'Mesh status is nominal. Routing is stable.' },
        ],
        ...overrides,
    };
}

// -------------------------------------------------------------------------
// StubMarkovProvider
// -------------------------------------------------------------------------

describe('StubMarkovProvider — basic streaming', () => {
    it('yields at least one delta token', async () => {
        const provider = new StubMarkovProvider('stub-1');
        const { deltas } = await collect(provider, opts());
        expect(deltas.length).toBeGreaterThan(0);
    }, 15_000);

    it('concatenated output is a non-empty string', async () => {
        const provider = new StubMarkovProvider('stub-1');
        const { deltas } = await collect(provider, opts());
        const text = deltas.join('');
        expect(text.trim().length).toBeGreaterThan(0);
    }, 15_000);

    it('yields a final usage chunk with source: estimate', async () => {
        const provider = new StubMarkovProvider('stub-1');
        const { usage } = await collect(provider, opts());
        expect(usage).toBeDefined();
        expect(usage!.source).toBe('estimate');
    }, 15_000);

    it('usage.total equals input + output', async () => {
        const provider = new StubMarkovProvider('stub-1');
        const { usage } = await collect(provider, opts());
        expect(usage!.total).toBe(usage!.input + usage!.output);
    }, 15_000);

    it('usage.runtimeMs is a positive number', async () => {
        const provider = new StubMarkovProvider('stub-1');
        const { usage } = await collect(provider, opts());
        expect(usage!.runtimeMs).toBeGreaterThan(0);
    }, 15_000);

    it('exposes the id passed to the constructor', () => {
        const provider = new StubMarkovProvider('my-provider-id');
        expect(provider.id).toBe('my-provider-id');
    });
});

describe('StubMarkovProvider — corpus edge cases', () => {
    it('uses fallback phrase when corpus is empty', async () => {
        const provider = new StubMarkovProvider('stub-empty');
        const { deltas } = await collect(provider, {
            system: '',
            messages: [],
        });
        const text = deltas.join('');
        // The fallback sentence from the implementation
        expect(text).toContain('Acknowledged');
    }, 5_000);

    it('works with a single-word corpus without hanging', async () => {
        const provider = new StubMarkovProvider('stub-single');
        const { deltas } = await collect(provider, {
            system: 'hello',
            messages: [],
        });
        expect(deltas.length).toBeGreaterThan(0);
    }, 15_000);
});

describe('StubMarkovProvider — AbortSignal', () => {
    it('stops streaming when the signal is aborted', async () => {
        const controller = new AbortController();
        const provider = new StubMarkovProvider('stub-abort');

        let count = 0;
        // Abort after the very first delta
        for await (const chunk of provider.stream({ ...opts(), signal: controller.signal })) {
            if (!chunk.usage) {
                count++;
                if (count === 1) controller.abort();
            }
        }

        // Should have received very few deltas — certainly not the full 40-80
        expect(count).toBeLessThan(10);
    }, 15_000);
});
