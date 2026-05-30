import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = '2';

/**
 * Migration context supplied by AgentHubStore. The store retains ownership of
 * the encryption key (init ordering, `this` state) and the JSON/hash helpers;
 * this module only owns the SQL shape and migration ordering. Keeping these as
 * callbacks preserves the exact key-init ordering and the re-encrypting
 * backfill behaviour of the original in-class `migrate()`.
 */
export interface MigrationContext {
    now: () => number;
    agentId: string;
    /**
     * Initialize (and assign) the hub encryption key. Called after the meta
     * table exists — exactly where the original `migrate()` invoked
     * `this.initializeEncryptionKey()` — so salt creation/lookup is unchanged.
     */
    initializeKey: () => void;
    encode: (value: string, aad: string) => string;
    decode: (value: string, aad: string) => string;
    aad: (table: string, id: string, column: string) => string;
    sha256: (value: string) => string;
    stableStringify: (value: unknown) => string;
    safeJsonObject: (raw: string) => Record<string, unknown>;
    stringOrNull: (value: unknown) => string | null;
}

export function columnExists(db: DatabaseSync, table: string, name: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === name);
}

export function ensureColumn(db: DatabaseSync, table: string, name: string, definition: string): void {
    if (!columnExists(db, table, name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}

function metaValue(db: DatabaseSync, key: string): string | null {
    const row = db.prepare('SELECT value FROM agent_hub_meta WHERE key = ?')
        .get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

export function runMigrations(db: DatabaseSync, ctx: MigrationContext): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_hub_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
    // Captured before the schema_version stamp below so we can skip the
    // one-time v2 backfill scan on hubs that are already current.
    const priorSchemaVersion = metaValue(db, 'schema_version');
    ctx.initializeKey();

    db.exec(`
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

    ensureColumn(db, 'agent_dispatches', 'payload_sha256', 'TEXT');
    ensureColumn(db, 'agent_dispatches', 'reply_url', 'TEXT');
    ensureColumn(db, 'agent_dispatches', 'duplicate_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'agent_dispatches', 'last_seen_at', 'INTEGER');
    ensureColumn(db, 'agent_dispatches', 'runtime_attempts', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'agent_dispatches', 'last_runtime_started_at', 'INTEGER');
    ensureColumn(db, 'agent_dispatches', 'replay_after', 'INTEGER');
    ensureColumn(db, 'agent_memory', 'kind', "TEXT NOT NULL DEFAULT 'memory'");
    ensureColumn(db, 'agent_memory', 'created_at', 'INTEGER');
    ensureColumn(db, 'agent_memory', 'expires_at', 'INTEGER');
    ensureColumn(db, 'agent_memory', 'last_accessed_at', 'INTEGER');
    ensureColumn(db, 'agent_memory', 'access_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'agent_memory', 'value_sha256', 'TEXT');
    ensureColumn(db, 'agent_memory', 'size_bytes', 'INTEGER');
    // The backfill is an O(N) full-table scan; only needed when migrating an
    // older/unstamped hub up to the current schema. Skip it once current to
    // avoid re-scanning every dispatch + memory row on every boot.
    if (priorSchemaVersion !== SCHEMA_VERSION) {
        backfillV2Columns(db, ctx);
    }

    db.exec(`
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

    const stamp = ctx.now();
    const meta = db.prepare(`
        INSERT INTO agent_hub_meta (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `);
    meta.run('schema_version', SCHEMA_VERSION, stamp);
    meta.run('agent_id', ctx.agentId, stamp);
}

function backfillV2Columns(db: DatabaseSync, ctx: MigrationContext): void {
    const dispatchRows = db.prepare(`
        SELECT request_id, payload_json, payload_sha256, reply_url, last_seen_at
        FROM agent_dispatches
    `).all() as Array<{
        request_id: string;
        payload_json: string;
        payload_sha256: string | null;
        reply_url: string | null;
        last_seen_at: number | null;
    }>;
    const updateDispatch = db.prepare(`
        UPDATE agent_dispatches
        SET payload_sha256 = COALESCE(payload_sha256, ?),
            reply_url = COALESCE(reply_url, ?),
            duplicate_count = COALESCE(duplicate_count, 0),
            last_seen_at = COALESCE(last_seen_at, received_at),
            runtime_attempts = COALESCE(runtime_attempts, 0)
        WHERE request_id = ?
    `);
    for (const row of dispatchRows) {
        const payloadJson = ctx.decode(row.payload_json, ctx.aad('agent_dispatches', row.request_id, 'payload_json'));
        const payload = ctx.safeJsonObject(payloadJson);
        updateDispatch.run(
            row.payload_sha256 ?? ctx.sha256(ctx.stableStringify(payload)),
            row.reply_url ?? ctx.stringOrNull(payload.replyUrl),
            row.request_id,
        );
    }

    const memoryRows = db.prepare(`
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
    const updateMemory = db.prepare(`
        UPDATE agent_memory
        SET kind = COALESCE(kind, 'memory'),
            created_at = COALESCE(created_at, ?),
            access_count = COALESCE(access_count, 0),
            value_sha256 = COALESCE(value_sha256, ?),
            size_bytes = COALESCE(size_bytes, ?)
        WHERE key = ?
    `);
    for (const row of memoryRows) {
        const valueJson = ctx.decode(row.value_json, ctx.aad('agent_memory', row.key, 'value_json'));
        updateMemory.run(
            row.created_at ?? row.updated_at,
            row.value_sha256 ?? ctx.sha256(valueJson),
            row.size_bytes ?? Buffer.byteLength(valueJson),
            row.key,
        );
    }
}
