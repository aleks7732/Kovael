import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { createChairReplyProof } from './ChairDispatchSecurity.js';
import {
    AGENT_HUB_ENCRYPTION_ENV,
    AGENT_HUB_SECRET_ENV,
    isHubEncryptionRequired,
    isValidAgentHubSecret,
    redactSensitiveText,
} from './RuntimeSecurity.js';
import { prepareLocalSqliteFile } from './SqlitePathSecurity.js';

export type AgentDispatchStatus = 'accepted' | 'running' | 'succeeded' | 'failed';
export type AgentOutboxKind = 'reply' | 'receipt';
export type AgentOutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead';
export type AgentMemoryKind = 'memory' | 'cache';

export interface AgentHubStoreOptions {
    agentId: string;
    dbPath: string;
    now?: () => number;
    encryptionSecret?: string;
    encryptionRequired?: boolean;
}

export interface AgentDispatchPayload {
    requestId?: unknown;
    topicId?: unknown;
    agentId?: unknown;
    replyUrl?: unknown;
    [key: string]: unknown;
}

export interface AgentDispatchRecord {
    requestId: string;
    topicId: string;
    agentId: string;
    status: AgentDispatchStatus;
    receivedAt: number;
    startedAt: number | null;
    completedAt: number | null;
    payload: AgentDispatchPayload;
    payloadHash: string;
    replyUrl: string | null;
    replyContent: string | null;
    error: string | null;
    duplicateCount: number;
    lastSeenAt: number | null;
    runtimeAttempts: number;
    lastRuntimeStartedAt: number | null;
    replayAfter: number | null;
}

export interface AgentDispatchInsertResult {
    requestId: string;
    duplicate: boolean;
    payloadHash: string;
}

export interface AgentDispatchOutboxResult {
    requestId: string;
    outboxId: string | null;
}

export interface AgentOutboxRecord {
    id: string;
    requestId: string;
    kind: AgentOutboxKind;
    dedupeKey: string;
    targetUrl: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    status: AgentOutboxStatus;
    attempts: number;
    nextAttemptAt: number | null;
    lastError: string | null;
    createdAt: number;
    updatedAt: number;
    sentAt: number | null;
}

export interface AgentReceiptRecord {
    id: string;
    requestId: string | null;
    kind: string;
    payload: Record<string, unknown>;
    prevHash: string | null;
    receiptHash: string;
    createdAt: number;
}

export interface AgentHubStats {
    dispatches: number;
    accepted: number;
    running: number;
    succeeded: number;
    failed: number;
    memories: number;
    caches: number;
    outbox: number;
    receipts: number;
}

interface CountRow {
    count: number;
}

interface DispatchRow {
    request_id: string;
    topic_id: string;
    agent_id: string;
    status: AgentDispatchStatus;
    received_at: number;
    started_at: number | null;
    completed_at: number | null;
    payload_json: string;
    payload_sha256: string | null;
    reply_url: string | null;
    reply_content: string | null;
    error: string | null;
    duplicate_count: number | null;
    last_seen_at: number | null;
    runtime_attempts: number | null;
    last_runtime_started_at: number | null;
    replay_after: number | null;
}

interface OutboxRow {
    id: string;
    request_id: string;
    kind: AgentOutboxKind;
    dedupe_key: string;
    target_url: string;
    payload_body: string;
    payload_sha256: string;
    status: AgentOutboxStatus;
    attempts: number;
    next_attempt_at: number | null;
    last_error: string | null;
    created_at: number;
    updated_at: number;
    sent_at: number | null;
}

interface ReceiptRow {
    id: string;
    request_id: string | null;
    kind: string;
    payload_body: string;
    prev_hash: string | null;
    receipt_hash: string;
    created_at: number;
}

interface MemoryRow {
    value_json: string;
    kind: AgentMemoryKind;
    expires_at: number | null;
}

const SCHEMA_VERSION = '2';
const ENCRYPTED_VALUE_MARKER = '__kovaelEncrypted';
const ENCRYPTED_VALUE_VERSION = 1;
const ENCRYPTION_AAD_VERSION = 'kovael-agent-hub-field-v1';
const ENCRYPTION_ALG = 'A256GCM';

/**
 * AgentHubStore is a local, per-agent edge log. It is intentionally not a
 * global source of truth; the orchestrator owns chairs, topics, and routing.
 * A hub file can be deleted and rebuilt without corrupting Kovael state.
 */
export class AgentHubStore {
    private readonly db: DatabaseSync;
    private readonly now: () => number;
    private readonly encryptionSecret: string | null;
    private encryptionKey: Buffer | null = null;
    public readonly agentId: string;
    public readonly dbPath: string;

    constructor(options: AgentHubStoreOptions) {
        const agentId = options.agentId.trim();
        if (!agentId) throw new Error('agentId is required');
        this.agentId = agentId;
        this.dbPath = options.dbPath;
        this.now = options.now ?? (() => Date.now());
        const encryptionRequired = options.encryptionRequired ?? isHubEncryptionRequired(process.env);
        this.encryptionSecret = readHubSecret(options.encryptionSecret, encryptionRequired);

        prepareLocalSqliteFile(this.dbPath, 'agent hub db');
        this.db = new DatabaseSync(this.dbPath);
        this.configure();
        this.migrate();
    }

