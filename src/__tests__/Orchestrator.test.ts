import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';
import { WebSocket } from 'ws';

describe('MeshOrchestrator', () => {
    let orchestrator: MeshOrchestrator;
    const PORT = 8081;

    beforeAll(async () => {
        orchestrator = new MeshOrchestrator(PORT);
        await orchestrator.ready();
    });

    afterAll(() => {
        orchestrator.close();
    });

    it('should allow WebSocket connections', async () => {
        const ws = new WebSocket(`ws://localhost:${PORT}?nodeId=test-node`);
        
        const isConnected = await new Promise((resolve) => {
            ws.on('open', () => {
                ws.close();
                resolve(true);
            });
            ws.on('error', () => resolve(false));
        });

        expect(isConnected).toBe(true);
    });

    it('should emit task_routed and return a VerificationReceipt when injectTask is called', async () => {
        const taskRoutedSpy = vi.fn();
        orchestrator.on('task_routed', taskRoutedSpy);

        const goal = 'Build a sovereign mesh';
        const receipt = await orchestrator.injectTask(goal);

        // injectTask returns a single VerificationReceipt, not an array
        expect(receipt).toMatchObject({
            id: expect.any(String),
            taskHash: expect.any(String),
            status: expect.stringMatching(/^(verified|failed)$/),
            architectId: expect.any(String),
            operatorId: expect.any(String),
            verifierId: expect.any(String),
        });

        // task_routed fires exactly once per injectTask call
        expect(taskRoutedSpy).toHaveBeenCalledTimes(1);
        expect(taskRoutedSpy).toHaveBeenCalledWith(expect.objectContaining({ goal, receipt }));
    });

    it('should inject compiled persona guidelines into the architect context', async () => {
        const mevBridge = (orchestrator as any).mevBridge;
        const architectSpy = vi.spyOn(mevBridge, 'architect');

        const goal = 'Synthesize graphics and telemetry';
        await orchestrator.injectTask(goal);

        expect(architectSpy).toHaveBeenCalled();
        const callArgs = architectSpy.mock.calls[0];
        const contextArg = callArgs[1] as any[]; // second parameter is context
        const systemMessage = contextArg.find((m: any) => m.role === 'system');

        expect(systemMessage).toBeDefined();
        expect(systemMessage.content).toContain('Your voice guidelines:');
        expect(systemMessage.content).toContain('Your disposition in the mesh:');

        architectSpy.mockRestore();
    });

    it('should support REST API endpoints for conversations', async () => {
        // 1. Create a conversation topic
        const createRes = await fetch(`http://localhost:${PORT}/api/v1/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'REST Banter Test',
                participants: ['nyx-antigravity', 'nyx-cli'],
            }),
        });
        expect(createRes.ok).toBe(true);
        const topic = await createRes.json() as any;
        expect(topic.id).toBeDefined();
        expect(topic.title).toBe('REST Banter Test');

        // 2. Post a message to the topic
        const postRes = await fetch(`http://localhost:${PORT}/api/v1/conversations/${topic.id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                senderId: 'nyx-antigravity',
                content: 'Hello over REST',
            }),
        });
        expect(postRes.ok).toBe(true);
        const msg = await postRes.json() as any;
        expect(msg.content).toBe('Hello over REST');

        // 3. Get history of the topic
        const historyRes = await fetch(`http://localhost:${PORT}/api/v1/conversations/${topic.id}/history`);
        expect(historyRes.ok).toBe(true);
        const history = await historyRes.json() as any[];
        expect(history.length).toBeGreaterThanOrEqual(1);
        expect(history[0].content).toBe('Hello over REST');

        // 4. Close the conversation
        const closeRes = await fetch(`http://localhost:${PORT}/api/v1/conversations/${topic.id}/close`, {
            method: 'POST',
        });
        expect(closeRes.ok).toBe(true);
        const closeResult = await closeRes.json() as any;
        expect(closeResult.success).toBe(true);
    });
});
