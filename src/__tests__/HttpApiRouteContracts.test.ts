import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';

describe('HttpApiRouter — route contracts', () => {
    let orchestrator: MeshOrchestrator;
    let port = 0;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(0, { dbPath: ':memory:' });
        port = await orchestrator.ready();
    });

    afterAll(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        orchestrator.close();
    });

    const api = (path: string) => `http://127.0.0.1:${port}${path}`;

    it('GET /api/v1/state returns the stable top-level state shape', async () => {
        const res = await fetch(api('/api/v1/state'));
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');

        const body = await res.json() as Record<string, unknown>;
        expect(body).toMatchObject({
            agentCards: expect.any(Number),
            connectedClients: expect.any(Number),
            nodes: expect.any(Number),
            tasksTotal: expect.any(Number),
            receiptsIssued: expect.any(Number),
            claims: expect.objectContaining({
                stats: expect.any(Object),
                pending: expect.any(Array),
            }),
            chairs: expect.objectContaining({
                stats: expect.any(Object),
                roster: expect.any(Array),
            }),
            circuits: expect.any(Array),
            learningMatrix: expect.objectContaining({
                entries: expect.any(Number),
            }),
        });
    });

    it('chair snapshot and method handling remain stable', async () => {
        const snapshot = await fetch(api('/api/v1/chairs/snapshot'));
        expect(snapshot.status).toBe(200);
        expect(await snapshot.json()).toMatchObject({
            chairs: expect.any(Array),
            stats: expect.any(Object),
        });

        const unsupported = await fetch(api('/api/v1/chairs/claim'), { method: 'GET' });
        expect(unsupported.status).toBe(405);
        expect(await unsupported.json()).toEqual({ error: 'method_not_allowed' });
    });

    it('chair claim, heartbeat, and release routes preserve session semantics', async () => {
        const claim = await fetch(api('/api/v1/chairs/claim'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'contract-chair', provider: 'vitest' }),
        });
        expect(claim.status).toBe(200);
        const claimed = await claim.json() as { agentId: string; sessionId: string };
        expect(claimed.agentId).toBe('contract-chair');
        expect(typeof claimed.sessionId).toBe('string');

        const heartbeat = await fetch(api('/api/v1/chairs/heartbeat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: claimed.agentId, sessionId: claimed.sessionId }),
        });
        expect(heartbeat.status).toBe(200);
        expect(await heartbeat.json()).toMatchObject({
            status: expect.any(String),
            lastBeaconAt: expect.any(Number),
        });

        const release = await fetch(api('/api/v1/chairs/release'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: claimed.agentId, sessionId: claimed.sessionId }),
        });
        expect(release.status).toBe(200);
        expect(await release.json()).toEqual({ released: true });
    });

    it('conversation topic, message, history, and close routes preserve JSON contracts', async () => {
        const topicRes = await fetch(api('/api/v1/conversations'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Contract Topic', participants: ['nyx-codex'] }),
        });
        expect(topicRes.status).toBe(200);
        const topic = await topicRes.json() as { id: string; title: string };
        expect(topic.title).toBe('Contract Topic');

        const messageRes = await fetch(api(`/api/v1/conversations/${topic.id}/message`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ senderId: 'operator', content: 'hello' }),
        });
        expect(messageRes.status).toBe(200);
        expect(await messageRes.json()).toMatchObject({
            topicId: topic.id,
            senderId: 'operator',
            role: 'user',
            content: 'hello',
        });

        const historyRes = await fetch(api(`/api/v1/conversations/${topic.id}/history`));
        expect(historyRes.status).toBe(200);
        expect(Array.isArray(await historyRes.json())).toBe(true);

        const closeRes = await fetch(api(`/api/v1/conversations/${topic.id}/close`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(closeRes.status).toBe(200);
        expect(await closeRes.json()).toEqual({ success: true });
    });

    it('creating a conversation with a goal starts replies from only the selected participants', async () => {
        const participants = ['nyx-codex', 'shaev', 'nyx-openclaw'];
        const topicRes = await fetch(api('/api/v1/conversations'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Selected Chair Dispatch',
                participants,
                goal: 'Each selected chair should reply once.',
            }),
        });
        expect(topicRes.status).toBe(200);
        const topic = await topicRes.json() as { id: string; participants: string[] };
        expect(topic.participants).toEqual(participants);

        const history = await waitForConversationHistory(api, topic.id, participants.length);
        const assistantNames = history
            .filter((message) => message.role === 'assistant')
            .map((message) => message.name)
            .filter((name): name is string => typeof name === 'string');
        const uniqueAssistantNames = Array.from(new Set(assistantNames)).sort();

        expect(uniqueAssistantNames).toEqual([...participants].sort());
    }, 15000);

    it('trace routes preserve list, detail miss, and reroute contracts', async () => {
        const list = await fetch(api('/api/v1/traces?limit=5'));
        expect(list.status).toBe(200);
        expect(await list.json()).toMatchObject({
            items: expect.any(Array),
        });

        const missing = await fetch(api('/api/v1/traces/missing-cycle-id'));
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
            error: 'trace_not_found',
            cycleId: 'missing-cycle-id',
        });

        const reroute = await fetch(api('/api/v1/traces/reroute'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'agent.a', target: 'trace:b', sourceHandle: 'out' }),
        });
        expect(reroute.status).toBe(200);
        expect(await reroute.json()).toMatchObject({
            type: 'trace.rerouted',
            source: 'agent.a',
            target: 'trace:b',
            sourceHandle: 'out',
            requestedAt: expect.any(Number),
        });
    });

    it('Comfy render and stream-url routes preserve fallback metadata contracts', async () => {
        const render = await fetch(api('/api/v1/comfy/mix'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agentId: 'nyx-codex',
                prompt: 'operator portrait',
                aspectRatio: 'theater-card',
                mixer: [{ recipeId: 'nyx\nrecipe', strength: 5, denoise: -1 }],
            }),
        });
        expect(render.status).toBe(200);
        const rendered = await render.json() as Record<string, unknown>;
        expect(rendered).toMatchObject({
            source: 'fallback',
            agentId: 'nyx-codex',
            width: 1280,
            height: 720,
            mimeType: 'image/svg+xml',
        });
        expect(rendered).not.toHaveProperty('workflow');

        const streamUrl = await fetch(api('/api/v1/comfy/stream-url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promptId: 'prompt-123', clientId: 'client-1' }),
        });
        expect(streamUrl.status).toBe(200);
        expect(await streamUrl.json()).toMatchObject({
            promptId: 'prompt-123',
        });
    });

    it('unknown route-family actions preserve 404 JSON errors', async () => {
        const chairs = await fetch(api('/api/v1/chairs/not-a-real-action'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(chairs.status).toBe(404);
        expect(await chairs.json()).toEqual({
            error: 'unknown_chair_action',
            action: 'not-a-real-action',
        });

        const comfy = await fetch(api('/api/v1/comfy/not-a-real-action'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(comfy.status).toBe(404);
        expect(await comfy.json()).toEqual({
            error: 'unknown_comfy_action',
            action: 'not-a-real-action',
        });
    });
});

type HistoryMessage = {
    role: string;
    name?: string;
    content: string;
};

async function waitForConversationHistory(
    api: (path: string) => string,
    topicId: string,
    assistantCount: number,
): Promise<HistoryMessage[]> {
    const deadline = Date.now() + 10_000;
    let lastHistory: HistoryMessage[] = [];
    while (Date.now() < deadline) {
        const historyRes = await fetch(api(`/api/v1/conversations/${topicId}/history`));
        expect(historyRes.status).toBe(200);
        lastHistory = await historyRes.json() as HistoryMessage[];
        const uniqueAssistants = new Set(
            lastHistory
                .filter((message) => message.role === 'assistant' && typeof message.name === 'string')
                .map((message) => message.name),
        );
        if (uniqueAssistants.size >= assistantCount) return lastHistory;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${assistantCount} assistant replies; last history: ${JSON.stringify(lastHistory)}`);
}