    public recordInboundDispatch(payload: AgentDispatchPayload): AgentDispatchInsertResult {
        const requestId = requiredString(payload.requestId, 'requestId');
        const topicId = requiredString(payload.topicId, 'topicId');
        const agentId = requiredString(payload.agentId, 'agentId');
        if (agentId !== this.agentId) {
            throw new Error(`wrong agent hub: expected ${this.agentId}, got ${agentId}`);
        }

        const payloadJson = stableStringify(payload);
        const persistedPayloadJson = stableStringify(persistableDispatchPayload(payload));
        const payloadHash = sha256(payloadJson);
        const stamp = this.now();
        const existing = this.db.prepare(`
            SELECT payload_sha256, duplicate_count
            FROM agent_dispatches
            WHERE request_id = ?
        `).get(requestId) as { payload_sha256: string | null; duplicate_count: number | null } | undefined;

        if (existing) {
            if (existing.payload_sha256 && existing.payload_sha256 !== payloadHash) {
                throw new Error(`dispatch payload hash conflict for requestId ${requestId}`);
            }
            this.db.prepare(`
                UPDATE agent_dispatches
                SET duplicate_count = COALESCE(duplicate_count, 0) + 1,
                    last_seen_at = ?,
                    payload_sha256 = COALESCE(payload_sha256, ?)
                WHERE request_id = ?
            `).run(stamp, payloadHash, requestId);
            return { requestId, duplicate: true, payloadHash };
        }

        this.withTransaction(() => {
            this.db.prepare(`
                INSERT INTO agent_dispatches (
                    request_id, topic_id, agent_id, status, received_at, last_seen_at,
                    payload_json, payload_sha256, reply_url
                ) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?)
            `).run(
                requestId,
                topicId,
                agentId,
                stamp,
                stamp,
                this.encodeSensitive(persistedPayloadJson, aad('agent_dispatches', requestId, 'payload_json')),
                payloadHash,
                stringOrNull(payload.replyUrl),
            );
            this.appendReceipt(requestId, 'dispatch_received', {
                requestId,
                topicId,
                agentId,
                payloadHash,
                status: 'accepted',
            });
        });

        return { requestId, duplicate: false, payloadHash };
    }

    public markDispatchRunning(requestId: string): void {
        const stamp = this.now();
        this.withTransaction(() => {
            const result = this.db.prepare(`
                UPDATE agent_dispatches
                SET status = 'running',
                    started_at = COALESCE(started_at, ?),
                    runtime_attempts = COALESCE(runtime_attempts, 0) + 1,
                    last_runtime_started_at = ?,
                    replay_after = NULL,
                    error = NULL
                WHERE request_id = ?
            `).run(stamp, stamp, requestId) as { changes: number };
            if (result.changes === 0) throw new Error(`unknown dispatch requestId ${requestId}`);
            const attempts = this.db.prepare('SELECT runtime_attempts FROM agent_dispatches WHERE request_id = ?')
                .get(requestId) as { runtime_attempts: number };
            this.appendReceipt(requestId, 'runtime_started', {
                requestId,
                status: 'running',
                runtimeAttempts: attempts.runtime_attempts,
                startedAt: stamp,
            });
        });
    }

    public scheduleDispatchReplay(requestId: string, replayAfter: number): void {
        if (!Number.isFinite(replayAfter) || replayAfter < 0) {
            throw new Error('replayAfter must be a non-negative timestamp');
        }
        const result = this.db.prepare(`
            UPDATE agent_dispatches
            SET replay_after = ?
            WHERE request_id = ?
        `).run(Math.floor(replayAfter), requestId) as { changes: number };
        if (result.changes === 0) throw new Error(`unknown dispatch requestId ${requestId}`);
    }

