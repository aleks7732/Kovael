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
});
