#!/usr/bin/env node
/**
 * theater-smoke — end-to-end manual verification of the Conversation
 * Theater + ConversationBus.
 *
 * Boots the orchestrator on an ephemeral port, opens a topic with three
 * participants, posts a @mention message, captures the streamed
 * conversation_message_delta + conversation_stopping_criterion events,
 * then closes the topic and shuts down.
 *
 * Output: writes a transcript to .notes/theater-smoke-transcript.json
 * for visual diffing across runs.
 *
 * Exit status: 0 if at least one delta and one stopping_criterion were
 * received within 10 seconds; non-zero otherwise.
 */

import { MeshOrchestrator } from '../dist/MeshOrchestrator.js';
import { WebSocket } from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';

const TIMEOUT_MS = 10_000;
const PARTICIPANTS = ['nyx-antigravity', 'shaev', 'nyx-codex'];
const PROMPT = '@Nyx-Antigravity @Shaev @Nyx-Codex convene on "design a 100k-node retry policy"';

function nowIso() {
    return new Date().toISOString();
}

async function main() {
    const orchestrator = new MeshOrchestrator(0); // ephemeral
    const port = await orchestrator.ready();
    console.error(`[smoke] orchestrator listening on :${port}`);

    const ws = new WebSocket(`ws://localhost:${port}?nodeId=theater-smoke`);
    const events = [];
    let firstDeltaAt = null;
    let stoppingAt = null;
    let deltaCount = 0;
    let topicOpenedAt = null;

    ws.on('open', () => {
        console.error(`[smoke] ws open`);
    });
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        // Bus events from ConversationBus broadcast flat (no `.data` wrap)
        // so read fields at the top level of the message.
        if (msg.type === 'conversation_topic_opened') {
            topicOpenedAt = Date.now();
            events.push({ at: nowIso(), kind: 'topic_opened', payload: msg.data ?? msg });
        } else if (msg.type === 'conversation_message_delta') {
            deltaCount += 1;
            if (firstDeltaAt === null) firstDeltaAt = Date.now();
            const speaker = msg.senderId || msg.sender_id || msg.data?.senderId;
            const delta = typeof msg.delta === 'string' ? msg.delta : (msg.data?.delta ?? '');
            events.push({
                at: nowIso(),
                kind: 'delta',
                speaker,
                isEnd: !!(msg.isEnd ?? msg.data?.isEnd),
                length: delta.length,
                tail: delta.slice(-48),
                usage: msg.usage ?? msg.data?.usage,
            });
        } else if (msg.type === 'conversation_stopping_criterion') {
            stoppingAt = Date.now();
            events.push({ at: nowIso(), kind: 'stopping', payload: msg.data ?? msg });
        } else if (msg.type === 'conversation_topic_closed') {
            events.push({ at: nowIso(), kind: 'topic_closed', payload: msg.data ?? msg });
        }
    });

    // Wait for ws to settle
    await new Promise((resolve) => ws.once('open', resolve));

    // 1. Open topic
    const createRes = await fetch(`http://localhost:${port}/api/v1/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Phoenix smoke · 100k retry policy', participants: PARTICIPANTS }),
    });
    if (!createRes.ok) {
        console.error(`[smoke] failed to create topic: HTTP ${createRes.status}`);
        const text = await createRes.text();
        console.error(text);
        ws.close();
        orchestrator.close();
        process.exit(1);
    }
    const topic = await createRes.json();
    console.error(`[smoke] topic opened: ${topic.id}`);

    // 2. Post a @mention message
    const msgRes = await fetch(`http://localhost:${port}/api/v1/conversations/${topic.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderId: 'operator', content: PROMPT }),
    });
    if (!msgRes.ok) {
        console.error(`[smoke] failed to post message: HTTP ${msgRes.status}`);
        const text = await msgRes.text();
        console.error(text);
        ws.close();
        orchestrator.close();
        process.exit(1);
    }
    console.error(`[smoke] message posted; awaiting deltas`);

    // 3. Wait for stopping criterion or timeout
    const start = Date.now();
    while (Date.now() - start < TIMEOUT_MS && stoppingAt === null) {
        await new Promise((r) => setTimeout(r, 200));
    }

    // 4. Close + write transcript
    try {
        await fetch(`http://localhost:${port}/api/v1/conversations/${topic.id}/close`, { method: 'POST' });
    } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 200));
    ws.close();

    mkdirSync('.notes', { recursive: true });
    const transcript = {
        topic,
        prompt: PROMPT,
        participants: PARTICIPANTS,
        port,
        durationMs: stoppingAt !== null ? stoppingAt - (topicOpenedAt ?? start) : null,
        firstDeltaLatencyMs: firstDeltaAt !== null && topicOpenedAt !== null ? firstDeltaAt - topicOpenedAt : null,
        deltaCount,
        stopped: stoppingAt !== null,
        events,
    };
    writeFileSync('.notes/theater-smoke-transcript.json', JSON.stringify(transcript, null, 2));
    console.error(`[smoke] transcript saved: .notes/theater-smoke-transcript.json`);
    console.error(`[smoke] summary: deltas=${deltaCount} stopped=${stoppingAt !== null} duration_ms=${transcript.durationMs}`);

    orchestrator.close();
    // Allow open handles to settle
    await new Promise((r) => setTimeout(r, 100));

    const ok = deltaCount > 0 && stoppingAt !== null;
    if (!ok) {
        console.error(`[smoke] FAIL — expected at least one delta and one stopping_criterion in ${TIMEOUT_MS}ms`);
        process.exit(2);
    }
    console.error(`[smoke] PASS`);
    process.exit(0);
}

main().catch((err) => {
    console.error(`[smoke] fatal: ${err.stack || err.message}`);
    process.exit(1);
});
