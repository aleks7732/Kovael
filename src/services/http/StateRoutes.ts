import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';

export function handleStateSnapshot(
    context: OrchestratorContext,
    _req: http.IncomingMessage,
    res: http.ServerResponse,
): void {
    const agentRuntimeSnapshot = context.agentRuntimeSupervisor.snapshot();
    const snapshot = {
        timestamp: Date.now(),
        bindHost: context.bindHost,
        remoteAccessMode: context.remoteAccessMode,
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
        chairDispatch: { ...context.chairDispatchMetrics },
        rateLimits: context.rateLimits?.allSnapshots() ?? [],
        resourceMode: context.resourceGovernor.snapshot(),
        agentRuntimes: agentRuntimeSnapshot,
        hubHealthByAgent: Object.fromEntries(agentRuntimeSnapshot.agents.map((agent) => [
            agent.agentId,
            {
                agentId: agent.agentId,
                status: agent.hub.error ? 'error' : agent.hub.exists ? 'ok' : 'missing',
                dispatches: agent.hub.dispatches,
                accepted: agent.hub.accepted,
                running: agent.hub.running,
                succeeded: agent.hub.succeeded,
                failed: agent.hub.failed,
                memories: agent.hub.memories,
                schemaVersion: agent.hub.schemaVersion,
                error: agent.hub.error,
                checkedAt: Date.now(),
            },
        ])),
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
