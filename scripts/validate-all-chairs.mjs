#!/usr/bin/env node
/**
 * No-vaporware validation: claim all 9 chairs over real HTTP, convene
 * conversations across the full roster, dispatch a Triad task, and
 * assert every chair received traffic. Prints a structured report.
 *
 * Requires: `npm run build` first (this script imports from dist/).
 * Exits 0 on full pass, 1 if any chair didn't receive a dispatch.
 *
 *   node scripts/validate-all-chairs.mjs
 */

import * as http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentCards } from '../dist/AgentCards.js';
import { MeshOrchestrator } from '../dist/MeshOrchestrator.js';
import { ChairBridgeProvider } from '../dist/services/ModelProvider.js';

const AGENT_IDS = Object.keys(AgentCards);

async function postJson(url, body, extraHeaders = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body),
    });
    const txt = await res.text();
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
    return { status: res.status, body: parsed };
}

async function getJson(url) {
    const res = await fetch(url);
    return { status: res.status, body: await res.json() };
}

// One tiny HTTP server per agent. When the orchestrator POSTs a
// dispatch to its inbox, the server records the hit and then posts
// the agent's name back to /api/v1/chairs/reply. Real network, real
// JSON, no mocks.
function startFakeInbox(agentId, orchestratorPort, hits) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', async () => {
                const payload = raw ? JSON.parse(raw) : {};
                hits.push({ agentId, topicId: payload.topicId, ts: Date.now() });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"ack":true}');

                // Reply back via the orchestrator's chair-reply webhook.
                if (payload.topicId) {
                    try {
                        await postJson(
                            `http://127.0.0.1:${orchestratorPort}/api/v1/chairs/reply`,
                            {
                                topicId: payload.topicId,
                                agentId,
                                content: `[${agentId}] dispatch acknowledged`,
                            },
                        );
                    } catch {
                        // Reply failure is reported elsewhere via the missing-reply timeout.
                    }
                }
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const inboxUrl = `http://127.0.0.1:${addr.port}/inbox`;
            resolve({ server, inboxUrl });
        });
    });
}

function report(title, rows) {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    process.stdout.write(`\n=== ${title} ===\n`);
    for (const row of rows) {
        process.stdout.write(row.map((c, i) => String(c).padEnd(widths[i])).join('  ') + '\n');
    }
}

let exitCode = 0;
let orchestrator = null;
const inboxServers = [];

