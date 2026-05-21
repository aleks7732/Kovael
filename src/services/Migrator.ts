import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
    version: number;
    name: string;
    up: (db: DatabaseSync) => void;
}

const SCHEMA_TABLE = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
    ) STRICT
`;

export class Migrator {
    constructor(private db: DatabaseSync) {}

    public apply(migrations: Migration[]): { applied: number[]; skipped: number[] } {
        this.db.exec(SCHEMA_TABLE);

        const appliedRow = this.db
            .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
            .all() as Array<{ version: number }>;
        const known = new Set(appliedRow.map((r) => r.version));

        const sorted = [...migrations].sort((a, b) => a.version - b.version);

        // Detect non-monotonic versions inside a single batch — a duplicate version
        // would silently shadow the prior migration without an explicit error.
        const seen = new Set<number>();
        for (const m of sorted) {
            if (seen.has(m.version)) {
                throw new Error(`Migrator: duplicate migration version ${m.version}`);
            }
            seen.add(m.version);
        }

        const applied: number[] = [];
        const skipped: number[] = [];
        const insertStmt = this.db.prepare(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
        );

        for (const m of sorted) {
            if (known.has(m.version)) {
                skipped.push(m.version);
                continue;
            }
            this.db.exec('BEGIN');
            try {
                m.up(this.db);
                insertStmt.run(m.version, m.name, Date.now());
                this.db.exec('COMMIT');
                applied.push(m.version);
            } catch (err) {
                this.db.exec('ROLLBACK');
                throw new Error(
                    `Migrator: migration ${m.version} "${m.name}" failed: ${(err as Error).message}`,
                );
            }
        }

        return { applied, skipped };
    }

    public currentVersion(): number {
        try {
            const row = this.db
                .prepare('SELECT MAX(version) as v FROM schema_migrations')
                .get() as { v: number | null } | undefined;
            return row?.v ?? 0;
        } catch {
            return 0;
        }
    }
}

export const ORCHESTRATOR_MIGRATIONS: Migration[] = [
    {
        version: 1,
        name: 'conversation_bus_initial',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS conversation_topics (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    participants TEXT,
                    active INTEGER
                ) STRICT
            `);
            db.exec(`
                CREATE TABLE IF NOT EXISTS conversation_messages (
                    id TEXT PRIMARY KEY,
                    topic_id TEXT,
                    sender_id TEXT,
                    role TEXT,
                    content TEXT,
                    timestamp INTEGER,
                    FOREIGN KEY(topic_id) REFERENCES conversation_topics(id) ON DELETE CASCADE
                ) STRICT
            `);
            db.exec(`
                CREATE VIEW IF NOT EXISTS conversation_topics_seq AS
                SELECT
                    t.id,
                    t.title,
                    t.participants,
                    t.active,
                    COUNT(m.id) as message_count,
                    MAX(m.timestamp) as last_activity
                FROM conversation_topics t
                LEFT JOIN conversation_messages m ON t.id = m.topic_id
                GROUP BY t.id
            `);
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_messages_topic_ts
                ON conversation_messages(topic_id, timestamp)
            `);
        },
    },
    {
        version: 2,
        name: 'chair_claims_initial',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS chair_claims (
                    agent_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    capabilities TEXT NOT NULL,
                    trust_tier INTEGER NOT NULL,
                    claimed_at INTEGER NOT NULL,
                    last_beacon_at INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    host TEXT,
                    note TEXT,
                    inbox_url TEXT
                ) STRICT
            `);
        },
    },
    {
        version: 3,
        name: 'cycle_events_log',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS cycle_events (
                    cycle_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    actor TEXT NOT NULL,
                    payload TEXT NOT NULL DEFAULT '{}',
                    PRIMARY KEY (cycle_id, seq)
                ) STRICT
            `);
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_cycle_events_kind
                ON cycle_events(kind)
            `);
        },
    },
    {
        version: 4,
        name: 'episodic_memory',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS episodic_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    cycle_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    task_class TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    timestamp INTEGER NOT NULL,
                    metadata TEXT NOT NULL DEFAULT '{}'
                ) STRICT
            `);
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_episodic_agent
                ON episodic_memories(agent_id, timestamp)
            `);
            db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS episodic_memories_fts
                USING fts5(summary, task_class, content=episodic_memories, content_rowid=id)
            `);
            // Triggers to keep FTS in sync with the content table.
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS episodic_ai AFTER INSERT ON episodic_memories BEGIN
                    INSERT INTO episodic_memories_fts(rowid, summary, task_class)
                    VALUES (new.id, new.summary, new.task_class);
                END
            `);
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS episodic_ad AFTER DELETE ON episodic_memories BEGIN
                    INSERT INTO episodic_memories_fts(episodic_memories_fts, rowid, summary, task_class)
                    VALUES ('delete', old.id, old.summary, old.task_class);
                END
            `);
        },
    },
];
