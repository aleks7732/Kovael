#!/usr/bin/env node
/**
 * No-vaporware validation: boot the orchestrator, spawn one real
 * kovael-agent-inbox adapter per canonical chair, dispatch through the
 * ChairBridgeProvider path, and assert every adapter hub recorded the
 * accepted -> running -> succeeded lifecycle.
 *
 * Requires: `npm run build` first (this script imports from dist/).
 *
 *   node scripts/validate-all-chairs.mjs
 */

import { spawn } from 'node:child_process';
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
const AGENT_IDS = Object.keys(AgentCards);
const STRICT_LIVE = process.env.KOVAEL_REQUIRE_LIVE_CHAIRS === 'true';
const DISPATCH_SECRET = validDispatchSecret(process.env.KOVAEL_CHAIR_DISPATCH_SECRET)
    ? process.env.KOVAEL_CHAIR_DISPATCH_SECRET.trim()
    : 'validate-all-chairs-secret-0123456789abcdef';

process.env.KOVAEL_DB_PATH = ':memory:';
process.env.KOVAEL_CHAIR_DISPATCH_SECRET = DISPATCH_SECRET;

async function postJson(url, body, extraHeaders = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json', ...extraHeaders }),
        body: JSON.stringify(body),
    });
    const txt = await res.text();
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
    return { status: res.status, body: parsed };
}

async function getJson(url) {
    const res = await fetch(url, { headers: authHeaders() });
    return { status: res.status, body: await res.json() };
}

function authHeaders(headers = {}) {
    const token = process.env.KOVAEL_API_TOKEN;
    return token ? { ...headers, authorization: `Bearer ${token}` } : headers;
}

function report(title, rows) {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    process.stdout.write(`\n=== ${title} ===\n`);
    for (const row of rows) {
        process.stdout.write(row.map((c, i) => String(c).padEnd(widths[i])).join('  ') + '\n');
    }
}

function spawnAdapter(agentId, orchestratorPort, hubRoot) {
    const card = AgentCards[agentId];
    const hubPath = path.join(hubRoot, safePathSegment(agentId), 'agent-hub.sqlite');
    const args = [
        SCRIPT_PATH,
        '--id', agentId,
        '--provider', card.provider,
        '--runtime', 'fake-deterministic',
        '--host', `http://127.0.0.1:${orchestratorPort}`,
        '--cwd', ROOT,
        '--hub-path', hubPath,
        '--capabilities', card.mcp_capabilities.join(','),
        '--trust', String(card.trust_tier),
        '--note', 'validate-all-chairs',
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
    child.stderr?.on('data', (chunk) => {
        stderr.push(chunk.toString('utf8'));
    });
    return { agentId, child, hubPath, stderr };
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
        const ready = expectedIds.every((agentId) => {
            const chair = byId.get(agentId);
            return chair && chair.status === 'online' && typeof chair.inboxUrl === 'string' && chair.inboxUrl.length > 0;
        });
        if (ready) return snapshot.body.chairs;
        await sleep(100);
    }
    throw new Error(`timed out waiting for adapter claims: ${JSON.stringify(last)}`);
}

async function waitForHubDispatch(hubPath, topicId, timeoutMs = 7000) {
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
                if (last?.status === 'succeeded') return decodeHubRow(hubPath, last);
            } finally {
                db.close();
            }
        }
        await sleep(50);
    }
    throw new Error(`hub dispatch for topic ${topicId} did not succeed; last=${JSON.stringify(last)}`);
}

function readHubRows(hubPath) {
    if (!existsSync(hubPath)) return [];
    const db = new DatabaseSync(hubPath);
    try {
        const rows = db.prepare(`
            SELECT request_id, topic_id, agent_id, status, received_at, started_at,
                   completed_at, error
            FROM agent_dispatches
            ORDER BY received_at ASC
        `).all();
        return rows.map((row) => decodeHubRow(hubPath, row));
    } finally {
        db.close();
    }
}