    public markDispatchSucceeded(
        requestId: string,
        replyContent: string,
        proofFields?: { claimSessionId?: string; replyProofSecret?: string },
    ): AgentDispatchOutboxResult {
        const stamp = this.now();
        return this.withTransaction(() => {
            const dispatch = this.requireDispatchRow(requestId);
            let outboxId: string | null = null;
            const dispatchPayload = this.dispatchFromRow(dispatch).payload;
            const claimSessionId = stringOrNull(proofFields?.claimSessionId)
                ?? stringOrNull(dispatchPayload.claimSessionId);
            const replyProofSecret = stringOrNull(proofFields?.replyProofSecret)
                ?? stringOrNull(dispatchPayload.replyProofSecret);
            const replyPayload = {
                topicId: dispatch.topic_id,
                agentId: dispatch.agent_id,
                content: replyContent,
                requestId,
                ...(claimSessionId ? { claimSessionId } : {}),
                ...(claimSessionId && replyProofSecret
                    ? {
                        replyProof: createChairReplyProof({
                            requestId,
                            claimSessionId,
                            replyProofSecret,
                        }),
                    }
                    : {}),
                status: 'succeeded',
            };

            if (dispatch.reply_url) {
                outboxId = this.upsertOutboxReply(
                    requestId,
                    dispatch.reply_url,
                    replyPayload,
                    stamp,
                );
            }

            const result = this.db.prepare(`
                UPDATE agent_dispatches
                SET status = 'succeeded',
                    completed_at = ?,
                    reply_content = ?,
                    replay_after = NULL,
                    error = NULL
                WHERE request_id = ?
            `).run(
                stamp,
                this.encodeSensitive(replyContent, aad('agent_dispatches', requestId, 'reply_content')),
                requestId,
            ) as { changes: number };
            if (result.changes === 0) throw new Error(`unknown dispatch requestId ${requestId}`);

            this.appendReceipt(requestId, 'runtime_succeeded', {
                requestId,
                status: 'succeeded',
                completedAt: stamp,
                outboxId,
                replyHash: sha256(replyContent),
            });
            return { requestId, outboxId };
        });
    }

    public markDispatchFailed(
        requestId: string,
        error: string,
        proofFields?: { claimSessionId?: string; replyProofSecret?: string },
    ): AgentDispatchOutboxResult {
        const stamp = this.now();
        const safeError = redactSensitiveText(error);
        return this.withTransaction(() => {
            const dispatch = this.requireDispatchRow(requestId);
            let outboxId: string | null = null;
            const dispatchPayload = this.dispatchFromRow(dispatch).payload;
            const claimSessionId = stringOrNull(proofFields?.claimSessionId)
                ?? stringOrNull(dispatchPayload.claimSessionId);
            const replyProofSecret = stringOrNull(proofFields?.replyProofSecret)
                ?? stringOrNull(dispatchPayload.replyProofSecret);
            const replyPayload = {
                topicId: dispatch.topic_id,
                agentId: dispatch.agent_id,
                content: safeError,
                requestId,
                ...(claimSessionId ? { claimSessionId } : {}),
                ...(claimSessionId && replyProofSecret
                    ? {
                        replyProof: createChairReplyProof({
                            requestId,
                            claimSessionId,
                            replyProofSecret,
                        }),
                    }
                    : {}),
                status: 'failed',
                error: safeError,
            };

            if (dispatch.reply_url) {
                outboxId = this.upsertOutboxReply(
                    requestId,
                    dispatch.reply_url,
                    replyPayload,
                    stamp,
                );
            }

            const result = this.db.prepare(`
                UPDATE agent_dispatches
                SET status = 'failed',
                    completed_at = ?,
                    error = ?
                WHERE request_id = ?
            `).run(
                stamp,
                this.encodeSensitive(safeError, aad('agent_dispatches', requestId, 'error')),
                requestId,
            ) as { changes: number };
            if (result.changes === 0) throw new Error(`unknown dispatch requestId ${requestId}`);
            this.appendReceipt(requestId, 'runtime_failed', {
                requestId,
                status: 'failed',
                completedAt: stamp,
                error: safeError,
                outboxId,
            });
            return { requestId, outboxId };
        });
    }

    public getDispatch(requestId: string): AgentDispatchRecord | null {
        const row = this.db.prepare(`
            SELECT request_id, topic_id, agent_id, status, received_at, started_at,
                   completed_at, payload_json, payload_sha256, reply_url,
                   reply_content, error, duplicate_count, last_seen_at,
                   runtime_attempts, last_runtime_started_at, replay_after
            FROM agent_dispatches
            WHERE request_id = ?
        `).get(requestId) as DispatchRow | undefined;
        return row ? this.dispatchFromRow(row) : null;
    }

    public upsertMemory(key: string, value: unknown, ttlMs?: number): void {
        this.upsertMemoryValue(key, value, 'memory', ttlMs);
    }

    public upsertCache(key: string, value: unknown, ttlMs: number): void {
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be positive');
        this.upsertMemoryValue(key, value, 'cache', ttlMs);
    }

    public getMemory(key: string): unknown {
        return this.getMemoryValue(key, 'memory');
    }

    public getCache(key: string): unknown {
        return this.getMemoryValue(key, 'cache');
    }

    public listOutbox(status?: AgentOutboxStatus): AgentOutboxRecord[] {
        const sql = status
            ? `SELECT id, request_id, kind, dedupe_key, target_url, payload_body,
                      payload_sha256, status, attempts, next_attempt_at, last_error,
                      created_at, updated_at, sent_at
               FROM agent_outbox
               WHERE status = ?
               ORDER BY created_at ASC, rowid ASC`
            : `SELECT id, request_id, kind, dedupe_key, target_url, payload_body,
                      payload_sha256, status, attempts, next_attempt_at, last_error,
                      created_at, updated_at, sent_at
               FROM agent_outbox
               ORDER BY created_at ASC, rowid ASC`;
        const rows = status
            ? this.db.prepare(sql).all(status) as unknown as OutboxRow[]
            : this.db.prepare(sql).all() as unknown as OutboxRow[];
        return rows.map((row) => this.outboxFromRow(row));
    }

