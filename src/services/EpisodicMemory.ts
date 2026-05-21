import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';

/**
 * EpisodicMemory — cross-cycle knowledge store with full-text search.
 *
 * Each completed cycle's receipt, key events, and outcome are indexed
 * into an FTS5 table. Personas can opt into "recall last N relevant
 * cycles" in their YAML front-matter, enabling cross-cycle learning
 * without a vector DB dependency.
 *
 * Storage:
 * - `episodic_memories` — source table with structured columns.
 * - `episodic_memories_fts` — FTS5 content-sync index on the text body.
 *
 * Query patterns:
 * - `recall(query, limit)` — free-text search across all memories.
 * - `recallForAgent(agentId, query, limit)` — scoped to a single agent.
 * - `memorize(...)` — insert a new memory from a cycle event/receipt.
 */

export interface EpisodicEntry {
    id: number;
    cycleId: string;
    agentId: string;
    taskClass: string;
    summary: string;
    outcome: 'success' | 'failure' | 'partial';
    confidence: number;
    timestamp: number;
    metadata: Record<string, unknown>;
}

export interface RecallResult {
    entry: EpisodicEntry;
    rank: number;
}

export class EpisodicMemory extends EventEmitter {
    constructor(private db: DatabaseSync) {
        super();
    }

    /**
     * Store a memory from a completed cycle.
     */
    public memorize(input: {
        cycleId: string;
        agentId: string;
        taskClass: string;
        summary: string;
        outcome: 'success' | 'failure' | 'partial';
        confidence: number;
        metadata?: Record<string, unknown>;
    }): EpisodicEntry {
        const timestamp = Date.now();
        const meta = JSON.stringify(input.metadata ?? {});

        const stmt = this.db.prepare(`
            INSERT INTO episodic_memories
                (cycle_id, agent_id, task_class, summary, outcome, confidence, timestamp, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            input.cycleId,
            input.agentId,
            input.taskClass,
            input.summary,
            input.outcome,
            input.confidence,
            timestamp,
            meta,
        );

        const row = this.db.prepare(
            'SELECT last_insert_rowid() AS id'
        ).get() as { id: number };

        const entry: EpisodicEntry = {
            id: row.id,
            cycleId: input.cycleId,
            agentId: input.agentId,
            taskClass: input.taskClass,
            summary: input.summary,
            outcome: input.outcome,
            confidence: input.confidence,
            timestamp,
            metadata: input.metadata ?? {},
        };

        this.emit('memorized', entry);
        return entry;
    }

    /**
     * Free-text search across all episodic memories.
     * Uses FTS5 MATCH for ranked retrieval.
     */
    public recall(query: string, limit = 5): RecallResult[] {
        const rows = this.db.prepare(`
            SELECT
                m.id, m.cycle_id, m.agent_id, m.task_class, m.summary,
                m.outcome, m.confidence, m.timestamp, m.metadata,
                rank
            FROM episodic_memories_fts fts
            JOIN episodic_memories m ON m.id = fts.rowid
            WHERE episodic_memories_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        `).all(query, limit) as Array<{
            id: number; cycle_id: string; agent_id: string; task_class: string;
            summary: string; outcome: string; confidence: number;
            timestamp: number; metadata: string; rank: number;
        }>;

        return rows.map((r) => ({
            entry: {
                id: r.id,
                cycleId: r.cycle_id,
                agentId: r.agent_id,
                taskClass: r.task_class,
                summary: r.summary,
                outcome: r.outcome as 'success' | 'failure' | 'partial',
                confidence: r.confidence,
                timestamp: r.timestamp,
                metadata: JSON.parse(r.metadata),
            },
            rank: r.rank,
        }));
    }

    /**
     * Scoped recall — only memories involving a specific agent.
     */
    public recallForAgent(agentId: string, query: string, limit = 5): RecallResult[] {
        const rows = this.db.prepare(`
            SELECT
                m.id, m.cycle_id, m.agent_id, m.task_class, m.summary,
                m.outcome, m.confidence, m.timestamp, m.metadata,
                rank
            FROM episodic_memories_fts fts
            JOIN episodic_memories m ON m.id = fts.rowid
            WHERE episodic_memories_fts MATCH ?
              AND m.agent_id = ?
            ORDER BY rank
            LIMIT ?
        `).all(query, agentId, limit) as Array<{
            id: number; cycle_id: string; agent_id: string; task_class: string;
            summary: string; outcome: string; confidence: number;
            timestamp: number; metadata: string; rank: number;
        }>;

        return rows.map((r) => ({
            entry: {
                id: r.id,
                cycleId: r.cycle_id,
                agentId: r.agent_id,
                taskClass: r.task_class,
                summary: r.summary,
                outcome: r.outcome as 'success' | 'failure' | 'partial',
                confidence: r.confidence,
                timestamp: r.timestamp,
                metadata: JSON.parse(r.metadata),
            },
            rank: r.rank,
        }));
    }

    /**
     * Retrieve the N most recent memories for an agent, chronologically.
     */
    public recentForAgent(agentId: string, limit = 10): EpisodicEntry[] {
        const rows = this.db.prepare(`
            SELECT id, cycle_id, agent_id, task_class, summary,
                   outcome, confidence, timestamp, metadata
            FROM episodic_memories
            WHERE agent_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(agentId, limit) as Array<{
            id: number; cycle_id: string; agent_id: string; task_class: string;
            summary: string; outcome: string; confidence: number;
            timestamp: number; metadata: string;
        }>;

        return rows.map((r) => ({
            id: r.id,
            cycleId: r.cycle_id,
            agentId: r.agent_id,
            taskClass: r.task_class,
            summary: r.summary,
            outcome: r.outcome as 'success' | 'failure' | 'partial',
            confidence: r.confidence,
            timestamp: r.timestamp,
            metadata: JSON.parse(r.metadata),
        }));
    }

    /**
     * Total number of stored memories.
     */
    public totalMemories(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM episodic_memories').get() as { cnt: number };
        return row.cnt;
    }
}
