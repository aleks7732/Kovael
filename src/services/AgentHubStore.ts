import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type AgentDispatchStatus = 'accepted' | 'running' | 'succeeded' | 'failed';

export interface AgentHubStoreOptions {
    agentId: string;
    dbPath: string;
    now?: () => number;
}

export interface AgentDispatchPayload {
    requestId?: unknown;
    topicId?: unknown;
    agentId?: unknown;
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
    replyContent: string | null;
    error: string | null;
}

export interface AgentDispatchInsertResult {
    requestId: string;
    duplicate: boolean;
}

export interface AgentHubStats {
    dispatches: number;
    accepted: number;
    running: number;
    succeeded: number;
    failed: number;
    memories: number;
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
    reply_content: string | null;
    error: string | null;
}

const SCHEMA_VERSION = '1';

/**
 * AgentHubStore is a local, per-agent edge log. It is intentionally not a
 * global source of truth; the orchestrator owns chairs, topics, and routing.
 * A hub file can be deleted and rebuilt without corrupting Kovael state.
 */
export class AgentHubStore {
    private readonly db: DatabaseSync;
    private readonly now: () => number;
    public readonly agentId: string;
    public readonly dbPath: string;

    constructor(options: AgentHubStoreOptions) {
        const agentId = options.agentId.trim();
        if (!agentId) throw new Error('agentId is required');
        this.agentId = agentId;
        this.dbPath = options.dbPath;
        this.now = options.now ?? (() => Date.now());

        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
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

        const result = this.db.prepare(`
            INSERT OR IGNORE INTO agent_dispatches (
                request_id, topic_id, agent_id, status, received_at, payload_json
            ) VALUES (?, ?, ?, 'accepted', ?, ?)
        `).run(
            requestId,
            topicId,
            agentId,
            this.now(),
            JSON.stringify(payload),
        ) as { changes: number };

        return { requestId, duplicate: result.changes === 0 };
    }

    public markDispatchRunning(requestId: string): void {
        this.db.prepare(`
            UPDATE agent_dispatches
            SET status = 'running', started_at = COALESCE(started_at, ?), error = NULL
            WHERE request_id = ?
        `).run(this.now(), requestId);
    }

    public markDispatchSucceeded(requestId: string, replyContent: string): void {
        this.db.prepare(`
            UPDATE agent_dispatches
            SET status = 'succeeded', completed_at = ?, reply_content = ?, error = NULL
            WHERE request_id = ?
        `).run(this.now(), replyContent, requestId);
    }

    public markDispatchFailed(requestId: string, error: string): void {
        this.db.prepare(`
            UPDATE agent_dispatches
            SET status = 'failed', completed_at = ?, error = ?
            WHERE request_id = ?
        `).run(this.now(), error.slice(0, 4_000), requestId);
    }

    public getDispatch(requestId: string): AgentDispatchRecord | null {
        const row = this.db.prepare(`
            SELECT request_id, topic_id, agent_id, status, received_at, started_at,
                   completed_at, payload_json, reply_content, error
            FROM agent_dispatches
            WHERE request_id = ?
        `).get(requestId) as DispatchRow | undefined;
        return row ? dispatchFromRow(row) : null;
    }

    public upsertMemory(key: string, value: unknown): void {
        const trimmed = key.trim();
        if (!trimmed) throw new Error('memory key is required');
        this.db.prepare(`
            INSERT INTO agent_memory (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
        `).run(trimmed, JSON.stringify(value), this.now());
    }

    public getMemory(key: string): unknown {
        const row = this.db.prepare('SELECT value_json FROM agent_memory WHERE key = ?')
            .get(key) as { value_json: string } | undefined;
        if (!row) return null;
        return JSON.parse(row.value_json) as unknown;
    }

    public stats(): AgentHubStats {
        return {
            dispatches: this.count('agent_dispatches'),
            accepted: this.countDispatchStatus('accepted'),
            running: this.countDispatchStatus('running'),
            succeeded: this.countDispatchStatus('succeeded'),
            failed: this.countDispatchStatus('failed'),
            memories: this.count('agent_memory'),
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

            CREATE TABLE IF NOT EXISTS agent_dispatches (
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

            CREATE INDEX IF NOT EXISTS idx_agent_dispatches_status
                ON agent_dispatches(status, received_at);

            CREATE TABLE IF NOT EXISTS agent_memory (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
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

    private count(table: 'agent_dispatches' | 'agent_memory'): number {
        const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow;
        return row.count;
    }

    private countDispatchStatus(status: AgentDispatchStatus): number {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM agent_dispatches WHERE status = ?')
            .get(status) as unknown as CountRow;
        return row.count;
    }
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} is required`);
    }
    return value.trim();
}

function dispatchFromRow(row: DispatchRow): AgentDispatchRecord {
    return {
        requestId: row.request_id,
        topicId: row.topic_id,
        agentId: row.agent_id,
        status: row.status,
        receivedAt: row.received_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        payload: JSON.parse(row.payload_json) as AgentDispatchPayload,
        replyContent: row.reply_content,
        error: row.error,
    };
}
