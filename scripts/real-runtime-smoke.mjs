#!/usr/bin/env node
/**
 * Manual real runtime smoke for Kovael chair adapters.
 *
 * Starts the orchestrator, spawns real kovael-agent-inbox adapters for
 * available safe runtimes, dispatches through ChairBridgeProvider, then runs
 * a strict ConversationBus convene and fails if any fallback path is used.
 *
 * Requires: `npm run build` first (this script imports from dist/).
 *
 *   node scripts/real-runtime-smoke.mjs
 *   node scripts/real-runtime-smoke.mjs --agents nyx-codex,shaev --require-real
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentCards } from '../dist/AgentCards.js';
import { AgentHubStore } from '../dist/services/AgentHubStore.js';
import { MeshOrchestrator } from '../dist/MeshOrchestrator.js';
import { ChairBridgeProvider } from '../dist/services/ModelProvider.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'kovael-agent-inbox.mjs');
const SAFE_RUNTIMES = {
    'nyx-codex': 'codex',
    shaev: 'claude-shaev',
};
const DISPATCH_SECRET = validDispatchSecret(process.env.KOVAEL_CHAIR_DISPATCH_SECRET)
    ? process.env.KOVAEL_CHAIR_DISPATCH_SECRET.trim()
    : 'real-runtime-smoke-secret-0123456789abcdef';

process.env.KOVAEL_DB_PATH = ':memory:';
process.env.KOVAEL_CHAIR_DISPATCH_SECRET = DISPATCH_SECRET;

const args = parseArgs(process.argv.slice(2));
const requireReal = args.requireReal || process.env.KOVAEL_REQUIRE_LIVE_CHAIRS === 'true';
const requestedAgents = args.agents.length > 0 ? args.agents : ['nyx-codex'];
const timeoutMs = args.timeoutMs ?? 180_000;
process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS = String(Math.max(timeoutMs + 15_000, 45_000));

let exitCode = 0;
let orchestrator = null;
let hubRoot = null;
const adapters = [];

try {
    const runnable = [];
    const skipped = [];
    for (const agentId of requestedAgents) {
        const runtime = SAFE_RUNTIMES[agentId];
        if (!runtime || !AgentCards[agentId]) {
            skipped.push({ agentId, reason: 'unsupported_safe_runtime' });
            continue;
        }
        const availability = runtimeAvailable(runtime);
        if (!availability.available) {
            skipped.push({ agentId, reason: availability.reason });
            continue;
        }
        runnable.push({ agentId, runtime });
    }

    if (skipped.length > 0) {
        for (const item of skipped) {
            process.stdout.write(`[real-smoke] skip ${item.agentId}: ${item.reason}\n`);
        }
    }
    if (requireReal && skipped.length > 0) {
        process.stderr.write('[real-smoke] FAIL --require-real/KOVAEL_REQUIRE_LIVE_CHAIRS forbids skipped requested agents\n');
        process.exit(1);
    }
    if (runnable.length === 0) {
        process.stdout.write('[real-smoke] SKIP no requested real runtimes are available\n');
        process.exit(requireReal ? 1 : 0);
    }

    orchestrator = new MeshOrchestrator(0);
    const orchestratorPort = await orchestrator.ready();
    const host = `http://127.0.0.1:${orchestratorPort}`;
    process.stdout.write(`[real-smoke] orchestrator listening on :${orchestratorPort}\n`);
    process.stdout.write(`[real-smoke] agents: ${runnable.map((item) => item.agentId).join(', ')}\n`);

    hubRoot = mkdtempSync(path.join(os.tmpdir(), 'kovael-real-runtime-smoke-'));
    for (const spec of runnable) {
        adapters.push(spawnAdapter(spec, orchestratorPort, hubRoot, timeoutMs));
    }

    const claims = await waitForClaims(orchestratorPort, runnable.map((item) => item.agentId));
    const claimByAgent = new Map(claims.map((claim) => [claim.agentId, claim]));
    for (const { agentId } of runnable) {
        const claim = claimByAgent.get(agentId);
        process.stdout.write(`[real-smoke] claimed ${agentId} session=${String(claim.sessionId).slice(0, 8)} inbox=${new URL(claim.inboxUrl).port}\n`);
    }

    const busEvents = [];
    orchestrator.conversationBus.on('bus_event', (event) => busEvents.push(event));

    for (const { agentId } of runnable) {
        const { body: topic } = await postJson(
            `${host}/api/v1/conversations`,
            { title: `Real runtime smoke · ${agentId}`, participants: [agentId] },
        );
        const provider = new ChairBridgeProvider(agentId, orchestrator.chairs, orchestratorPort, {
            dispatchTimeoutMs: 10_000,
            maxAttempts: 1,
            baseBackoffMs: 50,
        });

        const out = [];
        for await (const chunk of provider.stream({
            system: 'Kovael real runtime smoke. Reply concisely. Do not claim tool actions.',
            messages: [{ role: 'user', content: 'Reply with a concise runtime smoke acknowledgement.' }],
            topicId: topic.id,
            agentId,
        })) {
            if (chunk.delta) out.push(chunk.delta);
        }
        const text = out.join('').trim();
        const adapter = adapters.find((candidate) => candidate.agentId === agentId);
        const hubRow = await waitForHubDispatch(adapter.hubPath, topic.id);
        if (!text || hubRow.status !== 'succeeded' || hubRow.reply_content !== text || hubRow.outbox?.status !== 'sent') {
            process.stderr.write(`[real-smoke] FAIL direct dispatch mismatch for ${agentId}\n`);
            exitCode = 1;
        } else {
            process.stdout.write(`[real-smoke] direct ${agentId} request=${hubRow.request_id.slice(0, 8)} reply=${text.slice(0, 96)}\n`);
        }
    }

    const participants = runnable.map((item) => item.agentId);
    const { body: busTopic } = await postJson(
        `${host}/api/v1/conversations`,
        { title: 'Real runtime strict convene', participants },
    );
    await orchestrator.conversationBus.convene(busTopic.id, 'Give one concise live-runtime smoke response each.');

    const fallbackEvents = busEvents.filter((event) => [
        'chair_dispatch_unavailable',
        'chair_dispatch_rerouted',
        'chair_dispatch_failure',
    ].includes(event.type));
    const successAgents = new Set(
        busEvents
            .filter((event) => event.type === 'chair_dispatch_success')
            .map((event) => event.agentId),
    );
    const missingSuccess = participants.filter((agentId) => !successAgents.has(agentId));
    if (fallbackEvents.length > 0 || missingSuccess.length > 0) {
        process.stderr.write(`[real-smoke] FAIL fallback/failure detected events=${JSON.stringify(fallbackEvents)} missingSuccess=${missingSuccess.join(',')}\n`);
        exitCode = 1;
    } else {
        process.stdout.write(`[real-smoke] convene live handoffs verified for ${participants.join(', ')}\n`);
    }

    for (const adapter of adapters) {
        if (adapter.child.exitCode !== null && adapter.child.exitCode !== 0) {
            process.stderr.write(`[real-smoke] adapter ${adapter.agentId} exited early code=${adapter.child.exitCode}\n`);
            process.stderr.write(adapter.stderr.join('').slice(-2000));
            exitCode = 1;
        }
    }

    process.stdout.write(`\n[real-smoke] result: ${exitCode === 0 ? 'PASS' : 'FAIL'}\n`);
} catch (err) {
    process.stderr.write(`[real-smoke] threw: ${err && err.stack ? err.stack : err}\n`);
    exitCode = 1;
} finally {
    await Promise.all(adapters.map((adapter) => stopAdapter(adapter)));
    if (orchestrator) orchestrator.close();
    if (hubRoot && path.resolve(hubRoot).startsWith(path.resolve(os.tmpdir()))) {
        rmSync(hubRoot, { recursive: true, force: true });
    }
    await sleep(50);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const parsed = { agents: [], requireReal: false, timeoutMs: undefined };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--require-real') {
            parsed.requireReal = true;
            continue;
        }
        if (arg === '--agents' && argv[i + 1]) {
            i += 1;
            parsed.agents = argv[i].split(',').map((part) => part.trim()).filter(Boolean);
            continue;
        }
        if (arg === '--timeout-ms' && argv[i + 1]) {
            i += 1;
            const timeout = Number.parseInt(argv[i], 10);
            if (Number.isFinite(timeout) && timeout > 0) parsed.timeoutMs = timeout;
        }
    }
    return parsed;
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
    const txt = await res.text();
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${txt}`);
    return { status: res.status, body: parsed };
}

async function getJson(url) {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return { status: res.status, body: await res.json() };
}

function authHeaders(headers = {}) {
    const token = process.env.KOVAEL_API_TOKEN;
    return token ? { ...headers, authorization: `Bearer ${token}` } : headers;
}

function spawnAdapter(spec, orchestratorPort, hubRoot, timeoutMs) {
    const card = AgentCards[spec.agentId];
    const hubPath = path.join(hubRoot, safePathSegment(spec.agentId), 'agent-hub.sqlite');
    const args = [
        SCRIPT_PATH,
        '--id', spec.agentId,
        '--provider', card.provider,
        '--runtime', spec.runtime,
        '--host', `http://127.0.0.1:${orchestratorPort}`,
        '--cwd', ROOT,
        '--hub-path', hubPath,
        '--capabilities', card.mcp_capabilities.join(','),
        '--trust', String(card.trust_tier),
        '--timeout-ms', String(timeoutMs),
        '--note', 'real-runtime-smoke',
    ];
    if (process.env.KOVAEL_API_TOKEN) args.push('--with-token');

    const stderr = [];
    const child = spawn(process.execPath, args, {
        cwd: ROOT,
        env: {
            ...process.env,
            KOVAEL_CHAIR_DISPATCH_SECRET: DISPATCH_SECRET,
            ...(process.env.KOVAEL_API_TOKEN ? { KOVAEL_TOKEN: process.env.KOVAEL_API_TOKEN } : {}),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    child.stderr?.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
    return { agentId: spec.agentId, child, hubPath, stderr };
}

async function stopAdapter(adapter) {
    if (adapter.child.exitCode !== null || adapter.child.killed) return;
    adapter.child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => adapter.child.once('exit', resolve)),
        sleep(2500).then(() => {
            if (adapter.child.exitCode === null && !adapter.child.killed) {
                adapter.child.kill('SIGKILL');
            }
        }),
    ]);
}

async function waitForClaims(orchestratorPort, expectedIds, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const snapshot = await getJson(`http://127.0.0.1:${orchestratorPort}/api/v1/chairs`);
        last = snapshot.body;
        const byId = new Map((snapshot.body.chairs || []).map((chair) => [chair.agentId, chair]));
        if (expectedIds.every((agentId) => {
            const chair = byId.get(agentId);
            return chair && chair.status === 'online' && typeof chair.inboxUrl === 'string';
        })) {
            return snapshot.body.chairs;
        }
        await sleep(100);
    }
    throw new Error(`timed out waiting for claims: ${JSON.stringify(last)}`);
}

async function waitForHubDispatch(hubPath, topicId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        if (existsSync(hubPath)) {
            const db = new DatabaseSync(hubPath);
            try {
                last = db.prepare(`
                    SELECT request_id, topic_id, agent_id, status, received_at, started_at,
                           completed_at, error
                    FROM agent_dispatches
                    WHERE topic_id = ?
                    ORDER BY received_at DESC
                    LIMIT 1
                `).get(topicId);
                if (last?.status === 'succeeded') {
                    const decoded = decodeHubRow(hubPath, last);
                    last = decoded;
                    if (decoded.outbox?.status === 'sent') return decoded;
                }
            } finally {
                db.close();
            }
        }
        await sleep(100);
    }
    throw new Error(`hub dispatch for topic ${topicId} did not succeed; last=${JSON.stringify(last)}`);
}

function decodeHubRow(hubPath, row) {
    const store = new AgentHubStore({ agentId: row.agent_id, dbPath: hubPath });
    try {
        const dispatch = store.getDispatch(row.request_id);
        return {
            ...row,
            payload: dispatch?.payload ?? {},
            reply_content: dispatch?.replyContent ?? null,
            error: dispatch?.error ?? row.error,
            outbox: store.listOutbox().find((candidate) => candidate.requestId === row.request_id && candidate.kind === 'reply') ?? null,
        };
    } finally {
        store.close();
    }
}

function runtimeAvailable(runtime) {
    if (runtime === 'codex') return codexAvailable();
    if (runtime === 'claude-shaev') return commandAvailable(process.env.KOVAEL_CLAUDE_BIN || (process.platform === 'win32' ? 'claude.exe' : 'claude'));
    return { available: false, reason: `unknown_runtime_${runtime}` };
}

function codexAvailable() {
    const configured = process.env.KOVAEL_CODEX_BIN;
    if (configured) return commandAvailable(configured);
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const script = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (existsSync(script)) return { available: true, reason: script };
    }
    return commandAvailable('codex');
}

function commandAvailable(command) {
    if (command.includes(path.sep) || path.isAbsolute(command)) {
        return existsSync(command)
            ? { available: true, reason: command }
            : { available: false, reason: `missing ${command}` };
    }
    const probe = process.platform === 'win32'
        ? spawnSync('where.exe', [command], { encoding: 'utf8', shell: false })
        : spawnSync('which', [command], { encoding: 'utf8', shell: false });
    return probe.status === 0
        ? { available: true, reason: command }
        : { available: false, reason: `missing ${command}` };
}

function validDispatchSecret(value) {
    return typeof value === 'string' && value.trim().length >= 32;
}

function safePathSegment(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
