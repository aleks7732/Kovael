import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentHubStore } from '../services/AgentHubStore.js';

describe('AgentHubStore', () => {
    const tempDirs: string[] = [];
    const originalHubSecret = process.env.KOVAEL_AGENT_HUB_SECRET;
    const originalHubEncryption = process.env.KOVAEL_AGENT_HUB_ENCRYPTION;

    afterEach(() => {
        if (originalHubSecret === undefined) {
            delete process.env.KOVAEL_AGENT_HUB_SECRET;
        } else {
            process.env.KOVAEL_AGENT_HUB_SECRET = originalHubSecret;
        }
        if (originalHubEncryption === undefined) {
            delete process.env.KOVAEL_AGENT_HUB_ENCRYPTION;
        } else {
            process.env.KOVAEL_AGENT_HUB_ENCRYPTION = originalHubEncryption;
        }
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    function tempDbPath(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-agent-hub-'));
        tempDirs.push(dir);
        return path.join(dir, 'shaev', 'agent-hub.sqlite');
    }

    it('persists dispatch state across store reopen without deleting memory', () => {
        const dbPath = tempDbPath();
        const payload = {
            requestId: 'req-1',
            topicId: 'topic-1',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
            messages: [{ role: 'user', content: 'hold this thought' }],
        };

        const first = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 100 });
        expect(first.recordInboundDispatch(payload).duplicate).toBe(false);
        first.markDispatchRunning('req-1');
        first.markDispatchSucceeded('req-1', 'remembered reply');
        first.upsertMemory('last-topic', { topicId: 'topic-1' });
        first.close();

        const reopened = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 200 });
        expect(reopened.getDispatch('req-1')).toMatchObject({
            requestId: 'req-1',
            topicId: 'topic-1',
            agentId: 'shaev',
            status: 'succeeded',
            replyContent: 'remembered reply',
        });
        expect(reopened.getMemory('last-topic')).toEqual({ topicId: 'topic-1' });
        reopened.close();
    });

    it('deduplicates request ids so ChairBridge retries do not double-run runtimes', () => {
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath });
        const payload = {
            requestId: 'req-duplicate',
            topicId: 'topic-duplicate',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
        };

        expect(hub.recordInboundDispatch(payload).duplicate).toBe(false);
        expect(hub.recordInboundDispatch(payload).duplicate).toBe(true);
        expect(hub.stats().dispatches).toBe(1);
        hub.close();
    });

    it('requires a strong hub secret when encryption is required', () => {
        const dbPath = tempDbPath();

        expect(() => new AgentHubStore({
            agentId: 'shaev',
            dbPath,
            encryptionRequired: true,
        })).toThrow(/KOVAEL_AGENT_HUB_SECRET.*32 characters/i);

        const hub = new AgentHubStore({
            agentId: 'shaev',
            dbPath,
            encryptionRequired: true,
            encryptionSecret: '0123456789abcdef0123456789abcdef',
        });
        hub.close();
    });

    it('rejects dispatch payloads for a different agent hub', () => {
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath });

        expect(() => hub.recordInboundDispatch({
            requestId: 'req-wrong-agent',
            topicId: 'topic-wrong-agent',
            agentId: 'nyx-codex',
        })).toThrow(/wrong agent/i);

        hub.close();
    });

    it('migrates v1 hub rows to v2 schema without dropping dispatches or memory', () => {
        const dbPath = tempDbPath();
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const db = new DatabaseSync(dbPath);
        db.exec(`
            CREATE TABLE agent_hub_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE agent_dispatches (
                request_id TEXT PRIMARY KEY,
                topic_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('accepted', 'running', 'succeeded', 'failed')),
                received_at INTEGER NOT NULL,
                started_at INTEGER,
                completed_at INTEGER,
                payload_json TEXT NOT NULL,
                reply_content TEXT,
                error TEXT
            );
            CREATE TABLE agent_memory (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
        db.prepare('INSERT INTO agent_hub_meta (key, value, updated_at) VALUES (?, ?, ?)')
            .run('schema_version', '1', 10);
        db.prepare(`
            INSERT INTO agent_dispatches (
                request_id, topic_id, agent_id, status, received_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run('req-v1', 'topic-v1', 'shaev', 'accepted', 11, JSON.stringify({
            requestId: 'req-v1',
            topicId: 'topic-v1',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
        }));
        db.prepare('INSERT INTO agent_memory (key, value_json, updated_at) VALUES (?, ?, ?)')
            .run('v1-memory', JSON.stringify({ preserved: true }), 12);
        db.close();

        const hub = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 100 });
        const migrated = hub.getDispatch('req-v1');

        expect(migrated).toMatchObject({
            requestId: 'req-v1',
            topicId: 'topic-v1',
            payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            duplicateCount: 0,
            runtimeAttempts: 0,
            replayAfter: null,
        });
        expect(hub.getMemory('v1-memory')).toEqual({ preserved: true });
        hub.close();

        const reopened = new DatabaseSync(dbPath);
        try {
            const meta = reopened.prepare('SELECT value FROM agent_hub_meta WHERE key = ?')
                .get('schema_version') as { value: string };
            const tables = reopened.prepare(`
                SELECT name FROM sqlite_master
                WHERE type = 'table'
                ORDER BY name
            `).all() as Array<{ name: string }>;
            const dispatchColumns = reopened.prepare('PRAGMA table_info(agent_dispatches)')
                .all() as Array<{ name: string }>;

            expect(meta.value).toBe('2');
            expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
                'agent_dispatches',
                'agent_hub_meta',
                'agent_memory',
                'agent_outbox',
                'agent_receipts',
            ]));
            expect(dispatchColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
                'payload_sha256',
                'reply_url',
                'duplicate_count',
                'runtime_attempts',
                'last_runtime_started_at',
                'replay_after',
            ]));
        } finally {
            reopened.close();
        }
    });

    it('deduplicates identical request payloads and rejects request id hash conflicts', () => {
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 100 });
        const payload = {
            requestId: 'req-idempotent',
            topicId: 'topic-idempotent',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
            messages: [{ role: 'user', content: 'same payload' }],
        };

        expect(hub.recordInboundDispatch(payload)).toMatchObject({
            requestId: 'req-idempotent',
            duplicate: false,
        });
        expect(hub.recordInboundDispatch(payload)).toMatchObject({
            requestId: 'req-idempotent',
            duplicate: true,
        });
        expect(hub.getDispatch('req-idempotent')).toMatchObject({
            duplicateCount: 1,
            runtimeAttempts: 0,
        });
        expect(() => hub.recordInboundDispatch({
            ...payload,
            messages: [{ role: 'user', content: 'different payload' }],
        })).toThrow(/payload hash conflict/i);
        expect(hub.getDispatch('req-idempotent')?.duplicateCount).toBe(1);
        hub.close();
    });

    it('does not persist reply proof secrets in dispatch payload rows', () => {
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath });

        hub.recordInboundDispatch({
            requestId: 'req-proof-secret',
            topicId: 'topic-proof-secret',
            agentId: 'shaev',
            claimSessionId: 'claim-session',
            replyProofSecret: 'do-not-store-this-proof-secret',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
        });

        expect(hub.getDispatch('req-proof-secret')?.payload).not.toHaveProperty('replyProofSecret');
        hub.close();

        const rawDb = new DatabaseSync(dbPath);
        try {
            const row = rawDb.prepare('SELECT payload_json FROM agent_dispatches WHERE request_id = ?')
                .get('req-proof-secret') as { payload_json: string };
            expect(row.payload_json).not.toContain('do-not-store-this-proof-secret');
        } finally {
            rawDb.close();
        }
    });

    it('tracks runtime attempts and explicit replay timing', () => {
        const dbPath = tempDbPath();
        let now = 100;
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => now });

        hub.recordInboundDispatch({
            requestId: 'req-replay',
            topicId: 'topic-replay',
            agentId: 'shaev',
        });
        now = 200;
        hub.markDispatchRunning('req-replay');
        now = 300;
        hub.scheduleDispatchReplay('req-replay', 1_000);

        expect(hub.getDispatch('req-replay')).toMatchObject({
            status: 'running',
            startedAt: 200,
            runtimeAttempts: 1,
            lastRuntimeStartedAt: 200,
            replayAfter: 1_000,
        });
        hub.close();
    });

    it('uses WAL mode for file-backed hub databases', () => {
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath });
        const mode = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const row = mode.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
            expect(row.journal_mode.toLowerCase()).toBe('wal');
        } finally {
            mode.close();
            hub.close();
        }
    });

    it('records runtime success, reply outbox, and success receipt atomically', () => {
        const dbPath = tempDbPath();
        let now = 100;
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => now });
        const replyUrl = 'http://127.0.0.1:8080/api/v1/chairs/reply';

        hub.recordInboundDispatch({
            requestId: 'req-success',
            topicId: 'topic-success',
            agentId: 'shaev',
            replyUrl,
            messages: [{ role: 'user', content: 'respond durably' }],
        });
        now = 110;
        hub.markDispatchRunning('req-success');
        now = 120;
        hub.markDispatchSucceeded('req-success', 'durable reply');

        const dispatch = hub.getDispatch('req-success');
        const outbox = hub.listOutbox();
        const receipts = hub.listReceipts('req-success');

        expect(dispatch).toMatchObject({
            status: 'succeeded',
            completedAt: 120,
            replyContent: 'durable reply',
        });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({
            requestId: 'req-success',
            kind: 'reply',
            status: 'pending',
            targetUrl: replyUrl,
            payload: {
                topicId: 'topic-success',
                agentId: 'shaev',
                content: 'durable reply',
            },
        });
        expect(receipts.map((receipt) => receipt.kind)).toEqual([
            'dispatch_received',
            'runtime_started',
            'runtime_succeeded',
        ]);
        expect(receipts.at(-1)).toMatchObject({
            requestId: 'req-success',
            payload: expect.objectContaining({
                outboxId: outbox[0].id,
                status: 'succeeded',
            }),
        });
        hub.close();
    });

    it('stores memory and expiring cache rows with TTL metadata', () => {
        const dbPath = tempDbPath();
        let now = 1_000;
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => now });

        hub.upsertMemory('durable-memory', { keep: true });
        hub.upsertCache('short-cache', { drop: true }, 50);

        expect(hub.getMemory('durable-memory')).toEqual({ keep: true });
        expect(hub.getCache('short-cache')).toEqual({ drop: true });

        now = 1_100;
        expect(hub.getCache('short-cache')).toBeNull();
        expect(hub.pruneExpiredCache()).toBe(1);
        expect(hub.getMemory('durable-memory')).toEqual({ keep: true });
        expect(hub.stats().memories).toBe(1);
        hub.close();
    });

    it('prunes old terminal outbox rows and old receipts without touching pending outbox', () => {
        const dbPath = tempDbPath();
        let now = 100;
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => now });

        hub.recordInboundDispatch({
            requestId: 'req-prune-sent',
            topicId: 'topic-prune-sent',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
        });
        hub.markDispatchSucceeded('req-prune-sent', 'old sent reply');
        const sent = hub.listOutbox()[0];

        hub.recordInboundDispatch({
            requestId: 'req-prune-pending',
            topicId: 'topic-prune-pending',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
        });
        hub.markDispatchSucceeded('req-prune-pending', 'pending reply');

        now = 200;
        hub.markOutboxSent(sent.id);
        now = 1_000;

        expect(hub.pruneTerminalOutbox(500)).toBe(1);
        expect(hub.listOutbox().map((row) => row.requestId)).toEqual(['req-prune-pending']);
        expect(hub.pruneOldReceipts(500)).toBeGreaterThan(0);
        expect(hub.listReceipts('req-prune-sent')).toHaveLength(0);
        hub.close();
    });

    it('redacts and encrypts runtime failure details before persistence', () => {
        process.env.KOVAEL_AGENT_HUB_SECRET = '0123456789abcdef0123456789abcdef';
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 100 });

        hub.recordInboundDispatch({
            requestId: 'req-failed-redacted',
            topicId: 'topic-failed-redacted',
            agentId: 'shaev',
            messages: [{ role: 'user', content: 'prompt should not be in failure' }],
        });
        hub.markDispatchFailed(
            'req-failed-redacted',
            'runtime stderr KOVAEL_SECRET_CANARY=super-secret-value bearer abcdefghijklmnopqrstuvwxyz0123456789abcdef',
        );
        expect(hub.getDispatch('req-failed-redacted')?.error).toContain('KOVAEL_SECRET_CANARY=[REDACTED]');
        hub.close();

        const rawDb = new DatabaseSync(dbPath);
        try {
            const row = rawDb.prepare('SELECT error FROM agent_dispatches WHERE request_id = ?')
                .get('req-failed-redacted') as { error: string };
            const receipt = rawDb.prepare('SELECT payload_body FROM agent_receipts WHERE request_id = ? ORDER BY created_at DESC LIMIT 1')
                .get('req-failed-redacted') as { payload_body: string };
            expect(row.error).not.toContain('super-secret-value');
            expect(row.error).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789abcdef');
            expect(receipt.payload_body).not.toContain('super-secret-value');
        } finally {
            rawDb.close();
        }
    });

    it('encrypts sensitive payload, reply, outbox, receipt, and memory values when a hub secret is configured', () => {
        process.env.KOVAEL_AGENT_HUB_SECRET = '0123456789abcdef0123456789abcdef';
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 100 });

        hub.recordInboundDispatch({
            requestId: 'req-encrypted',
            topicId: 'topic-encrypted',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
            messages: [{ role: 'user', content: 'private dispatch payload' }],
        });
        hub.markDispatchSucceeded('req-encrypted', 'private reply value');
        hub.upsertMemory('secret-memory', { value: 'private memory value' });
        hub.close();

        const rawDb = new DatabaseSync(dbPath);
        try {
            const dispatch = rawDb.prepare(`
                SELECT payload_json, reply_content FROM agent_dispatches WHERE request_id = ?
            `).get('req-encrypted') as { payload_json: string; reply_content: string };
            const outbox = rawDb.prepare('SELECT payload_body FROM agent_outbox WHERE request_id = ?')
                .get('req-encrypted') as { payload_body: string };
            const receipt = rawDb.prepare('SELECT payload_body FROM agent_receipts WHERE request_id = ? ORDER BY created_at DESC LIMIT 1')
                .get('req-encrypted') as { payload_body: string };
            const memory = rawDb.prepare('SELECT value_json FROM agent_memory WHERE key = ?')
                .get('secret-memory') as { value_json: string };

            expect(dispatch.payload_json).not.toContain('private dispatch payload');
            expect(dispatch.reply_content).not.toContain('private reply value');
            expect(outbox.payload_body).not.toContain('private reply value');
            expect(receipt.payload_body).not.toContain('private reply value');
            expect(memory.value_json).not.toContain('private memory value');
        } finally {
            rawDb.close();
        }

        const reopened = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 200 });
        expect(reopened.getDispatch('req-encrypted')).toMatchObject({
            payload: expect.objectContaining({
                messages: [{ role: 'user', content: 'private dispatch payload' }],
            }),
            replyContent: 'private reply value',
        });
        expect(reopened.listOutbox()[0].payload).toMatchObject({
            content: 'private reply value',
        });
        expect(reopened.getMemory('secret-memory')).toEqual({ value: 'private memory value' });
        reopened.close();
    });
});