    public markOutboxSent(id: string): void {
        const stamp = this.now();
        const existing = this.db.prepare('SELECT status FROM agent_outbox WHERE id = ?')
            .get(id) as { status: AgentOutboxStatus } | undefined;
        if (!existing) throw new Error(`unknown outbox id ${id}`);
        if (existing.status === 'sent') return;
        const result = this.db.prepare(`
            UPDATE agent_outbox
            SET status = 'sent',
                sent_at = ?,
                updated_at = ?,
                last_error = NULL
            WHERE id = ?
        `).run(stamp, stamp, id) as { changes: number };
        if (result.changes === 0) throw new Error(`unknown outbox id ${id}`);
    }

    public claimDueOutbox(limit: number, leaseMs: number): AgentOutboxRecord[] {
        if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit must be positive');
        if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be positive');
        const stamp = this.now();
        const staleBefore = stamp - Math.floor(leaseMs);
        return this.withTransaction(() => {
            const rows = this.db.prepare(`
                SELECT id, request_id, kind, dedupe_key, target_url, payload_body,
                       payload_sha256, status, attempts, next_attempt_at, last_error,
                       created_at, updated_at, sent_at
                FROM agent_outbox
                WHERE (
                    status IN ('pending', 'failed')
                    AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                ) OR (
                    status = 'sending'
                    AND updated_at <= ?
                )
                ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
                LIMIT ?
            `).all(stamp, staleBefore, Math.floor(limit)) as unknown as OutboxRow[];

            const claim = this.db.prepare(`
                UPDATE agent_outbox
                SET status = 'sending',
                    attempts = attempts + 1,
                    next_attempt_at = NULL,
                    updated_at = ?
                WHERE id = ?
            `);
            for (const row of rows) {
                claim.run(stamp, row.id);
            }
            if (rows.length === 0) return [];
            const placeholders = rows.map(() => '?').join(', ');
            const claimedRows = this.db.prepare(`
                SELECT id, request_id, kind, dedupe_key, target_url, payload_body,
                       payload_sha256, status, attempts, next_attempt_at, last_error,
                       created_at, updated_at, sent_at
                FROM agent_outbox
                WHERE id IN (${placeholders})
                ORDER BY created_at ASC, rowid ASC
            `).all(...rows.map((row) => row.id)) as unknown as OutboxRow[];
            return claimedRows.map((row) => this.outboxFromRow(row));
        });
    }

