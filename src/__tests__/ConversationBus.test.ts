import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ChairRegistry } from '../services/ChairRegistry.js';
import { PersonaLoader } from '../services/PersonaLoader.js';
import { ConversationBus } from '../services/ConversationBus.js';
import { ChairBridgeProvider } from '../services/ModelProvider.js';

describe('ConversationBus', () => {
    let db: DatabaseSync;
    let chairs: ChairRegistry;
    let personas: PersonaLoader;
    let bus: ConversationBus;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        chairs = new ChairRegistry();
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
