import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';

export function handleStateSnapshot(
    context: OrchestratorContext,
    _req: http.IncomingMessage,
    res: http.ServerResponse,
): void {
    const snapshot = {
        timestamp: Date.now(),
        agentCards: context.agentCards.length,
        connectedClients: context.wss?.clients?.size ?? 0,
        nodes: context.nodeCache.size,
        tasksTotal: context.taskCache.length,
        receiptsIssued: context.receiptsIssued,
        activeCycles: Array.from(context.activeCycles.values()).slice(-20),
        hardware: context.hardwareCache,
        claims: {
            stats: context.claims.stats(),
            pending: context.claims.snapshot().slice(-20),
        },
        retryQueue: {
            pendingCount: context.retryQueue?.pendingCount() ?? 0,
            pending: context.retryQueue?.snapshot() ?? [],
        },
        reconciler: context.reconciler?.stats() ?? null,
        workspaces: {
            root: context.workspaces?.root() ?? '',
            active: context.workspaces?.activeCount() ?? 0,
        },
        hooks: context.hooks?.stats() ?? null,
        workflow: {
            loaded: !!context.workflowLoader?.document(),
            lastError: context.workflowLoader?.lastErrorMessage() ?? null,
            version: context.workflowLoader?.document()?.frontMatter?.version ?? null,
            loadedAt: context.workflowLoader?.document()?.loadedAt ?? null,
        },
        tokens: { ...context.tokenTotals },
        rateLimits: context.rateLimits?.allSnapshots() ?? [],
        chairs: {
            stats: context.chairs.stats(),
            roster: context.chairs.snapshot(),
        },
        circuits: context.circuitBreaker.snapshot(),
        learningMatrix: context.learningMatrix.stats(),
    };
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(snapshot));
}
