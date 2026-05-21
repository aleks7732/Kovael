import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ChairRegistry } from '../services/ChairRegistry.js';
import { PersonaLoader } from '../services/PersonaLoader.js';
import { ConversationBus } from '../services/ConversationBus.js';
import { ChairBridgeProvider } from '../services/ModelProvider.js';
import { openOrchestratorDb } from '../services/OrchestratorDb.js';

describe('ConversationBus', () => {
    let db: DatabaseSync;
    let chairs: ChairRegistry;
    let personas: PersonaLoader;
    let bus: ConversationBus;

    beforeEach(() => {
        db = openOrchestratorDb({ path: ':memory:' }).db;
        chairs = new ChairRegistry({}, db);
        chairs.start();

        // Instantiate PersonaLoader pointing to a mock or empty dir for test isolation
        personas = new PersonaLoader();
        personas.start();

        bus = new ConversationBus(db, chairs, personas, 8080);
    });

    afterEach(() => {
        chairs.stop();
        personas.stop();
        db.close();
    });

    it('creates, persists, and closes conversation topics', () => {
        const title = 'Design global retry rules';
        const participants = ['nyx-antigravity', 'shaev'];

        const topic = bus.createTopic(title, participants);

        expect(topic.id).toBeDefined();
        expect(topic.title).toBe(title);
        expect(topic.participants).toEqual(participants);
        expect(topic.active).toBe(true);

        // Verify SQLite entry
        const stmt = db.prepare('SELECT * FROM conversation_topics WHERE id = ?');
        const row = stmt.get(topic.id) as any;
        expect(row).toBeDefined();
        expect(row.title).toBe(title);
        expect(row.active).toBe(1);

        // Verify view sequence
        const seqStmt = db.prepare('SELECT * FROM conversation_topics_seq WHERE id = ?');
        const seqRow = seqStmt.get(topic.id) as any;
        expect(seqRow).toBeDefined();
        expect(seqRow.message_count).toBe(0);

        // Close topic
        bus.closeTopic(topic.id);
        const closedRow = stmt.get(topic.id) as any;
        expect(closedRow.active).toBe(0);
    });

    it('posts messages and retrieves thread history', () => {
        const topic = bus.createTopic('Thread Test', ['nyx-cli']);

        bus.postMessage(topic.id, 'user', 'user', 'Hello CLI');
        bus.postMessage(topic.id, 'nyx-cli', 'assistant', 'Acknowledged. Subshell clean.');

        const history = bus.getHistory(topic.id);
        expect(history).toHaveLength(2);
        expect(history[0].role).toBe('user');
        expect(history[0].content).toBe('Hello CLI');
        expect(history[0].name).toBe('user');

        expect(history[1].role).toBe('assistant');
        expect(history[1].content).toBe('Acknowledged. Subshell clean.');
        expect(history[1].name).toBe('nyx-cli');
    });

    it('getHistory returns the most recent N messages, in chronological order', () => {
        const topic = bus.createTopic('Sharding Sanity', ['nyx-cli']);

        // Post 10 messages in order; timestamps are auto from Date.now() so we
        // assert ordering by content.
        for (let i = 0; i < 10; i++) {
            bus.postMessage(topic.id, 'nyx-cli', 'assistant', `turn ${i}`);
        }

        const recent3 = bus.getHistory(topic.id, 3);
        expect(recent3).toHaveLength(3);
        // Most-recent-3 should be turns 7, 8, 9 in ASC order — NOT 0, 1, 2.
        expect(recent3[0].content).toBe('turn 7');
        expect(recent3[1].content).toBe('turn 8');
        expect(recent3[2].content).toBe('turn 9');
    });

    it('correctly parses @mention tokens in message content', () => {
        const text = 'Hey @shaev, check out @nyx-cli hoodie details!';
        const mentions = bus.parseMentions(text);

        expect(mentions).toContain('shaev');
        expect(mentions).toContain('nyx-cli');
        expect(mentions).toHaveLength(2);
    });

    it('streams simulated model answers using StubMarkovProvider', async () => {
        const topic = bus.createTopic('Banter Session', ['nyx-antigravity', 'nyx-cli']);
        
        const busEvents: any[] = [];
        bus.on('bus_event', (e) => busEvents.push(e));

        // Trigger the multi-agent round-table debate
        await bus.convene(topic.id, 'Optimize retry jitter');

        // Verify we received streaming deltas
        const deltas = busEvents.filter((e) => e.type === 'conversation_message_delta');
        expect(deltas.length).toBeGreaterThan(0);

        // Verify there is an end token
        const endTokens = deltas.filter((e) => e.isEnd === true);
        expect(endTokens.length).toBeGreaterThan(0);
        expect(endTokens[0].usage).toBeDefined();

        // Verify stopping criterion event was emitted
        const stopping = busEvents.find((e) => e.type === 'conversation_stopping_criterion');
        expect(stopping).toBeDefined();
    }, 15000);

    it('bridges execution to live chairs using ChairBridgeProvider and handles replies', async () => {
        // Register/Claim a live chair with an inboxUrl
        chairs.claim({
            agentId: 'nyx-openclaw',
            provider: 'OpenAI GPT-4',
            inboxUrl: 'http://localhost:9999/inbox',
        });

        const topic = bus.createTopic('Interactive Session', ['nyx-openclaw']);

        // Mock global fetch for ChairBridgeProvider outbound POST dispatch
        const originalFetch = global.fetch;
        let postBody: any = null;

        global.fetch = async (url, init) => {
            postBody = JSON.parse(init?.body as string);
            return {
                ok: true,
                status: 200,
            } as Response;
        };

        const busEvents: any[] = [];
        bus.on('bus_event', (e) => busEvents.push(e));

        // Convene the conversation on a background promise so we can submit reply
        const convenePromise = bus.convene(topic.id, 'Build arcade retro cabinet');

        // Wait a short moment for the post to fire
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(postBody).not.toBeNull();
        expect(postBody.topicId).toBe(topic.id);
        expect(postBody.agentId).toBe('nyx-openclaw');

        // Submit reply webhook back to ChairBridgeProvider
        const replyText = 'Cabinet frame completed with cherry wood veneer.';
        const routed = ChairBridgeProvider.submitReply(topic.id, 'nyx-openclaw', replyText);
        expect(routed).toBe(true);

        await convenePromise;

        // Restore global fetch
        global.fetch = originalFetch;

        // Verify SQL record has the routed reply
        const history = bus.getHistory(topic.id);
        const agentReply = history.find((h) => h.name === 'nyx-openclaw');
        expect(agentReply).toBeDefined();
        expect(agentReply!.content).toBe(replyText);
    });
});

