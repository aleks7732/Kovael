import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';
import { WebSocket } from 'ws';

describe('MeshOrchestrator', () => {
    let orchestrator: MeshOrchestrator;
    const PORT = 8081;

    beforeAll(() => {
        orchestrator = new MeshOrchestrator(PORT);
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

    it('should emit the correct number of sub-tasks when injectTask is called', async () => {
        const taskRoutedSpy = vi.fn();
        orchestrator.on('task_routed', taskRoutedSpy);

        const goal = 'Build a sovereign mesh';
        const subTaskIds = await orchestrator.injectTask(goal);

        // Based on the mock implementation in MeshOrchestrator.ts
        expect(subTaskIds).toHaveLength(2);
        expect(taskRoutedSpy).toHaveBeenCalledTimes(2);
        expect(taskRoutedSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: '1',
            title: expect.stringContaining(goal)
        }));
    });
});