function validateHubLifecycle(agentId, row, topicId, streamedText) {
    const errors = [];
    if (!row) errors.push('missing hub row');
    if (row?.status !== 'succeeded') errors.push(`status=${row?.status}`);
    if (!Number.isFinite(row?.received_at)) errors.push('missing received_at');
    if (!Number.isFinite(row?.started_at)) errors.push('missing started_at');
    if (!Number.isFinite(row?.completed_at)) errors.push('missing completed_at');
    if (row?.started_at < row?.received_at) errors.push('started_at before received_at');
    if (row?.completed_at < row?.started_at) errors.push('completed_at before started_at');
    const payload = row?.payload || {};
    if (payload.agentId !== agentId) errors.push(`payload agent=${payload.agentId}`);
    if (payload.topicId !== topicId) errors.push(`payload topic=${payload.topicId}`);
    if (payload.requestId !== row?.request_id) errors.push('payload/request row mismatch');
    const expectedNeedle = `FAKE_RUNTIME_REPLY agent=${agentId} request=${row?.request_id} topic=${topicId}`;
    if (!String(row?.reply_content || '').includes(expectedNeedle)) errors.push('reply missing deterministic proof');
    if (row?.reply_content !== streamedText) errors.push('streamed reply differs from hub reply');
    return errors;
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
        };
    } finally {
        store.close();
    }
}

function validateDispatchReceipt(agentId, row, claim, receipt) {
    const errors = [];
    if (!receipt) errors.push('missing provider receipt');
    if (receipt?.status !== 'succeeded') errors.push(`receipt status=${receipt?.status}`);
    if (receipt?.proofVerified !== true) errors.push('reply proof not verified');
    if (receipt?.agentId !== agentId) errors.push(`receipt agent=${receipt?.agentId}`);
    if (receipt?.topicId !== row?.topic_id) errors.push(`receipt topic=${receipt?.topicId}`);
    if (receipt?.requestId !== row?.request_id) errors.push('receipt/request row mismatch');
    if (receipt?.claimSessionId !== claim?.sessionId) errors.push('receipt/session claim mismatch');
    return errors;
}

let exitCode = 0;
let orchestrator = null;
let hubRoot = null;
const adapters = [];

