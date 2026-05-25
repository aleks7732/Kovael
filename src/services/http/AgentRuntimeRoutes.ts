import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';
import type { AgentRuntimeControlOptions, AgentRuntimeControlResult } from '../AgentRuntimeSupervisor.js';
import type { RouteDeps } from './HttpApiSupport.js';
import { createRequestUrl } from './HttpApiSupport.js';

export async function handleAgentRuntimeRequest(
    context: OrchestratorContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: RouteDeps,
): Promise<void> {
    const url = createRequestUrl(req);
    const parts = routeParts(url.pathname);

    if (req.method === 'GET') {
        if (parts.length === 0) {
            deps.writeJson(res, 200, context.agentRuntimeSupervisor.snapshot());
            return;
        }
        if (parts.length === 1) {
            const agentId = parts[0];
            const status = context.agentRuntimeSupervisor.getAgentStatus(agentId);
            if (!status) {
                deps.writeJson(res, 404, { error: 'unknown_agent_runtime', agentId });
                return;
            }
            deps.writeJson(res, 200, status);
            return;
        }
        deps.writeJson(res, 405, { error: 'method_not_allowed' });
        return;
    }

    if (req.method !== 'POST') {
        deps.writeJson(res, 405, { error: 'method_not_allowed' });
        return;
    }

    if (parts.length !== 2) {
        deps.writeJson(res, 404, {
            error: 'unknown_agent_runtime_action',
            action: parts[1] ?? '',
        });
        return;
    }

    const body = await deps.readJsonBody(req, res);
    if (body === null) return;
    const options = parseControlOptions(body);
    if (options.error) {
        deps.writeJson(res, 400, options.error);
        return;
    }

    const [agentId, action] = parts;
    let result: AgentRuntimeControlResult;
    if (action === 'start') {
        context.resourceGovernor.noteActivity(`http:${req.method ?? 'POST'}:${url.pathname}`);
        result = context.agentRuntimeSupervisor.startAgent(agentId, undefined, options.value);
    } else if (action === 'stop') {
        result = context.agentRuntimeSupervisor.stopAgent(agentId, options.value);
    } else if (action === 'restart') {
        context.resourceGovernor.noteActivity(`http:${req.method ?? 'POST'}:${url.pathname}`);
        result = context.agentRuntimeSupervisor.restartAgent(agentId, undefined, options.value);
    } else {
        deps.writeJson(res, 404, { error: 'unknown_agent_runtime_action', action });
        return;
    }

    deps.writeJson(res, result.statusCode, responseBody(result, agentId));
}

function routeParts(pathname: string): string[] {
    const suffix = pathname.replace(/^\/api\/v1\/agent-runtimes\/?/, '');
    if (!suffix) return [];
    return suffix
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
}

function parseControlOptions(body: Record<string, unknown>): { value: AgentRuntimeControlOptions; error?: never } | { value?: never; error: unknown } {
    const value: AgentRuntimeControlOptions = {};
    if (typeof body.reason === 'string') {
        value.reason = body.reason.trim().slice(0, 160);
    }
    if (typeof body.force === 'boolean') {
        value.force = body.force;
    }
    if (body.timeoutMs !== undefined) {
        if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0) {
            return { error: { error: 'invalid_timeout_ms' } };
        }
        value.timeoutMs = Math.floor(body.timeoutMs);
    }
    return { value };
}

function responseBody(result: AgentRuntimeControlResult, agentId: string): unknown {
    if (result.error) {
        return {
            error: result.error,
            agentId,
            busy: result.busy,
            agent: result.agent,
        };
    }
    return result;
}