describe('ChairBridgeProvider · dispatch policy (loop iter 08)', () => {
    let chairs: ChairRegistry;
    const ORCH_PORT = 0; // /api/v1/chairs/reply isn't called in these tests

    beforeEach(() => {
        chairs = new ChairRegistry();
        chairs.start();
        chairs.claim({
            agentId: 'nyx-dispatch-test',
            provider: 'OpenAI GPT-4',
            inboxUrl: 'http://localhost:9999/inbox',
        });
    });

    afterEach(() => {
        chairs.stop();
    });

    async function consumeStream(it: AsyncIterable<{ delta: string }>) {
        const out: string[] = [];
        for await (const d of it) out.push(d.delta);
        return out;
    }

    it('retries on 503 and succeeds on the second attempt', async () => {
        const calls: string[] = [];
        const originalFetch = global.fetch;
        let attempt = 0;
        global.fetch = (async (url: any) => {
            calls.push(String(url));
            attempt += 1;
            if (attempt === 1) {
                return new Response('', { status: 503 });
            }
            return new Response('', { status: 200 });
        }) as typeof fetch;

        try {
            const provider = new ChairBridgeProvider(
                'nyx-dispatch-test',
                chairs,
                ORCH_PORT,
                { dispatchTimeoutMs: 1000, maxAttempts: 3, baseBackoffMs: 5 },
            );

            // Fire dispatch on a background promise; resolve the reply
            // manually so the stream completes.
            const streamPromise = consumeStream(provider.stream({
                system: 'sys',
                messages: [{ role: 'user', content: 'hi' }],
                topicId: 'topic-dispatch-503',
                agentId: 'nyx-dispatch-test',
            } as any));

            // Wait long enough for the retry to fire, then deliver the reply.
            await new Promise((r) => setTimeout(r, 100));
            ChairBridgeProvider.submitReply('topic-dispatch-503', 'nyx-dispatch-test', 'ack');

            const deltas = await streamPromise;
            expect(deltas.join('')).toContain('ack');
            expect(calls.length).toBe(2); // one retry
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('does NOT retry on 400 (non-retryable status)', async () => {
        const originalFetch = global.fetch;
        let attempts = 0;
        global.fetch = (async () => {
            attempts += 1;
            return new Response('bad request', { status: 400 });
        }) as typeof fetch;

        try {
            const provider = new ChairBridgeProvider(
                'nyx-dispatch-test',
                chairs,
                ORCH_PORT,
                { dispatchTimeoutMs: 1000, maxAttempts: 5, baseBackoffMs: 5 },
            );

            await expect(consumeStream(provider.stream({
                system: 's',
                messages: [{ role: 'user', content: 'hi' }],
                topicId: 'topic-dispatch-400',
                agentId: 'nyx-dispatch-test',
            } as any))).rejects.toThrow(/non-retryable 400/);

            expect(attempts).toBe(1);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('times out a single attempt and retries (network black hole)', async () => {
        const originalFetch = global.fetch;
        let attempts = 0;
        // Simulate a black-hole upstream: never resolve, must be aborted.
        global.fetch = ((_url: any, init: any) => {
            attempts += 1;
            return new Promise((_, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('aborted', 'AbortError'));
                });
            });
        }) as typeof fetch;

        try {
            const provider = new ChairBridgeProvider(
                'nyx-dispatch-test',
                chairs,
                ORCH_PORT,
                { dispatchTimeoutMs: 50, maxAttempts: 2, baseBackoffMs: 5 },
            );

            await expect(consumeStream(provider.stream({
                system: 's',
                messages: [{ role: 'user', content: 'hi' }],
                topicId: 'topic-dispatch-blackhole',
                agentId: 'nyx-dispatch-test',
            } as any))).rejects.toThrow(/Chair Bridge dispatch failed/);

            expect(attempts).toBe(2); // exhausted both attempts on timeout
        } finally {
            global.fetch = originalFetch;
        }
    });
});