try {
    orchestrator = new MeshOrchestrator(0);
    const orchestratorPort = await orchestrator.ready();
    const host = `http://127.0.0.1:${orchestratorPort}`;
    process.stdout.write(`[validate] orchestrator listening on :${orchestratorPort}\n`);
    process.stdout.write('[validate] encrypted chair dispatch enabled with validation-local secret\n');
    if (STRICT_LIVE) process.stdout.write('[validate] strict live-chair mode enabled\n');

    hubRoot = mkdtempSync(path.join(os.tmpdir(), 'kovael-validate-agents-'));
    for (const agentId of AGENT_IDS) {
        adapters.push(spawnAdapter(agentId, orchestratorPort, hubRoot));
    }
    process.stdout.write(`[validate] spawned ${adapters.length} fake-deterministic inbox adapters\n`);

    const claims = await waitForClaims(orchestratorPort, AGENT_IDS);
    const claimByAgent = new Map(claims.map((claim) => [claim.agentId, claim]));
    const claimRows = [['agent', 'provider', 'status', 'sessionId', 'inbox']];
    for (const agentId of AGENT_IDS) {
        const card = AgentCards[agentId];
        const claim = claimByAgent.get(agentId);
        if (!claim) {
            claimRows.push([agentId, card.provider, 'MISS', '-', '-']);
            exitCode = 1;
            continue;
        }
        claimRows.push([
            agentId,
            card.provider,
            claim.status,
            String(claim.sessionId || '').slice(0, 8),
            claim.inboxUrl ? new URL(claim.inboxUrl).port : '-',
        ]);
    }
    report('Adapter chair claims', claimRows);

    const busEvents = [];
    orchestrator.conversationBus.on('bus_event', (event) => busEvents.push(event));

    const directRows = [['agent', 'dispatch status', 'requestId', 'hub lifecycle', 'reply preview']];
    const directByAgent = new Map();
    for (const agentId of AGENT_IDS) {
        const { body: topic } = await postJson(
            `${host}/api/v1/conversations`,
            { title: `Direct dispatch · ${agentId}`, participants: [agentId] },
        );
        if (!topic?.id) {
            directRows.push([agentId, 'FAIL create-topic', '-', '-', JSON.stringify(topic)]);
            exitCode = 1;
            continue;
        }

        const provider = new ChairBridgeProvider(agentId, orchestrator.chairs, orchestratorPort, {
            dispatchTimeoutMs: 7000,
            maxAttempts: 2,
            baseBackoffMs: 50,
        });
        try {
            const out = [];
            for await (const chunk of provider.stream({
                system: 'You are under validation.',
                messages: [{ role: 'user', content: 'ack' }],
                topicId: topic.id,
                agentId,
            })) {
                if (chunk.delta) out.push(chunk.delta);
            }
            const text = out.join('');
            const adapter = adapters.find((candidate) => candidate.agentId === agentId);
            const hubRow = await waitForHubDispatch(adapter.hubPath, topic.id);
            const errors = [
                ...validateHubLifecycle(agentId, hubRow, topic.id, text),
                ...validateDispatchReceipt(agentId, hubRow, claimByAgent.get(agentId), provider.getLastReceipt()),
            ];
            directByAgent.set(agentId, hubRow);
            if (errors.length > 0) {
                directRows.push([agentId, 'FAIL hub', hubRow?.request_id ?? '-', errors.join('; '), text.slice(0, 48)]);
                exitCode = 1;
            } else {
                directRows.push([agentId, 'DISPATCHED', hubRow.request_id.slice(0, 8), 'accepted→running→succeeded', text.slice(0, 48)]);
            }
        } catch (err) {
            directRows.push([agentId, `FAIL ${err && err.message ? err.message : err}`, '-', '-', '-']);
            exitCode = 1;
        }
    }
    report('Direct dispatch via real inbox adapters', directRows);

    const busTopicAgents = AGENT_IDS.slice(0, 3);
    const { body: busTopic } = await postJson(
        `${host}/api/v1/conversations`,
        { title: 'Bus integration', participants: busTopicAgents },
    );
    await orchestrator.conversationBus.convene(busTopic.id, 'integration test');
    process.stdout.write(`[validate] bus convene finished on ${busTopic.id}\n`);

    const liveFallbackEvents = busEvents.filter((event) => [
        'chair_dispatch_unavailable',
        'chair_dispatch_rerouted',
        'chair_dispatch_failure',
    ].includes(event.type));
    if (STRICT_LIVE && liveFallbackEvents.length > 0) {
        process.stdout.write(`[validate] FAIL strict live mode saw fallback/failure events: ${JSON.stringify(liveFallbackEvents)}\n`);
        exitCode = 1;
    }

    const receipt = await orchestrator.injectTask('Validate dispatch path');
    process.stdout.write(
        `[validate] triad receipt: status=${receipt.status} architect=${receipt.architectId} operator=${receipt.operatorId} verifier=${receipt.verifierId} (synthetic Triad path; adapter receipts verified above)\n`,
    );
    if (!receipt || !receipt.taskHash) {
        process.stdout.write('  FAIL — injectTask did not return a receipt\n');
        exitCode = 1;
    }

    const dispatchRows = [['agent', 'hub dispatches', 'succeeded', 'topics seen']];
    for (const adapter of adapters) {
        const rows = readHubRows(adapter.hubPath);
        const succeeded = rows.filter((row) => row.status === 'succeeded');
        if (succeeded.length === 0) exitCode = 1;
        dispatchRows.push([
            adapter.agentId,
            String(rows.length),
            String(succeeded.length),
            [...new Set(rows.map((row) => row.topic_id))].join(',') || '-',
        ]);
    }
    report('Adapter hub dispatch reception', dispatchRows);

    for (const adapter of adapters) {
        if (adapter.child.exitCode !== null && adapter.child.exitCode !== 0) {
            process.stdout.write(`[validate] adapter ${adapter.agentId} exited early with code=${adapter.child.exitCode}\n`);
            process.stdout.write(adapter.stderr.join('').slice(-2000));
            exitCode = 1;
        }
    }

    process.stdout.write(
        `\n[validate] result: ${exitCode === 0 ? 'PASS — every adapter claimed, decrypted, dispatched, replied, and persisted hub success' : 'FAIL — see rows above'}\n`,
    );
} catch (err) {
    process.stderr.write(`[validate] threw: ${err && err.stack ? err.stack : err}\n`);
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

function validDispatchSecret(value) {
    return typeof value === 'string' && value.trim().length >= 32;
}

function safePathSegment(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