    public markOutboxDeliveryFailed(
        id: string,
        error: string,
        retryAt: number | null,
        maxAttempts: number,
    ): void {
        if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
            throw new Error('maxAttempts must be positive');
        }
        if (retryAt !== null && (!Number.isFinite(retryAt) || retryAt < 0)) {
            throw new Error('retryAt must be null or a non-negative timestamp');
        }
        const row = this.db.prepare('SELECT attempts FROM agent_outbox WHERE id = ?')
            .get(id) as { attempts: number } | undefined;
        if (!row) throw new Error(`unknown outbox id ${id}`);
        const exhausted = row.attempts >= Math.floor(maxAttempts);
        const terminal = retryAt === null || exhausted;
        const stamp = this.now();
        this.db.prepare(`
            UPDATE agent_outbox
            SET status = ?,
                next_attempt_at = ?,
                last_error = ?,
                updated_at = ?
            WHERE id = ?
        `).run(
            terminal ? 'dead' : 'failed',
            terminal ? null : Math.floor(retryAt),
            redactSensitiveText(error),
            stamp,
            id,
        );
    }

    public listReceipts(requestId?: string): AgentReceiptRecord[] {
        const sql = requestId
            ? `SELECT id, request_id, kind, payload_body, prev_hash, receipt_hash, created_at
               FROM agent_receipts
               WHERE request_id = ?
               ORDER BY created_at ASC, rowid ASC`
            : `SELECT id, request_id, kind, payload_body, prev_hash, receipt_hash, created_at
               FROM agent_receipts
               ORDER BY created_at ASC, rowid ASC`;
        const rows = requestId
            ? this.db.prepare(sql).all(requestId) as unknown as ReceiptRow[]
            : this.db.prepare(sql).all() as unknown as ReceiptRow[];
        return rows.map((row) => this.receiptFromRow(row));
    }

    public pruneExpiredCache(): number {
        const result = this.db.prepare(`
            DELETE FROM agent_memory
            WHERE kind = 'cache'
              AND expires_at IS NOT NULL
              AND expires_at <= ?
        `).run(this.now()) as { changes: number };
        return result.changes;
    }

    public pruneTerminalOutbox(beforeTimestamp: number): number {
        const result = this.db.prepare(`
            DELETE FROM agent_outbox
            WHERE status IN ('sent', 'dead')
              AND updated_at < ?
        `).run(beforeTimestamp) as { changes: number };
        return result.changes;
    }

    public pruneOldReceipts(beforeTimestamp: number): number {
        const result = this.db.prepare(`
            DELETE FROM agent_receipts
            WHERE created_at < ?
        `).run(beforeTimestamp) as { changes: number };
        return result.changes;
    }

    public stats(): AgentHubStats {
        return {
            dispatches: this.count('agent_dispatches'),
            accepted: this.countDispatchStatus('accepted'),
            running: this.countDispatchStatus('running'),
            succeeded: this.countDispatchStatus('succeeded'),
            failed: this.countDispatchStatus('failed'),
            memories: this.countMemoryKind('memory'),
            caches: this.countMemoryKind('cache'),
            outbox: this.count('agent_outbox'),
            receipts: this.count('agent_receipts'),
        };
    }

    public close(): void {
        this.db.close();
    }

    private configure(): void {
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;
        `);
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_hub_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
        this.encryptionKey = this.initializeEncryptionKey();

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_dispatches (
                request_id TEXT PRIMARY KEY,
                topic_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('accepted', 'running', 'succeeded', 'failed')),
                received_at INTEGER NOT NULL,
                started_at INTEGER,
                completed_at INTEGER,
                payload_json TEXT NOT NULL,
                payload_sha256 TEXT NOT NULL,
                reply_url TEXT,
                reply_content TEXT,
                error TEXT,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                last_seen_at INTEGER,
                runtime_attempts INTEGER NOT NULL DEFAULT 0,
                last_runtime_started_at INTEGER,
                replay_after INTEGER
            );

            CREATE TABLE IF NOT EXISTS agent_memory (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                kind TEXT NOT NULL DEFAULT 'memory' CHECK(kind IN ('memory', 'cache')),
                created_at INTEGER,
                expires_at INTEGER,
                last_accessed_at INTEGER,
                access_count INTEGER NOT NULL DEFAULT 0,
                value_sha256 TEXT,
                size_bytes INTEGER
            );

            CREATE TABLE IF NOT EXISTS agent_outbox (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('reply', 'receipt')),
                dedupe_key TEXT NOT NULL UNIQUE,
                target_url TEXT NOT NULL,
                payload_body TEXT NOT NULL,
                payload_sha256 TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                sent_at INTEGER,
                FOREIGN KEY(request_id) REFERENCES agent_dispatches(request_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_receipts (
                id TEXT PRIMARY KEY,
                request_id TEXT,
                kind TEXT NOT NULL,
                payload_body TEXT NOT NULL,
                prev_hash TEXT,
                receipt_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(request_id) REFERENCES agent_dispatches(request_id) ON DELETE SET NULL
            );
        `);

        this.ensureDispatchColumn('payload_sha256', 'TEXT');
        this.ensureDispatchColumn('reply_url', 'TEXT');
        this.ensureDispatchColumn('duplicate_count', 'INTEGER NOT NULL DEFAULT 0');
        this.ensureDispatchColumn('last_seen_at', 'INTEGER');
        this.ensureDispatchColumn('runtime_attempts', 'INTEGER NOT NULL DEFAULT 0');
        this.ensureDispatchColumn('last_runtime_started_at', 'INTEGER');
        this.ensureDispatchColumn('replay_after', 'INTEGER');
        this.ensureMemoryColumn('kind', "TEXT NOT NULL DEFAULT 'memory'");
        this.ensureMemoryColumn('created_at', 'INTEGER');
        this.ensureMemoryColumn('expires_at', 'INTEGER');
        this.ensureMemoryColumn('last_accessed_at', 'INTEGER');
        this.ensureMemoryColumn('access_count', 'INTEGER NOT NULL DEFAULT 0');
        this.ensureMemoryColumn('value_sha256', 'TEXT');
        this.ensureMemoryColumn('size_bytes', 'INTEGER');
        this.backfillV2Columns();

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_agent_dispatches_status
                ON agent_dispatches(status, received_at);
            CREATE INDEX IF NOT EXISTS idx_agent_dispatches_replay
                ON agent_dispatches(status, replay_after);
            CREATE INDEX IF NOT EXISTS idx_agent_outbox_status
                ON agent_outbox(status, next_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_agent_memory_expiry
                ON agent_memory(kind, expires_at);
            CREATE INDEX IF NOT EXISTS idx_agent_receipts_request
                ON agent_receipts(request_id, created_at);
        `);

        const stamp = this.now();
        const meta = this.db.prepare(`
            INSERT INTO agent_hub_meta (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
        `);
        meta.run('schema_version', SCHEMA_VERSION, stamp);
        meta.run('agent_id', this.agentId, stamp);
    }

    private initializeEncryptionKey(): Buffer | null {
        if (!this.encryptionSecret) return null;
        const salt = this.metaValue('encryption_salt') ?? this.createEncryptionSalt();
        return crypto.scryptSync(this.encryptionSecret, Buffer.from(salt, 'base64url'), 32);
    }

    private createEncryptionSalt(): string {
        const salt = crypto.randomBytes(16).toString('base64url');
        this.db.prepare(`
            INSERT INTO agent_hub_meta (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO NOTHING
        `).run('encryption_salt', salt, this.now());
        return this.metaValue('encryption_salt') ?? salt;
    }

    private metaValue(key: string): string | null {
        const row = this.db.prepare('SELECT value FROM agent_hub_meta WHERE key = ?')
            .get(key) as { value: string } | undefined;
        return row?.value ?? null;
    }

    private ensureDispatchColumn(name: string, definition: string): void {
        if (!this.columnExists('agent_dispatches', name)) {
            this.db.exec(`ALTER TABLE agent_dispatches ADD COLUMN ${name} ${definition}`);
        }
    }

    private ensureMemoryColumn(name: string, definition: string): void {
        if (!this.columnExists('agent_memory', name)) {
            this.db.exec(`ALTER TABLE agent_memory ADD COLUMN ${name} ${definition}`);
        }
    }

    private columnExists(table: string, name: string): boolean {
        const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        return rows.some((row) => row.name === name);
    }

    private backfillV2Columns(): void {
        const dispatchRows = this.db.prepare(`
            SELECT request_id, payload_json, payload_sha256, reply_url, last_seen_at
            FROM agent_dispatches
        `).all() as Array<{
            request_id: string;
            payload_json: string;
            payload_sha256: string | null;
            reply_url: string | null;
            last_seen_at: number | null;
        }>;
        const updateDispatch = this.db.prepare(`
            UPDATE agent_dispatches
            SET payload_sha256 = COALESCE(payload_sha256, ?),
                reply_url = COALESCE(reply_url, ?),
                duplicate_count = COALESCE(duplicate_count, 0),
                last_seen_at = COALESCE(last_seen_at, received_at),
                runtime_attempts = COALESCE(runtime_attempts, 0)
            WHERE request_id = ?
        `);
        for (const row of dispatchRows) {
            const payloadJson = this.decodeSensitive(row.payload_json, aad('agent_dispatches', row.request_id, 'payload_json'));
            const payload = safeJsonObject(payloadJson);
            updateDispatch.run(
                row.payload_sha256 ?? sha256(stableStringify(payload)),
                row.reply_url ?? stringOrNull(payload.replyUrl),
                row.request_id,
            );
        }

        const memoryRows = this.db.prepare(`
            SELECT key, value_json, updated_at, created_at, value_sha256, size_bytes
            FROM agent_memory
        `).all() as Array<{
            key: string;
            value_json: string;
            updated_at: number;
            created_at: number | null;
            value_sha256: string | null;
            size_bytes: number | null;
        }>;
        const updateMemory = this.db.prepare(`
            UPDATE agent_memory
            SET kind = COALESCE(kind, 'memory'),
                created_at = COALESCE(created_at, ?),
                access_count = COALESCE(access_count, 0),
                value_sha256 = COALESCE(value_sha256, ?),
                size_bytes = COALESCE(size_bytes, ?)
            WHERE key = ?
        `);
        for (const row of memoryRows) {
            const valueJson = this.decodeSensitive(row.value_json, aad('agent_memory', row.key, 'value_json'));
            updateMemory.run(
                row.created_at ?? row.updated_at,
                row.value_sha256 ?? sha256(valueJson),
                row.size_bytes ?? Buffer.byteLength(valueJson),
                row.key,
            );
        }
    }

    private requireDispatchRow(requestId: string): DispatchRow {
        const row = this.db.prepare(`
            SELECT request_id, topic_id, agent_id, status, received_at, started_at,
                   completed_at, payload_json, payload_sha256, reply_url,
                   reply_content, error, duplicate_count, last_seen_at,
                   runtime_attempts, last_runtime_started_at, replay_after
            FROM agent_dispatches
            WHERE request_id = ?
        `).get(requestId) as DispatchRow | undefined;
        if (!row) throw new Error(`unknown dispatch requestId ${requestId}`);
        return row;
    }

    private upsertOutboxReply(
        requestId: string,
        targetUrl: string,
        payload: Record<string, unknown>,
        stamp: number,
    ): string {
        const id = crypto.randomUUID();
        const dedupeKey = `reply:${requestId}`;
        const payloadBody = stableStringify(payload);
        const payloadHash = sha256(payloadBody);
        this.db.prepare(`
            INSERT INTO agent_outbox (
                id, request_id, kind, dedupe_key, target_url, payload_body,
                payload_sha256, status, attempts, created_at, updated_at
            ) VALUES (?, ?, 'reply', ?, ?, ?, ?, 'pending', 0, ?, ?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                target_url = CASE
                    WHEN agent_outbox.status = 'sent' THEN agent_outbox.target_url
                    ELSE excluded.target_url
                END,
                payload_body = CASE
                    WHEN agent_outbox.status = 'sent' THEN agent_outbox.payload_body
                    ELSE excluded.payload_body
                END,
                payload_sha256 = CASE
                    WHEN agent_outbox.status = 'sent' THEN agent_outbox.payload_sha256
                    ELSE excluded.payload_sha256
                END,
                status = CASE
                    WHEN agent_outbox.status = 'sent' THEN agent_outbox.status
                    ELSE 'pending'
                END,
                attempts = CASE
                    WHEN agent_outbox.status = 'sent' THEN agent_outbox.attempts
                    ELSE 0
                END,
                next_attempt_at = CASE
                    WHEN agent_outbox.status = 'sent' THEN agent_outbox.next_attempt_at
                    ELSE NULL
                END,
                updated_at = CASE
                    WHEN agent_outbox.status = 'sent' THEN agent_outbox.updated_at
                    ELSE excluded.updated_at
                END,
                last_error = CASE
                    WHEN agent_outbox.status = 'sent' THEN agent_outbox.last_error
                    ELSE NULL
                END
        `).run(
            id,
            requestId,
            dedupeKey,
            targetUrl,
            this.encodeSensitive(payloadBody, aad('agent_outbox', dedupeKey, 'payload_body')),
            payloadHash,
            stamp,
            stamp,
        );
        const row = this.db.prepare('SELECT id FROM agent_outbox WHERE dedupe_key = ?')
            .get(dedupeKey) as { id: string };
        return row.id;
    }

    private appendReceipt(
        requestId: string | null,
        kind: string,
        payload: Record<string, unknown>,
    ): AgentReceiptRecord {
        const id = crypto.randomUUID();
        const createdAt = this.now();
        const payloadBody = stableStringify(payload);
        const prev = requestId
            ? this.db.prepare(`
                SELECT receipt_hash
                FROM agent_receipts
                WHERE request_id = ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT 1
            `).get(requestId) as { receipt_hash: string } | undefined
            : undefined;
        const prevHash = prev?.receipt_hash ?? null;
        const receiptHash = sha256(`${prevHash ?? ''}\n${kind}\n${createdAt}\n${payloadBody}`);
        this.db.prepare(`
            INSERT INTO agent_receipts (
                id, request_id, kind, payload_body, prev_hash, receipt_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            requestId,
            kind,
            this.encodeSensitive(payloadBody, aad('agent_receipts', id, 'payload_body')),
            prevHash,
            receiptHash,
            createdAt,
        );
        return {
            id,
            requestId,
            kind,
            payload,
            prevHash,
            receiptHash,
            createdAt,
        };
    }

    private upsertMemoryValue(key: string, value: unknown, kind: AgentMemoryKind, ttlMs?: number): void {
        const trimmed = key.trim();
        if (!trimmed) throw new Error('memory key is required');
        const stamp = this.now();
        const valueJson = stableStringify(value);
        const expiresAt = ttlMs === undefined ? null : stamp + Math.floor(ttlMs);
        this.db.prepare(`
            INSERT INTO agent_memory (
                key, value_json, updated_at, kind, created_at, expires_at,
                last_accessed_at, access_count, value_sha256, size_bytes
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at,
                kind = excluded.kind,
                expires_at = excluded.expires_at,
                value_sha256 = excluded.value_sha256,
                size_bytes = excluded.size_bytes
        `).run(
            trimmed,
            this.encodeSensitive(valueJson, aad('agent_memory', trimmed, 'value_json')),
            stamp,
            kind,
            stamp,
            expiresAt,
            sha256(valueJson),
            Buffer.byteLength(valueJson),
        );
    }

    private getMemoryValue(key: string, kind: AgentMemoryKind): unknown {
        const row = this.db.prepare(`
            SELECT value_json, kind, expires_at
            FROM agent_memory
            WHERE key = ? AND kind = ?
        `).get(key, kind) as MemoryRow | undefined;
        if (!row) return null;
        if (row.expires_at !== null && row.expires_at <= this.now()) return null;

        this.db.prepare(`
            UPDATE agent_memory
            SET last_accessed_at = ?,
                access_count = COALESCE(access_count, 0) + 1
            WHERE key = ? AND kind = ?
        `).run(this.now(), key, kind);

        return JSON.parse(this.decodeSensitive(row.value_json, aad('agent_memory', key, 'value_json'))) as unknown;
    }

    private dispatchFromRow(row: DispatchRow): AgentDispatchRecord {
        const payloadJson = this.decodeSensitive(row.payload_json, aad('agent_dispatches', row.request_id, 'payload_json'));
        const replyContent = row.reply_content === null
            ? null
            : this.decodeSensitive(row.reply_content, aad('agent_dispatches', row.request_id, 'reply_content'));
        return {
            requestId: row.request_id,
            topicId: row.topic_id,
            agentId: row.agent_id,
            status: row.status,
            receivedAt: row.received_at,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            payload: JSON.parse(payloadJson) as AgentDispatchPayload,
            payloadHash: row.payload_sha256 ?? sha256(payloadJson),
            replyUrl: row.reply_url,
            replyContent,
            error: row.error === null ? null : this.decodeSensitive(row.error, aad('agent_dispatches', row.request_id, 'error')),
            duplicateCount: row.duplicate_count ?? 0,
            lastSeenAt: row.last_seen_at,
            runtimeAttempts: row.runtime_attempts ?? 0,
            lastRuntimeStartedAt: row.last_runtime_started_at,
            replayAfter: row.replay_after,
        };
    }

    private outboxFromRow(row: OutboxRow): AgentOutboxRecord {
        const payloadBody = this.decodeSensitive(row.payload_body, aad('agent_outbox', row.dedupe_key, 'payload_body'));
        return {
            id: row.id,
            requestId: row.request_id,
            kind: row.kind,
            dedupeKey: row.dedupe_key,
            targetUrl: row.target_url,
            payload: JSON.parse(payloadBody) as Record<string, unknown>,
            payloadHash: row.payload_sha256,
            status: row.status,
            attempts: row.attempts,
            nextAttemptAt: row.next_attempt_at,
            lastError: row.last_error,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            sentAt: row.sent_at,
        };
    }

    private receiptFromRow(row: ReceiptRow): AgentReceiptRecord {
        const payloadBody = this.decodeSensitive(row.payload_body, aad('agent_receipts', row.id, 'payload_body'));
        return {
            id: row.id,
            requestId: row.request_id,
            kind: row.kind,
            payload: JSON.parse(payloadBody) as Record<string, unknown>,
            prevHash: row.prev_hash,
            receiptHash: row.receipt_hash,
            createdAt: row.created_at,
        };
    }

    private encodeSensitive(value: string, authenticatedData: string): string {
        if (!this.encryptionKey) return value;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
        cipher.setAAD(Buffer.from(authenticatedData, 'utf8'));
        const ciphertext = Buffer.concat([
            cipher.update(Buffer.from(value, 'utf8')),
            cipher.final(),
        ]);
        return JSON.stringify({
            [ENCRYPTED_VALUE_MARKER]: true,
            v: ENCRYPTED_VALUE_VERSION,
            alg: ENCRYPTION_ALG,
            iv: iv.toString('base64url'),
            ciphertext: ciphertext.toString('base64url'),
            tag: cipher.getAuthTag().toString('base64url'),
        });
    }

    private decodeSensitive(value: string, authenticatedData: string): string {
        const envelope = parseEncryptedEnvelope(value);
        if (!envelope) return value;
        if (!this.encryptionKey) {
            throw new Error(`encrypted agent hub value requires ${AGENT_HUB_SECRET_ENV}`);
        }
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            this.encryptionKey,
            Buffer.from(envelope.iv, 'base64url'),
        );
        decipher.setAAD(Buffer.from(authenticatedData, 'utf8'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
        return Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
            decipher.final(),
        ]).toString('utf8');
    }

    private withTransaction<T>(fn: () => T): T {
        this.db.exec('BEGIN');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    private count(table: 'agent_dispatches' | 'agent_memory' | 'agent_outbox' | 'agent_receipts'): number {
        const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow;
        return row.count;
    }

    private countMemoryKind(kind: AgentMemoryKind): number {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM agent_memory WHERE kind = ?')
            .get(kind) as unknown as CountRow;
        return row.count;
    }

    private countDispatchStatus(status: AgentDispatchStatus): number {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM agent_dispatches WHERE status = ?')
            .get(status) as unknown as CountRow;
        return row.count;
    }
}

function readHubSecret(explicit: string | undefined, required: boolean): string | null {
    const value = explicit ?? process.env[AGENT_HUB_SECRET_ENV];
    const trimmed = value?.trim();
    if (required && !isValidAgentHubSecret(trimmed)) {
        throw new Error(`${AGENT_HUB_SECRET_ENV} must be at least 32 characters when ${AGENT_HUB_ENCRYPTION_ENV}=required`);
    }
    return trimmed ? trimmed : null;
}

function persistableDispatchPayload(payload: AgentDispatchPayload): AgentDispatchPayload {
    const copy: AgentDispatchPayload = { ...payload };
    delete copy.replyProofSecret;
    return copy;
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} is required`);
    }
    return value.trim();
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function aad(table: string, id: string, column: string): string {
    return `${ENCRYPTION_AAD_VERSION}\n${table}\n${id}\n${column}`;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return out;
}

function safeJsonObject(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function parseEncryptedEnvelope(value: string): {
    iv: string;
    ciphertext: string;
    tag: string;
} | null {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (
            parsed?.[ENCRYPTED_VALUE_MARKER] === true &&
            parsed.v === ENCRYPTED_VALUE_VERSION &&
            parsed.alg === ENCRYPTION_ALG &&
            typeof parsed.iv === 'string' &&
            typeof parsed.ciphertext === 'string' &&
            typeof parsed.tag === 'string'
        ) {
            return {
                iv: parsed.iv,
                ciphertext: parsed.ciphertext,
                tag: parsed.tag,
            };
        }
    } catch {
        return null;
    }
    return null;
}
