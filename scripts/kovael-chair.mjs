#!/usr/bin/env node
/**
 * kovael-chair — universal Chair Beacon client.
 *
 * Any agent process can claim a chair on the orchestrator with a single
 * command. The helper runs claim → heartbeat (every healthyMs/2) → release
 * lifecycle and exits cleanly on SIGINT/SIGTERM. Zero npm dependencies.
 *
 * Usage:
 *   node scripts/kovael-chair.mjs \
 *     --id nyx-codex \
 *     --provider "OpenAI Codex CLI" \
 *     --capabilities filesystem,git \
 *     [--trust 2] [--host http://localhost:8080] [--note "rapid mode"]
 *
 * One-shot probe mode (claim+release immediately, no heartbeat loop):
 *   node scripts/kovael-chair.mjs --id nyx-codex --provider "Codex" --probe
 *
 * Environment overrides:
 *   KOVAEL_HOST    default orchestrator host (e.g. http://localhost:8080)
 *   KOVAEL_TOKEN   optional bearer token (forwarded as Authorization)
 */

import process from 'node:process';

function parseArgs(argv) {
    const args = { capabilities: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.replace(/^--/, '');
        const next = argv[i + 1];
        const takesValue = next !== undefined && !next.startsWith('--');
        if (key === 'probe') {
            args.probe = true;
            continue;
        }
        if (!takesValue) continue;
        i++;
        if (key === 'capabilities') {
            args.capabilities = next.split(',').map((s) => s.trim()).filter(Boolean);
        } else if (key === 'trust') {
            const n = Number.parseInt(next, 10);
            if (!Number.isNaN(n)) args.trust = n;
        } else {
            args[key] = next;
        }
    }
    return args;
}

function usageAndExit(reason) {
    if (reason) console.error(`kovael-chair: ${reason}`);
    console.error('Usage: node scripts/kovael-chair.mjs --id <agent-id> --provider "<human-readable>" [--capabilities a,b,c] [--trust 1|2|3] [--host http://localhost:8080] [--note "..."] [--probe]');
    process.exit(2);
}

async function postJson(host, path, body) {
    const url = new URL(path, host);
    const payload = JSON.stringify(body);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
    };
    if (process.env.KOVAEL_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.KOVAEL_TOKEN}`;
    }
    const res = await fetch(url, { method: 'POST', headers, body: payload });
    const text = await res.text();
    let parsed = null;
    if (text.length > 0) {
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }
    return { status: res.status, body: parsed };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.id) usageAndExit('--id is required');
    if (!args.provider) usageAndExit('--provider is required');

    const host = args.host || process.env.KOVAEL_HOST || 'http://localhost:8080';
    const claimBody = {
        agentId: args.id,
        provider: args.provider,
        capabilities: args.capabilities,
    };
    if (args.trust !== undefined) claimBody.trustTier = args.trust;
    if (args.note) claimBody.note = args.note;

    let claim;
    try {
        claim = await postJson(host, '/api/v1/chairs/claim', claimBody);
    } catch (err) {
        console.error(`kovael-chair: claim failed (network): ${err.message}`);
        process.exit(1);
    }
    if (claim.status !== 200 || !claim.body?.sessionId) {
        console.error(`kovael-chair: claim rejected (HTTP ${claim.status}): ${JSON.stringify(claim.body)}`);
        process.exit(1);
    }
    const { sessionId, heartbeatIntervalMs, ttlMs } = claim.body;
    console.error(`kovael-chair: ${args.id} claimed (session=${sessionId.slice(0, 8)}…, ttl=${ttlMs}ms, beacon=${heartbeatIntervalMs}ms)`);

    if (args.probe) {
        const released = await postJson(host, '/api/v1/chairs/release', { agentId: args.id, sessionId }).catch(() => null);
        console.error(`kovael-chair: probe complete (released=${released?.body?.released ?? false})`);
        process.exit(0);
    }

    let stopping = false;
    const release = async (reason) => {
        if (stopping) return;
        stopping = true;
        try {
            await postJson(host, '/api/v1/chairs/release', { agentId: args.id, sessionId });
            console.error(`kovael-chair: released (${reason})`);
        } catch (err) {
            console.error(`kovael-chair: release error (${reason}): ${err.message}`);
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', () => release('SIGINT'));
    process.on('SIGTERM', () => release('SIGTERM'));
    process.on('SIGHUP', () => release('SIGHUP'));

    const interval = Math.max(1000, heartbeatIntervalMs || 7500);
    setInterval(async () => {
        try {
            const r = await postJson(host, '/api/v1/chairs/heartbeat', {
                agentId: args.id,
                sessionId,
            });
            if (r.status === 409) {
                console.error('kovael-chair: session superseded — exiting');
                process.exit(0);
            }
            if (r.status !== 200) {
                console.error(`kovael-chair: heartbeat HTTP ${r.status}: ${JSON.stringify(r.body)}`);
            }
        } catch (err) {
            // Network blip — orchestrator may be restarting. Stay running so
            // the next tick re-establishes presence once it's back.
            console.error(`kovael-chair: heartbeat network error: ${err.message}`);
        }
    }, interval);
}

main().catch((err) => {
    console.error(`kovael-chair: fatal: ${err.message}`);
    process.exit(1);
});
