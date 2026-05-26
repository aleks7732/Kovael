import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ChairRegistry } from '../services/ChairRegistry.js';
import { PersonaLoader } from '../services/PersonaLoader.js';
import { ConversationBus } from '../services/ConversationBus.js';
import { ChairBridgeProvider } from '../services/ModelProvider.js';
import { openOrchestratorDb } from '../services/OrchestratorDb.js';
import { createChairReplyProof } from '../services/ChairDispatchSecurity.js';

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

    it('gives every selected participant one turn before adaptive stopping can end the round', async () => {
        const participants = ['nyx-codex', 'shaev', 'nyx-openclaw'];
        for (const agentId of participants) {
            chairs.claim({
                agentId,
                provider: 'vitest',
                inboxUrl: `http://localhost:9999/${agentId}/inbox`,
            });
        }

        const topic = bus.createTopic('First Pass Guarantee', participants);
        const originalFetch = global.fetch;
        const randomSpy = vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0.8)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0.4)
            .mockReturnValue(0.4);

        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(String(init?.body ?? '{}')) as { topicId: string; agentId: string };
            queueMicrotask(() => {
                ChairBridgeProvider.submitReply(payload.topicId, payload.agentId, `ack-${payload.agentId}`);
            });
            return new Response('', { status: 200 });
        }) as typeof fetch;

        try {
            await bus.convene(topic.id, 'Each selected chair replies once.');
        } finally {
            global.fetch = originalFetch;
            randomSpy.mockRestore();
        }

        const assistantNames = bus.getHistory(topic.id)
            .filter((message) => message.role === 'assistant')
            .map((message) => message.name)
            .filter((name): name is string => typeof name === 'string' && participants.includes(name));

        expect(Array.from(new Set(assistantNames)).sort()).toEqual([...participants].sort());
    }, 10000);

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
        expect(busEvents).toContainEqual(expect.objectContaining({
            type: 'chair_dispatch_success',
            agentId: 'nyx-openclaw',
            topicId: topic.id,
            dispatchAttempts: 1,
            dispatchLatencyMs: expect.any(Number),
        }));
    });

    it('dispatches lean system prompts without persona lore preamble', async () => {
        chairs.claim({
            agentId: 'nyx-openclaw',
            provider: 'vitest',
            inboxUrl: 'http://localhost:9999/inbox',
        });

        const topic = bus.createTopic('Lean Prompt Dispatch', ['nyx-openclaw']);
        const originalFetch = global.fetch;
        let postBody: { system: string; topicId: string; agentId: string } | null = null;

        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            postBody = JSON.parse(String(init?.body ?? '{}')) as typeof postBody;
            queueMicrotask(() => {
                if (postBody) {
                    ChairBridgeProvider.submitReply(postBody.topicId, postBody.agentId, 'ack');
                }
            });
            return new Response('', { status: 200 });
        }) as typeof fetch;

        try {
            await bus.convene(topic.id, 'Answer without boilerplate.');
        } finally {
            global.fetch = originalFetch;
        }

        expect(postBody).not.toBeNull();
        expect(postBody!.system.length).toBeLessThanOrEqual(180);
        expect(postBody!.system).not.toMatch(/Lore\/Background|Voice Register|Catchphrases|Dispositions|Expertise|forbidden/i);
        expect(bus.getHistory(topic.id)[0].content).toBe('Answer without boilerplate.');
    });

    it('does not fake smart replies for claimed chairs without dispatch inboxes', async () => {
        chairs.claim({
            agentId: 'nyx-presence-only',
            provider: 'vitest',
        });

        const topic = bus.createTopic('Presence Only Dispatch', ['nyx-presence-only']);
        const busEvents: any[] = [];
        bus.on('bus_event', (event) => busEvents.push(event));

        await bus.convene(topic.id, 'Answer through the real chair pipe.');

        const history = bus.getHistory(topic.id);
        const assistant = history.find((message) => message.role === 'assistant');
        const unavailable = busEvents.find((event) => event.type === 'chair_dispatch_unavailable');

        expect(assistant?.name).toBe('nyx-presence-only');
        expect(assistant?.content).toContain('no dispatch inbox');
        expect(history.at(-1)?.name).toBe('convener');
        expect(history.at(-1)?.content).toContain('RESULT:');
        expect(history.at(-1)?.role).toBe('system');
        expect(history.at(-1)?.content).toContain('Presence-only chairs: nyx-presence-only');
        expect(unavailable).toMatchObject({
            agentId: 'nyx-presence-only',
            reason: 'missing_inbox_url',
        });
    });

    it('records runtime error replies as failed turns, not successful assistant messages', async () => {
        chairs.claim({
            agentId: 'shaev',
            provider: 'vitest',
            inboxUrl: 'http://localhost:9999/inbox',
        });

        const topic = bus.createTopic('Runtime Failure Dispatch', ['shaev']);
        const busEvents: any[] = [];
        const originalFetch = global.fetch;
        let dispatch: Record<string, string> | null = null;
        bus.on('bus_event', (event) => busEvents.push(event));

        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            queueMicrotask(() => {
                if (dispatch) {
                    ChairBridgeProvider.submitReplyForRequest({
                        requestId: dispatch.requestId,
                        agentId: dispatch.agentId,
                        topicId: dispatch.topicId,
                        claimSessionId: dispatch.claimSessionId,
                        replyProof: createChairReplyProof({
                            requestId: dispatch.requestId,
                            claimSessionId: dispatch.claimSessionId,
                            replyProofSecret: dispatch.replyProofSecret,
                        }),
                        content: 'Runtime error from shaev: adapter crashed',
                        status: 'failed',
                        error: 'adapter crashed',
                    });
                }
            });
            return new Response('', { status: 200 });
        }) as typeof fetch;

        try {
            await bus.convene(topic.id, 'Fail honestly.');
        } finally {
            global.fetch = originalFetch;
        }

        expect(busEvents.some((event) => event.type === 'chair_dispatch_success')).toBe(false);
        expect(busEvents).toContainEqual(expect.objectContaining({
            type: 'chair_dispatch_failure',
            agentId: 'shaev',
            topicId: topic.id,
        }));
        expect(bus.getHistory(topic.id).some((message) => message.name === 'shaev' && message.role === 'assistant')).toBe(false);
        expect(bus.getHistory(topic.id).at(-1)?.content).toContain('Failed turns: shaev');
    });

    it('includes attempt and latency fields on dispatch POST failure events', async () => {
        chairs.claim({
            agentId: 'shaev',
            provider: 'vitest',
            inboxUrl: 'http://localhost:9999/inbox',
        });

        const topic = bus.createTopic('Dispatch POST Failure', ['shaev']);
        const busEvents: Array<Record<string, unknown>> = [];
        const originalFetch = global.fetch;
        bus.on('bus_event', (event) => busEvents.push(event));
        global.fetch = (async () => new Response('bad request', { status: 400 })) as typeof fetch;

        try {
            await bus.convene(topic.id, 'Fail before acceptance.');
        } finally {
            global.fetch = originalFetch;
        }

        expect(busEvents).toContainEqual(expect.objectContaining({
            type: 'chair_dispatch_failure',
            agentId: 'shaev',
            topicId: topic.id,
            dispatchAttempts: 1,
            dispatchLatencyMs: expect.any(Number),
        }));
    });

    it('persists a final convener result after every convene run', async () => {
        const participants = ['nyx-codex', 'nyx-openclaw'];
        for (const agentId of participants) {
            chairs.claim({
                agentId,
                provider: 'vitest',
            });
        }
        const topic = bus.createTopic('Final Result Contract', participants);

        await bus.convene(topic.id, 'Return a visible result.');

        const history = bus.getHistory(topic.id);
        const result = history.at(-1);

        expect(result?.name).toBe('convener');
        expect(result?.role).toBe('system');
        expect(result?.content).toContain('RESULT: Convener completed "Final Result Contract".');
        expect(result?.content).toContain('Selected chairs: nyx-codex, nyx-openclaw.');
    });

    it('emits committee lifecycle events with quorum verdict and trace lanes', () => {
        const topic = bus.createTopic('Committee Session', ['nyx-codex', 'shaev', 'nyx-openclaw']);
        const events: any[] = [];
        bus.on('bus_event', (event) => events.push(event));

        const verdict = bus.conveneCommittee(topic.id, 'Settle the reroute plan', {
            traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
            tracestate: 'vendor=a',
            votes: [
                { agentId: 'nyx-codex', role: 'proponent', verdict: 'approve', confidence: 0.95, rationale: 'clear' },
                { agentId: 'shaev', role: 'judge', verdict: 'approve', confidence: 0.93, rationale: 'verified' },
                { agentId: 'nyx-openclaw', role: 'critic', verdict: 'approve', confidence: 0.9, rationale: 'safe' },
            ],
        });

        expect(verdict.status).toBe('accepted');
        expect(verdict.trace.traceparent).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
        expect(verdict.trace.lanes).toHaveLength(3);
        expect(events.map((event) => event.type)).toEqual([
            'committee.started',
            'committee.vote',
            'committee.vote',
            'committee.vote',
            'committee.verdict',
        ]);
        const history = bus.getHistory(topic.id);
        expect(history.at(-1)?.content).toContain('Committee accepted');
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