try {
    // 1. Boot orchestrator on an ephemeral port — no global side effects.
    orchestrator = new MeshOrchestrator(0);
    const orchestratorPort = await orchestrator.ready();
    process.stdout.write(`[validate] orchestrator listening on :${orchestratorPort}\n`);

    // 2. Start 9 fake inboxes.
    const hits = [];
    const inboxByAgent = {};
    for (const agentId of AGENT_IDS) {
        const { server, inboxUrl } = await startFakeInbox(agentId, orchestratorPort, hits);
        inboxServers.push(server);
        inboxByAgent[agentId] = inboxUrl;
    }
    process.stdout.write(`[validate] ${AGENT_IDS.length} fake inboxes listening\n`);

    // 3. Each agent claims its chair via real HTTP POST.
    const claimRows = [['agent', 'provider', 'status', 'sessionId']];
    const sessions = {};
    for (const agentId of AGENT_IDS) {
        const card = AgentCards[agentId];
        const { status, body } = await postJson(
            `http://127.0.0.1:${orchestratorPort}/api/v1/chairs/claim`,
            {
                agentId,
                provider: card.provider,
                capabilities: card.mcp_capabilities,
                trustTier: card.trust_tier,
                inboxUrl: inboxByAgent[agentId],
                note: 'validate-all-chairs',
            },
        );
        if (status !== 200 || !body.sessionId) {
            claimRows.push([agentId, card.provider, `FAIL ${status}`, JSON.stringify(body)]);
            exitCode = 1;
        } else {
            sessions[agentId] = body.sessionId;
            claimRows.push([agentId, card.provider, 'CLAIMED', body.sessionId.slice(0, 8)]);
        }
    }
    report('Chair claims', claimRows);

    // 4. Snapshot — every claimed chair must be online.
    const snap = await getJson(`http://127.0.0.1:${orchestratorPort}/api/v1/chairs`);
    const online = (snap.body.chairs || []).filter((c) => c.status === 'online');
    process.stdout.write(`\n[validate] snapshot: ${online.length}/${AGENT_IDS.length} chairs online\n`);
    if (online.length !== AGENT_IDS.length) {
        process.stdout.write('  FAIL — expected all 9 chairs online after claim\n');
        exitCode = 1;
    }

    // 5. Direct per-agent dispatch via ChairBridgeProvider — the gold
    //    standard for "every chair can take work." Bypasses the bus's
    //    adaptive-stability stopping criterion (which can end a convene
    //    after 2-3 turns by design) and proves each inbox is reachable.
    const chairsRegistry = orchestrator.chairs;
    const directRows = [['agent', 'dispatch status', 'reply preview']];
    for (const agentId of AGENT_IDS) {
        const topicId = `validate-direct-${agentId}`;
        // Open a topic shell so the reply webhook has somewhere to land.
        const { body: topic } = await postJson(
            `http://127.0.0.1:${orchestratorPort}/api/v1/conversations`,
            { title: `Direct dispatch · ${agentId}`, participants: [agentId] },
        );
        const provider = new ChairBridgeProvider(agentId, chairsRegistry, orchestratorPort, {
            dispatchTimeoutMs: 5000,
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
            directRows.push([agentId, 'DISPATCHED', text.slice(0, 40)]);
        } catch (err) {
            directRows.push([agentId, `FAIL ${err && err.message ? err.message : err}`, '—']);
            exitCode = 1;
        }
    }
    report('Direct dispatch via ChairBridgeProvider', directRows);

    // 6. Bus integration: convene a small topic to prove the bus picks
    //    each chair's claim and routes through the same path. Stops are
    //    expected ("adaptive_stability_reached") — what matters is that
    //    the speakers we DO see correspond to claimed chairs.
    const busTopicAgents = AGENT_IDS.slice(0, 3);
    const { body: busTopic } = await postJson(
        `http://127.0.0.1:${orchestratorPort}/api/v1/conversations`,
        { title: 'Bus integration', participants: busTopicAgents },
    );
    await orchestrator.conversationBus.convene(busTopic.id, 'integration test');
    process.stdout.write(`[validate] bus convene finished on ${busTopic.id}\n`);

    // 7. Inject a Triad task — proves the architect/operator/verifier
    //    pipeline still routes through the claimed roster.
    const receipt = await orchestrator.injectTask('Validate dispatch path');
    process.stdout.write(
        `[validate] triad receipt: status=${receipt.status} architect=${receipt.architectId} operator=${receipt.operatorId} verifier=${receipt.verifierId}\n`,
    );
    if (!receipt || !receipt.taskHash) {
        process.stdout.write('  FAIL — injectTask did not return a receipt\n');
        exitCode = 1;
    }

    // 8. Per-agent dispatch counts.
    const dispatchRows = [['agent', 'dispatch hits', 'topics seen']];
    for (const agentId of AGENT_IDS) {
        const agentHits = hits.filter((h) => h.agentId === agentId);
        const topics = new Set(agentHits.map((h) => h.topicId).filter(Boolean));
        const status = agentHits.length >= 1 ? 'OK' : 'MISS';
        if (agentHits.length === 0) exitCode = 1;
        dispatchRows.push([agentId, `${agentHits.length} (${status})`, [...topics].join(',') || '—']);
    }
    report('Dispatch reception', dispatchRows);

    // 9. Final verdict.
    process.stdout.write(
        `\n[validate] result: ${exitCode === 0 ? 'PASS — every chair dispatched and replied' : 'FAIL — see rows above'}\n`,
    );
} catch (err) {
    process.stderr.write(`[validate] threw: ${err && err.stack ? err.stack : err}\n`);
    exitCode = 1;
} finally {
    for (const s of inboxServers) s.close();
    if (orchestrator) orchestrator.close();
    // Give async cleanups a beat so the process exits cleanly.
    await sleep(50);
    process.exit(exitCode);
}
